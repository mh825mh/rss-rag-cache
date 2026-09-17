import { parseRss, parseHtml } from "./parser.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchFeed(url, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 
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
        "Sec-Fetch-User": "?1"
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    
    const text = await res.text();
    if (!text || text.length < 50) throw new Error("Empty or invalid response");
    
    // Smart detection: Check the actual text first
    const lowerText = text.trim().toLowerCase();
    if (lowerText.includes("<rss") || lowerText.includes("<feed") || lowerText.includes("<?xml")) {
      return parseRss(text, url);
    }
    
    // If it doesn't look like RSS, try scraping it as HTML
    if (lowerText.startsWith("<!doctype") || lowerText.startsWith("<html") || res.headers.get('content-type')?.includes('text/html')) {
      console.log(`[rss-rag] No RSS found at ${url}. Scraping HTML for links...`);
      const scrapedItems = parseHtml(text, url);
      if (scrapedItems.length === 0) throw new Error("No articles found on HTML page");
      return scrapedItems;
    }
    
    // Fallback
    return parseRss(text, url);
  } finally {
    clearTimeout(t);
  }
}

const looksLikeRss = (url) => {
  const lower = url.toLowerCase();
  return lower.endsWith('.xml') || lower.endsWith('.rss') || lower.endsWith('.atom') || 
         lower.includes('/rss') || lower.includes('/feed') || lower.includes('feedburner') || lower.includes('/feeds/');
};

export async function fetchAll(feeds) {
  const rssFeeds = [];
  const htmlFeeds = [];
  
  for (const url of feeds) {
    if (looksLikeRss(url)) {
      rssFeeds.push(url);
    } else {
      htmlFeeds.push(url);
    }
  }

  const results = [];

  // 1. Fetch all RSS feeds concurrently
  console.log(`[rss-rag] Fast-fetching ${rssFeeds.length} RSS feeds...`);
  const rssPromises = rssFeeds.map(url => 
    fetchFeed(url)
      .then(items => ({ url, ok: true, items, mode: "fast" }))
      .catch(err => ({ url, ok: false, error: String(err.message || err), mode: "fast" }))
  );
  const rssResults = await Promise.all(rssPromises);
  results.push(...rssResults);

  // 2. Fetch HTML pages sequentially (Slow)
  if (htmlFeeds.length > 0) {
    const estTime = (htmlFeeds.length * 2.25).toFixed(0); // Estimate ~2.25s per feed
    console.log(`[rss-rag] Slow-fetching ${htmlFeeds.length} HTML pages. Estimated time: ${estTime}s...`);
    
    for (let i = 0; i < htmlFeeds.length; i++) {
      const url = htmlFeeds[i];
      const progress = `[${i + 1}/${htmlFeeds.length}]`;
      console.log(`[rss-rag] ${progress} Scraping ${url}...`);
      
      try {
        const items = await fetchFeed(url);
        results.push({ url, ok: true, items, mode: "slow" });
        console.log(`[rss-rag] ${progress} Success: Found ${items.length} items.`);
      } catch (err) {
        results.push({ url, ok: false, error: String(err.message || err), mode: "slow" });
        console.log(`[rss-rag] ${progress} Failed: ${err.message}`);
      }
      
      if (i < htmlFeeds.length - 1) {
        const delay = 1500 + Math.random() * 1500;
        await sleep(delay);
      }
    }
  }

  return results;
}