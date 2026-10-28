import { parseRss, parseHtml, extractReadable } from "./parser.js";
import { log } from "./log.js";
import { detectBan, detectInterstitial, describeBan } from "./bans.js";
import { createHostLimiter, hostOf } from "./rateLimiter.js";
import { createRobotsCache } from "./robots.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Per-host ban backoff: 30 min, doubling, capped at 12 h. Deliberately longer
// than the per-feed failure backoff — a block is a stronger signal than a
// transient 5xx.
export const HOST_BAN_BACKOFF_BASE_MS = 30 * 60 * 1000;
export const HOST_BAN_BACKOFF_MAX_MS = 12 * 3600 * 1000;

function parseRetryAfter(v) {
  if (!v) return null;
  const trimmed = v.trim();
  const n = parseInt(trimmed, 10);
  if (!Number.isNaN(n) && String(n) === trimmed) return n * 1000;
  const d = Date.parse(trimmed);
  if (!Number.isNaN(d)) return Math.max(0, Math.min(d - Date.now(), 60000));
  return null;
}

// The User-Agent is a normal browser string; if the user supplies contact
// details we append them as a comment token so site owners can reach out
// instead of reaching for a block rule.
export function buildUserAgent(settings = {}) {
  const contact = String(settings?.contactUserAgent || "").trim();
  return contact ? `${UA} (${contact})` : UA;
}

const plainHeaders = (ua) => ({
  "User-Agent": ua,
  "Accept": "text/plain,text/html;q=0.9,*/*;q=0.5",
  "Accept-Language": "en-GB,en;q=0.9",
});

const feedHeaders = (ua) => ({
  "User-Agent": ua,
  "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
});

const htmlHeaders = (ua) => ({
  "User-Agent": ua,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
});

// Static defaults, kept for callers that have no settings object yet.
const FEED_HEADERS = feedHeaders(UA);

// fetch with retry/backoff.
//
// Retry policy (anti-ban):
//   - 429 → always retryable, honours Retry-After.
//   - 5xx → retryable (transient server problems).
//   - 403 → TERMINAL by default. Repeatedly re-requesting a hard block is
//           exactly what escalates a soft challenge into a permanent ban. The
//           one exception is a 403 that carries a Retry-After header, which is
//           an explicit "come back later" and is retried once.
// Detected bot walls are always logged, and reported through `onBan` so the
// caller can back the whole host off.
async function fetchWithRetry(url, init, { timeoutMs, retries = 2, onBan } = {}) {
  const host = hostOf(url);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal, redirect: "follow" });
    } catch (e) {
      lastErr = e;
      clearTimeout(t);
      if (attempt < retries) await sleep(600 * (attempt + 1));
      continue;
    }
    clearTimeout(t);

    const status = res.status;
    // 304 is a success for a conditional request; hand it back to the caller.
    if (status === 304) return res;
    if (res.ok) return res;

    // Non-2xx: read a bounded body so bot-wall interstitials can be identified
    // (Cloudflare / Akamai / Incapsula all serve recognisable HTML). The
    // response is either retried or discarded afterwards, so consuming it is
    // safe.
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }

    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    const ban = detectBan({ status, headers: res.headers, body });
    // A hard 403 is never retried; only an explicit Retry-After makes it soft.
    const soft403 = status === 403 && retryAfter !== null;
    const willRetry = attempt < retries && (status === 429 || (status >= 500 && status < 600) || soft403);

    if (ban) {
      log.warn(`[anti-ban] ${host || url}: ${describeBan(ban)}${willRetry ? " (retrying)" : " (giving up)"}`);
      if (onBan) {
        try {
          onBan({ ...ban, host, url, terminal: !willRetry });
        } catch {
          /* a reporting hook must never break a fetch */
        }
      }
    }

    if (willRetry) {
      const wait = Math.min(retryAfter ?? 800 * (attempt + 1), 15000);
      await sleep(wait);
      continue;
    }

    const err = new Error(`HTTP ${status} ${res.statusText}`);
    err.status = status; // preserved for per-feed health/backoff bookkeeping
    if (ban) err.ban = ban;
    throw err;
  }
  throw lastErr ?? new Error("HTTP request failed after retries");
}

