import { parseRss, parseHtml, extractReadable } from "./parser.js";
import { log } from "./log.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseRetryAfter(v) {
  if (!v) return null;
  const trimmed = v.trim();
  const n = parseInt(trimmed, 10);
  if (!Number.isNaN(n) && String(n) === trimmed) return n * 1000;
  const d = Date.parse(trimmed);
  if (!Number.isNaN(d)) return Math.max(0, Math.min(d - Date.now(), 60000));
  return null;
}

// fetch with retry/backoff on 429, 5xx, and transient 403 anti-bot responses.
async function fetchWithRetry(url, init, { timeoutMs, retries = 2 }) {
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

    const retryable = status === 429 || status === 403 || (status >= 500 && status < 600);
    if (retryable && attempt < retries) {
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const wait = Math.min(retryAfter ?? 800 * (attempt + 1), 15000);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${status} ${res.statusText}`);
      err.status = status; // preserved for per-feed health/backoff bookkeeping
      throw err;
    }
    return res;
  }
  throw lastErr ?? new Error("HTTP request failed after retries");
}

const FEED_HEADERS = {
  "User-Agent": UA,
  "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

// Fetches one feed. When `validators` (If-None-Match / If-Modified-Since) are
// supplied and the server answers 304 Not Modified, returns
// `{ items: [], notModified: true }` without downloading a body. `headers`
// carries per-feed extras (e.g. an Authorization header) from feeds.json.
// Otherwise returns `{ items, notModified: false, etag, lastModified }` so the
// caller can persist the new validators for the next conditional request.
export async function fetchFeed(url, { timeoutMs = 20000, patterns = [], validators = null, headers = null } = {}) {
  const merged = { ...FEED_HEADERS, ...(validators || {}), ...(headers || {}) };
  const res = await fetchWithRetry(url, { headers: merged }, { timeoutMs, retries: 2 });

  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");

  if (res.status === 304) {
    return { items: [], notModified: true, etag, lastModified };
  }

  const text = await res.text();
  if (!text || text.length < 50) throw new Error("Empty or invalid response");

  // Smart detection: Check the actual text first
  const lowerText = text.trim().toLowerCase();
  if (lowerText.includes("<rss") || lowerText.includes("<feed") || lowerText.includes("<?xml")) {
    return { items: parseRss(text, url), notModified: false, etag, lastModified };
  }

  // If it doesn't look like RSS, try scraping it as HTML
  if (lowerText.startsWith("<!doctype") || lowerText.startsWith("<html") || res.headers.get('content-type')?.includes('text/html')) {
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
         lower.includes('/rss') || lower.includes('/feed') || lower.includes('feedburner') || lower.includes('/feeds/');
};

export function detectFeedType(text) {
  const lower = (text || "").slice(0, 4000).toLowerCase();
  if (lower.includes("<rss") || lower.includes("<rdf:rdf")) return "rss";
  if (lower.includes("<feed")) return "atom";
  if (lower.includes("<!doctype") || lower.includes("<html")) return "html";
  return "unknown";
}

export async function testFeed(url) {
  try {
    const res = await fetchWithRetry(url, { headers: FEED_HEADERS }, { timeoutMs: 20000, retries: 1 });
    const text = await res.text();
    const type = detectFeedType(text);
    if (type === "html") {
      const { parseHtml: parse } = await import("./parser.js");
      const items = parse(text, url);
      return { ok: true, type, items: items.length, sample: items.slice(0, 5).map(i => i.title) };
    }
    const { parseRss: parse } = await import("./parser.js");
    const items = parse(text, url);
    return { ok: true, type, items: items.length, sample: items.slice(0, 5).map(i => i.title) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Fetches a single article URL and extracts readable text (used by the
// opt-in "scrapeFullText" setting for HTML-scraped pages).
export async function fetchArticleContent(url, { timeoutMs = 30000 } = {}) {
  const res = await fetchWithRetry(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
      "Connection": "keep-alive",
      "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    },
  }, { timeoutMs, retries: 1 });

  const text = await res.text();
  if (!text || text.length < 100) throw new Error("Empty or invalid response");
  return extractReadable(text);
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
// `opts.force`:      bypass conditional headers and backoff (used by an explicit
//                    user-triggered refresh). Default (auto) refresh is cheap.
export async function fetchAll(feeds, settings = {}, opts = {}) {
  const force = !!opts.force;
  const feedStates = opts.feedStates instanceof Map ? opts.feedStates : new Map();
  const now = Date.now();

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
  const concurrency = Math.max(1, Math.min(Number(settings.maxConcurrentFeeds) || 8, 32));

  const results = [];

  // Decides whether to skip a feed (still in backoff) and builds the conditional
  // headers for it. Returns { skip } or { validators }.
  function prepare(url, mode) {
    const st = feedStates.get(url);
    if (!force && st?.next_retry_at && st.next_retry_at > now) {
      const waitMin = Math.max(1, Math.ceil((st.next_retry_at - now) / 60000));
      log.info(`Skipping ${url} (backoff; retry in ~${waitMin}m)`);
      return { skip: { url, ok: false, mode, skipped: true, error: `backoff (retry in ~${waitMin}m)`, failCount: st.fail_count, status: st.last_status } };
    }
    if (force || !st) return { validators: null };
    const validators = {};
    if (st.etag) validators["If-None-Match"] = st.etag;
    if (st.last_modified) validators["If-Modified-Since"] = st.last_modified;
    return { validators: Object.keys(validators).length ? validators : null };
  }

  const fetchOne = async (cfg, mode) => {
    const url = cfg.url;
    const prep = prepare(url, mode);
    if (prep.skip) return prep.skip;
    const patterns = cfg.linkPatterns
      ? String(cfg.linkPatterns).split(",").map((p) => p.trim()).filter(Boolean)
      : defaultPatterns;
    try {
      const r = await fetchFeed(url, { patterns, validators: prep.validators, headers: cfg.headers });
      let items = r.items;
      const maxItems = Number(cfg.maxItems);
      if (Number.isFinite(maxItems) && maxItems > 0) items = items.slice(0, maxItems);
      return {
        url, ok: true, items, notModified: r.notModified, etag: r.etag, lastModified: r.lastModified, mode,
        tags: Array.isArray(cfg.tags) ? cfg.tags : [],
        scrapeFullText: cfg.scrapeFullText ?? null,
      };
    } catch (err) {
      return { url, ok: false, error: String(err.message || err), status: err.status ?? null, mode };
    }
  };

  // 1. Fetch all RSS feeds with bounded concurrency
  const started = Date.now();
  log.info(`Fetching ${rssFeeds.length} RSS feeds (concurrency ${concurrency})...`);
  const rssResults = await mapLimit(rssFeeds, concurrency, (cfg) => fetchOne(cfg, "fast"));
  results.push(...rssResults);

  // 2. Fetch HTML pages sequentially (Slow, throttled)
  if (htmlFeeds.length > 0) {
    const estTime = (htmlFeeds.length * 2.25).toFixed(0); // Estimate ~2.25s per feed
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

      if (i < htmlFeeds.length - 1) {
        const delay = 1500 + Math.random() * 1500;
        await sleep(delay);
      }
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  log.info(`Feed fetching done in ${elapsed}s.`);
  return results;
}