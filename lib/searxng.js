// Local SearXNG integration.
//
// A self-hosted SearXNG instance (default http://localhost:8080) is a
// metasearch engine with a plain HTTP API. Three capabilities map neatly onto
// this plugin:
//
//   1. Query feeds   — SearXNG can output *RSS* for any query
//                      (/search?q=...&format=rss), which the existing feed
//                      parser already understands. So "subscribe to a topic,
//                      not a site" needs no new fetch/parsing code at all.
//                      (RSS format is enabled in SearXNG's default settings.)
//   2. Web search    — the JSON API (/search?q=...&format=json) powers a
//                      keyword-light "live web fallback" for cache misses and
//                      the backfill-from-web action. NOTE: `json` is NOT in
//                      SearXNG's default `formats`; the user must add it to
//                      settings.yml (search.formats: [html, rss, json]).
//   3. Frontpage/full text — backfill scrapes the top result pages through the
//                      shared limiter + robots.txt + ban policy (fetcher.js).
//
// This module deliberately wraps everything so callers never build URLs by
// hand and never hit the network when a previous identical call is cached.

// Synthetic feed URL under which web-sourced (backfilled) entries are filed.
// Stable and substring-filterable ("feed: searxng.local" narrows to them).
export const WEB_FEED_URL = "https://searxng.local/web-search";

export const WEB_SOURCE_TAG = "web";

export function searxngEnabled(settings) {
  return !!String(settings?.searxngBaseUrl || "").trim();
}

function baseOf(settings) {
  return String(settings.searxngBaseUrl || "").trim().replace(/\/+$/, "");
}

// Builds the RSS representation of a SearXNG query — this URL is added to
// feeds.txt just like any other feed.
export function buildQueryFeedUrl(baseUrl, query, opts = {}) {
  const u = new URL("/search", String(baseUrl).trim());
  u.searchParams.set("q", String(query || "").trim());
  u.searchParams.set("format", "rss");
  if (opts.categories) u.searchParams.set("categories", String(opts.categories));
  if (opts.language) u.searchParams.set("language", String(opts.language));
  if (opts.timeRange) u.searchParams.set("time_range", String(opts.timeRange));
  return u.href;
}

// Recognises a SearXNG query feed URL (used by `list`, `remove` and the
// refresh pipeline). Requires a q parameter and the RSS format we add.
export function isQueryFeedUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url));
    return /^\/search$/.test(u.pathname) && u.searchParams.get("format") === "rss" && !!u.searchParams.get("q");
  } catch {
    return false;
  }
}