export function detectFeedType(text) {
  const lower = (text || "").slice(0, 4000).toLowerCase();
  if (lower.includes("<rss") || lower.includes("<rdf:rdf")) return "rss";
  if (lower.includes("<feed")) return "atom";
  if (lower.includes("<!doctype") || lower.includes("<html")) return "html";
  return "unknown";
}

// Fetches and parses one feed (or HTML page). `opts.onBan` receives every
// detected bot wall; `opts.ua` overrides the User-Agent.
export async function fetchFeed(url, { timeoutMs = 20000, patterns = [], validators, headers, ua = UA, onBan } = {}) {
  const merged = { ...feedHeaders(ua), ...(validators || {}), ...(headers || {}) };
  const res = await fetchWithRetry(url, { headers: merged }, { timeoutMs, retries: 2, onBan });

  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");

  if (res.status === 304) {
    return { items: [], notModified: true, etag, lastModified };
  }

  const text = await res.text();
  if (!text || text.length < 50) throw new Error("Empty or invalid response");

  // A 200 that is actually a bot wall (JS challenge served with HTTP 200).
  const interstitial = detectInterstitial(text);
  if (interstitial) {
    const err = new Error(`Bot wall: ${describeBan(interstitial)}`);
    err.status = res.status;
    err.ban = interstitial;
    log.warn(`${hostOf(url) || url}: ${describeBan(interstitial)} (HTTP 200 interstitial) — giving up`);
    if (onBan) onBan({ ...interstitial, url, host: hostOf(url), terminal: true });
    throw err;
  }

  // Smart detection: Check the actual text first
  const lowerText = text.trim().toLowerCase();
  if (lowerText.includes("<rss") || lowerText.includes("<feed") || lowerText.includes("<?xml")) {
    return { items: parseRss(text, url), notModified: false, etag, lastModified };
  }

  // If it doesn't look like RSS, try scraping it as HTML
  if (lowerText.startsWith("<!doctype") || lowerText.startsWith("<html") || res.headers.get("content-type")?.includes("text/html")) {
    log.info(`No RSS found at ${url}. Scraping HTML for links...`);
    const scrapedItems = parseHtml(text, url, patterns);
    if (scrapedItems.length === 0) throw new Error("No articles found on HTML page");
    return { items: scrapedItems, notModified: false, etag, lastModified };
  }

  // Fallback
  return { items: parseRss(text, url), notModified: false, etag, lastModified };
}

const looksLikeRss = (url) => {
  const lower = url.toLowerCase();
  return lower.endsWith('.xml') || lower.endsWith('.rss') || lower.endsWith('.atom') ||
         lower.includes('/rss') || lower.includes('/feed') || lower.includes('feedburner') || lower.includes('/feeds/') ||
         // SearXNG query feeds (/search?q=...&format=rss) publish RSS for
         // machines; they must take the "fast" parsers path, not be scraped
         // as HTML for article links.
         (lower.includes('/search?') && lower.includes('format=rss'));
};

// ---------------------------------------------------------------------------
// Shared HTTP policy: one limiter and one robots cache for the whole process so
// pacing carries across refresh passes (RSS -> HTML -> full-text) instead of
// being reset between them.
// ---------------------------------------------------------------------------

let sharedLimiter = null;
let sharedLimiterKey = "";
let sharedRobots = null;
let sharedRobotsKey = "";

export function getSharedLimiter(settings = {}) {
  const perHost = Math.max(1, Math.min(Number(settings?.maxConcurrentPerHost) || 2, 16));
  const minGapMs = Number.isFinite(Number(settings?.minRequestGapMs)) ? Number(settings.minRequestGapMs) : 1500;
  const jitterMs = Number.isFinite(Number(settings?.requestGapJitterMs)) ? Number(settings.requestGapJitterMs) : 1500;
  const key = `${perHost}|${minGapMs}|${jitterMs}`;
  if (!sharedLimiter || sharedLimiterKey !== key) {
    sharedLimiter = createHostLimiter({ perHost, minGapMs, jitterMs });
    sharedLimiterKey = key;
  }
  return sharedLimiter;
}