export function queryFromFeedUrl(url) {
  try {
    const u = new URL(String(url));
    return u.searchParams.get("q") || "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Small result cache: chat sessions often re-run the same search within a few
// seconds; a 60 s TTL keeps repeats off the local server without being stale.
// ---------------------------------------------------------------------------
const RESULT_CACHE_MAX = 50;
const RESULT_TTL_MS = 60 * 1000;
const resultCache = new Map(); // url -> { at, value }

function cacheGet(url) {
  const hit = resultCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > RESULT_TTL_MS) {
    resultCache.delete(url);
    return null;
  }
  return hit.value;
}

function cacheSet(url, value) {
  if (resultCache.size >= RESULT_CACHE_MAX) resultCache.delete(resultCache.keys().next().value);
  resultCache.set(url, { at: Date.now(), value });
}

export function clearSearxCache() {
  resultCache.clear();
}

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`SearXNG HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Runs one SearXNG search via the JSON API. Throws a helpful error when the
// server responds (typically 403) because json is not in its allowed formats.
export async function searxSearch(settings, query, opts = {}) {
  const base = baseOf(settings);
  if (!base) throw new Error("searxngBaseUrl is not configured");
  const q = String(query || "").trim();
  if (!q) throw new Error("Empty query");

  const u = new URL("/search", base);
  u.searchParams.set("q", q);
  u.searchParams.set("format", "json");
  if (opts.categories) u.searchParams.set("categories", String(opts.categories));
  if (opts.language) u.searchParams.set("language", String(opts.language));
  if (opts.timeRange) u.searchParams.set("time_range", String(opts.timeRange));

  const key = u.href;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  let payload;
  try {
    payload = await fetchJson(key, opts.timeoutMs || 15000);
  } catch (e) {
    let msg = e.message;
    if (e.status === 403) {
      msg =
        "SearXNG refused the JSON format (HTTP 403). Enable it by adding \"json\" " +
        "to the search.formats list in SearXNG's settings.yml, then restart SearXNG.";
    } else if (e.name === "AbortError") {
      msg = `SearXNG timed out after ${opts.timeoutMs || 15000}ms (is it running at ${base}?)`;
    } else {
      msg = `SearXNG unreachable at ${base}: ${msg}`;
    }
    const err = new Error(msg);
    err.searx = true;
    throw err;
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  const norm = results.map((r) => ({
    title: String(r.title || "").trim(),
    url: String(r.url || (r.links && r.links[0]) || "").trim(),
    content: String(r.content || "").trim(),
    published: r.publishedDate || null,
    engines: Array.isArray(r.engines) ? r.engines : [],
  }));
  const validated = norm.filter((r) => r.url);
  cacheSet(key, validated);
  return validated;
}

// Token-cheap view for the live web fallback: title + url + short snippet only,
// so a search with zero cache hits can still answer honestly from the open web.
/**
 * @param {any} settings normalized plugin settings
 * @param {string} query
 * @param {{ limit?: number, categories?: string }} [opts]
 * @returns {Promise<Array<{ title: string, url: string, snippet: string }>>}
 */
export async function webSearchDigest(settings, query, { limit = 5, categories } = {}) {
  const found = await searxSearch(settings, query, { categories, limit: limit * 2 });
  const seen = new Set();
  const out = [];
  for (const r of found) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({
      title: r.title || r.url,
      url: r.url,
      snippet: (r.content || "").slice(0, 280),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// S2 — feed discovery: find real, addable feeds for a topic or a given page.
// Candidate homepages come from a SearXNG query; the actual feed URLs are
// discovered with the plugin's existing <link rel="alternate"> logic
// (fetcher.discoverFeed) so detection quality and ban/UA policy stay in sync.
// Each call is routed through the shared per-host limiter.
// ---------------------------------------------------------------------------

const MAX_DISCOVERY_CANDIDATES = 8;

/**
 * @param {any} settings normalized plugin settings (must include searxngBaseUrl)
 * @param {{ topic?: string, url?: string }} [opts]
 * @returns {Promise<{ from: any, candidates: any[], hint: string }>}
 */
export async function discoverFeedsFor(settings, { topic, url } = {}) {
  const base = baseOf(settings);
  if (!base) throw new Error("searxngBaseUrl is not configured");

  const { discoverFeed, getSharedLimiter } = await import("./fetcher.js");
  const limiter = getSharedLimiter(settings);

  // Candidate pool: page URLs that are likely to host (or link) a feed.
  const pool = [];
  if (url) {
    pool.push(String(url));
  } else {
    const results = await searxSearch(settings, `${topic} rss feed`, { limit: 15 });
    const origins = new Set();
    for (const r of results) {
      try {
        const u = new URL(r.url);
        // Result links are usually deep article URLs; the feed lives on the
        // site itself. Neither prefix-stripping nor origin alone is right every
        // time, so offer both — candidates are merely suggestions.
        origins.add(u.origin);
        origins.add(u.origin + u.pathname.replace(/\/[^/]*$/, "/"));
      } catch {
        /* skip malformed result URLs */
      }
    }
    pool.push(...origins);
  }

  const seenHosts = new Set();
  const candidates = [];
  for (const cand of pool.slice(0, MAX_DISCOVERY_CANDIDATES * 2)) {
    let site;
    try {
      site = new URL(cand).origin;
    } catch {
      continue;
    }
    if (seenHosts.has(site)) continue; // one candidate per origin keeps the batch small
    seenHosts.add(site);
    if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;

    try {
      const found = await limiter.run(site, () => discoverFeed(cand, { timeoutMs: 10000 }));
      if (!found?.found || !found.feedUrl) continue;

      // Score the candidate by how many items its feed really exposes.
      const { fetchFeed } = await import("./fetcher.js");
      let items = null;
      let sample = [];
      try {
        const r = await limiter.run(new URL(found.feedUrl).origin, () =>
          fetchFeed(found.feedUrl, { timeoutMs: 15000 }),
        );
        items = r.items?.length ?? 0;
        sample = (r.items || []).slice(0, 3).map((i) => i.title);
      } catch {
        /* feed URL discovered but unreadable; report it with items=null */
      }
      candidates.push({
        site,
        seedUrl: cand,
        feedUrl: found.feedUrl,
        type: found.type,
        items,
        sample,
      });
    } catch (e) {
      candidates.push({ site, seedUrl: cand, error: String(e?.message || e) });
    }
  }

  return {
    from: url ? { url } : { topic },
    candidates,
    hint: candidates.some((c) => c.feedUrl)
      ? "Review the candidates, then add one with manage_rss_feeds action:'add' and its feedUrl."
      : "No feeds discovered. Try a more specific topic or add the URL manually.",
  };
}

// ---------------------------------------------------------------------------
// S3 — backfill from web: run the query through SearXNG, fetch readable text
// for the top result pages (robots.txt + per-host pacing + ban policy), and
// index them as short-retention "web" entries flagged source_type='web'.
// guid is the canonical URL prefixed with "web:" so:
//   - re-running the same query re-encounters the same guid (no duplicate rows);
//   - the UUID can't collide with real feed guids;
//   - marking source_type after a plain indexEntries insert is a single UPDATE
//     that never needs to touch chunks or vectors.
// ---------------------------------------------------------------------------

/**
 * @param {any} settings normalized plugin settings
 * @param {{ query: string, limit?: number, categories?: string }} [opts]
 * @returns {Promise<{ query: string, requested: number, foundInSearch: number, alreadyCached: number, candidatesTried: number, added: number, failed: any[] }>}
 */
export async function backfillFromWeb(settings, { query, limit = 5, categories } = {}) {
  const base = baseOf(settings);
  if (!base) throw new Error("searxngBaseUrl is not configured");

  const max = Math.max(1, Math.min(Number(limit) || 5, 25));

  const results = await searxSearch(settings, query, { categories, limit: max * 3 });

  const { getDb } = await import("./db.js");
  const { indexEntries } = await import("./retriever.js");
  const { fetchArticleContent, getSharedLimiter } = await import("./fetcher.js");

  const db = getDb();
  const knownGuid = db.prepare(`SELECT id FROM entries WHERE guid = ? LIMIT 1`);
  const knownLink = db.prepare(`SELECT id FROM entries WHERE link = ? LIMIT 1`);

  const limiter = getSharedLimiter(settings);
  let cachedCount = 0;
  const picked = [];
  const seenUrls = new Set();
  const seenHosts = new Map(); // host -> count so one site can't fill the batch
  for (const r of results) {
    if (!r.url || seenUrls.has(r.url)) continue;
    let host = null;
    try {
      host = new URL(r.url).origin;
    } catch {
      continue;
    }
    if ((seenHosts.get(host) || 0) >= 3) continue;
    seenUrls.add(r.url);
    seenHosts.set(host, (seenHosts.get(host) || 0) + 1);
    if (knownGuid.get(`web:${r.url}`) || knownLink.get(r.url)) {
      cachedCount++; // already in the cache — skip silently but report
      continue;
    }
    picked.push(r);
    if (picked.length >= max) break;
  }

  const indexed = [];
  const failed = [];
  // Fetch readable text first (sequential is fine: the shared limiter paces
  // per host and these are typically different domains).
  for (const r of picked) {
    try {
      const body = await limiter.run(new URL(r.url).origin, () =>
        fetchArticleContent(r.url, { settings, timeoutMs: 25000 }),
      );
      if (!body || body.length < 200) {
        failed.push({ url: r.url, error: "extracted text too short" });
        continue;
      }
      indexed.push({
        guid: `web:${r.url}`,
        feed_url: WEB_FEED_URL,
        title: r.title || r.url,
        link: r.url,
        author: null,
        pub_date: r.published ? Date.parse(r.published) || Date.now() : Date.now(),
        summary: (r.content || "").slice(0, 500),
        content: body,
        tags: [WEB_SOURCE_TAG, ...(categories ? [String(categories)] : [])],
        collection: null,
      });
    } catch (e) {
      failed.push({ url: r.url, error: String(e?.message || e) });
    }
  }

  let added = 0;
  if (indexed.length) {
    const res = await indexEntries(indexed, settings);
    added = res.added;
    // Tag everything from this prefix as web-source. Content is unchanged, so
    // no chunk/vector invalidation is required.
    const mark = db.prepare(`
      UPDATE entries SET source_type = 'web'
      WHERE source_type IS NULL AND guid LIKE 'web:%'
    `);
    try { mark.run(); } catch { /* older schema; retention still works via tag */ }
  }

  return {
    query,
    requested: max,
    foundInSearch: results.length,
    alreadyCached: cachedCount,
    candidatesTried: picked.length,
    added,
    failed,
  };
}