export function getSharedRobots(settings = {}, limiter = null) {
  const ua = buildUserAgent(settings);
  const lim = limiter || getSharedLimiter(settings);
  const key = `${ua}|${sharedLimiterKey}`;
  if (!sharedRobots || sharedRobotsKey !== key) {
    sharedRobots = createRobotsCache({
      userAgent: ua,
      fetchText: async (robotsUrl) => {
        try {
          return await lim.run(hostOf(robotsUrl), async () => {
            const res = await fetchWithRetry(robotsUrl, { headers: plainHeaders(ua) }, { timeoutMs: 8000, retries: 0 });
            return res.ok ? await res.text() : null;
          });
        } catch {
          return null;
        }
      },
    });
    sharedRobotsKey = key;
  }
  return sharedRobots;
}

// Test hook: drop the process-wide limiter/robots caches.
export function resetHttpPolicy() {
  if (sharedLimiter) sharedLimiter.reset();
  sharedLimiter = null;
  sharedLimiterKey = "";
  sharedRobots = null;
  sharedRobotsKey = "";
}

// Finds the real feed URL for an HTML page by following
// <link rel="alternate" type="application/rss+xml|atom+xml"> declarations,
// resolving hrefs against the page URL. If `url` already serves a feed it is
// returned unchanged.
export async function discoverFeed(url, { timeoutMs = 15000, ua = UA } = {}) {
  try {
    const res = await fetchWithRetry(url, { headers: feedHeaders(ua) }, { timeoutMs, retries: 1 });
    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    if (!text || text.length < 50) return { found: false };
    const type = detectFeedType(text);
    if (type === "rss" || type === "atom") return { found: true, feedUrl: url, type };
    if (type === "html" || contentType.includes("text/html")) {
      const candidates = [];
      const matches = text.match(/<link[^>]+rel=["'][^"']*alternate[^"']*["'][^>]*>/gi) || [];
      for (const tag of matches) {
        const typeMatch = tag.match(/type=["']([^"']+)["']/i);
        const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
        if (!hrefMatch) continue;
        const typ = typeMatch ? typeMatch[1].toLowerCase() : "";
        if (typ.includes("rss") || typ.includes("atom") || typ.includes("xml")) {
          try {
            const feedUrl = new URL(hrefMatch[1], url).href;
            candidates.push({ feedUrl, type: typ.includes("atom") ? "atom" : "rss" });
          } catch {
            /* skip malformed href */
          }
        }
      }
      if (candidates.length) {
        return { found: true, feedUrl: candidates[0].feedUrl, type: candidates[0].type, candidates };
      }
    }
  } catch (e) {
    return { found: false, error: String(e?.message || e) };
  }
  return { found: false };
}

export async function testFeed(url) {
  try {
    const res = await fetchWithRetry(url, { headers: FEED_HEADERS }, { timeoutMs: 20000, retries: 1 });
    const text = await res.text();
    const interstitial = detectInterstitial(text);
    if (interstitial) {
      return { ok: false, blocked: true, ban: interstitial, error: describeBan(interstitial) };
    }
    const type = detectFeedType(text);
    const { parseRss: parseRssFn, parseHtml: parseHtmlFn } = await import("./parser.js");
    if (type === "html") {
      const items = parseHtmlFn(text, url);
      const discovered = await discoverFeed(url);
      return { ok: true, type, items: items.length, sample: items.slice(0, 5).map(i => i.title), discovered };
    }
    const items = parseRssFn(text, url);
    return { ok: true, type, items: items.length, sample: items.slice(0, 5).map(i => i.title) };
  } catch (e) {
    return { ok: false, blocked: !!e?.ban, ban: e?.ban ?? null, error: String(e?.message || e) };
  }
}

// Fetches a single article URL and extracts readable text (used by the opt-in
// "scrapeFullText" setting). Honours the shared per-host limiter and robots.txt.
export async function fetchArticleContent(url, { timeoutMs = 30000, settings = {}, limiter, robots, onBan } = {}) {
  const ua = buildUserAgent(settings);
  const lim = limiter || getSharedLimiter(settings);

  if (settings?.respectRobotsTxt !== false) {
    const r = robots || getSharedRobots(settings, lim);
    if (!(await r.allowed(url))) {
      const err = new Error("robots.txt disallows this URL");
      err.robotsDisallowed = true;
      throw err;
    }
  }

  return lim.run(hostOf(url), async () => {
    const res = await fetchWithRetry(url, {
      headers: {
        ...htmlHeaders(ua),
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
    }, { timeoutMs, retries: 1, onBan });

    const text = await res.text();
    if (!text || text.length < 100) throw new Error("Empty or invalid response");
    const interstitial = detectInterstitial(text);
    if (interstitial) {
      const err = new Error(`Bot wall: ${describeBan(interstitial)}`);
      err.ban = interstitial;
      if (onBan) onBan({ ...interstitial, url, host: hostOf(url), terminal: true });
      throw err;
    }
    return extractReadable(text);
  });
}

// Run async worker over items with bounded concurrency (preserving order).
async function mapLimit(items, limit, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// `feeds` may be an array of URLs or of per-feed config objects ({ url, tags,
// linkPatterns, maxItems, headers, scrapeFullText }) supplied by feeds.json.
// `opts.feedStates`: Map<url, feeds_state row>, already loaded by the caller.
// `opts.hostStates`: Map<host, host_state row>, for per-host ban backoff.
// `opts.force`:      bypass conditional headers and backoff (used by an explicit
//                    user-triggered refresh).
// `opts.onBan`:      called for every detected bot wall with
//                    { url, host, mode, kind, vendor, status, reason, terminal }.
export async function fetchAll(feeds, settings = {}, opts = {}) {
  const force = !!opts.force;
  const feedStates = opts.feedStates instanceof Map ? opts.feedStates : new Map();
  const hostStates = opts.hostStates instanceof Map ? opts.hostStates : new Map();
  const externalOnBan = typeof opts.onBan === "function" ? opts.onBan : null;
  const now = Date.now();
  const ua = buildUserAgent(settings);

  const respectRobots = settings.respectRobotsTxt !== false;
  const limiter = getSharedLimiter(settings);
  const robots = respectRobots ? getSharedRobots(settings, limiter) : null;

  const configs = (feeds || [])
    .map((f) => (typeof f === "string" ? { url: f } : f))
    .filter((f) => f && f.url);

  const rssFeeds = [];
  const htmlFeeds = [];
  for (const cfg of configs) {
    if (looksLikeRss(cfg.url)) rssFeeds.push(cfg);
    else htmlFeeds.push(cfg);
  }

  const defaultPatterns = String(settings.htmlLinkPatterns || "news,article,post,blog,stories,press")
    .split(",").map((p) => p.trim()).filter(Boolean);
  const concurrency = Math.max(1, Math.min(Number(settings.maxConcurrentFeeds) || 4, 32));

  const results = [];

  // Forward every ban to the caller as it is detected.
  const reportBan = (info) => {
    if (!externalOnBan) return;
    try {
      externalOnBan(info);
    } catch {
      /* a reporting hook must never break a fetch */
    }
  };

  // If the host of this URL is currently in ban backoff, skip it entirely.
  function hostBackoff(url) {
    if (force) return null;
    const st = hostStates.get(hostOf(url));
    if (st?.next_retry_at && st.next_retry_at > now) {
      return Math.max(1, Math.ceil((st.next_retry_at - now) / 60000));
    }
    return null;
  }

  async function fetchOneInner(cfg, mode, validators) {
    const url = cfg.url;
    const host = hostOf(url);
    try {
      const r = await fetchFeed(url, {
        timeoutMs: mode === "slow" ? 25000 : 20000,
        patterns: cfg.linkPatterns
          ? String(cfg.linkPatterns).split(",").map((p) => p.trim()).filter(Boolean)
          : defaultPatterns,
        validators,
        headers: cfg.headers,
        ua,
        onBan: (ban) => reportBan({ ...ban, mode }),
      });
      const max = Number(cfg.maxItems);
      return {
        url, host, ok: true, mode,
        items: Number.isFinite(max) && max > 0 ? r.items.slice(0, max) : r.items,
        notModified: r.notModified,
        etag: r.etag,
        lastModified: r.lastModified,
        tags: cfg.tags ?? [],
        collection: cfg.collection ?? null,
      };
    } catch (e) {
      return {
        url, host, ok: false, mode,
        error: String(e?.message || e),
        status: e?.status ?? null,
        ban: e?.ban ? { ...e.ban, mode } : null,
      };
    }
  }

  async function fetchOne(cfg, mode) {
    const url = cfg.url;
    const host = hostOf(url);

    const banWait = hostBackoff(url);
    if (banWait != null) {
      log.warn(`Skipping ${url}: host ${host} is behind a ban backoff (retry in ~${banWait}m).`);
      return { url, host, ok: false, mode, skipped: true, hostBackoff: true, error: `host ban backoff (retry in ~${banWait}m)` };
    }

    const feedState = feedStates.get(url);
    if (!force && feedState?.next_retry_at && feedState.next_retry_at > now) {
      const waitMin = Math.max(1, Math.ceil((feedState.next_retry_at - now) / 60000));
      log.info(`Skipping ${url} (backoff; retry in ~${waitMin}m)`);
      return { url, host, ok: false, mode, skipped: true, error: `backoff (retry in ~${waitMin}m)`, failCount: feedState.fail_count, status: feedState.last_status };
    }

    const validators = (() => {
      if (force || !feedState) return null;
      const v = {};
      if (feedState.etag) v["If-None-Match"] = feedState.etag;
      if (feedState.last_modified) v["If-Modified-Since"] = feedState.last_modified;
      return Object.keys(v).length ? v : null;
    })();

    // robots.txt is consulted only for pages we scrape (HTML), not for feeds:
    // an RSS URL is explicitly published for machines to poll.
    if (mode === "slow" && robots) {
      try {
        if (!(await robots.allowed(url))) {
          log.info(`robots.txt disallows ${url}; skipping.`);
          return { url, host, ok: false, mode, skipped: true, robotsDisallowed: true, error: "robots.txt disallowed" };
        }
      } catch {
        /* a robots.txt failure must never block a fetch */
      }
    }

    // The limiter enforces max-per-host concurrency and the minimum gap between
    // two requests to the same host. Pages on different hosts never wait on
    // each other.
    return limiter.run(host, () => fetchOneInner(cfg, mode, validators));
  }

  // 1. RSS/Atom feeds: bounded global concurrency, plus per-host pacing.
  const rssResults = await mapLimit(rssFeeds, concurrency, (cfg) => fetchOne(cfg, "fast"));
  results.push(...rssResults);

  // 2. HTML pages: sequential, but the per-host limiter supplies the delay.
  if (htmlFeeds.length > 0) {
    const gapMs = (Number(settings.minRequestGapMs) || 1500) + (Number(settings.requestGapJitterMs) || 0) / 2;
    const estTime = ((htmlFeeds.length * gapMs) / 1000).toFixed(0);
    log.info(`Slow-fetching ${htmlFeeds.length} HTML pages. Estimated time: ${estTime}s...`);

    for (let i = 0; i < htmlFeeds.length; i++) {
      const cfg = htmlFeeds[i];
      const progress = `[${i + 1}/${htmlFeeds.length}]`;
      log.info(`${progress} Scraping ${cfg.url}...`);

      const r = await fetchOne(cfg, "slow");
      results.push(r);
      if (r.skipped) log.info(`${progress} Skipped: ${r.error}`);
      else if (r.ok) log.info(`${progress} ${r.notModified ? "Not modified." : `Success: Found ${r.items.length} items.`}`);
      else log.warn(`${progress} Failed: ${r.error}`);
    }
  }

  const elapsed = ((Date.now() - now) / 1000).toFixed(1);
  log.info(`Feed fetching done in ${elapsed}s.`);
  return results;
}
