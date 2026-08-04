import { parseRss } from "./parser.js";

const UA = "rss-rag-cache/1.0 (+lm-studio-plugin)";

export async function fetchFeed(url, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    return parseRss(text, url);
  } finally {
    clearTimeout(t);
  }
}

export async function fetchAll(feeds) {
  const results = await Promise.allSettled(feeds.map((u) => fetchFeed(u)));
  return results.map((r, i) => ({ url: feeds[i], ...(r.status === "fulfilled" ? { ok: true, items: r.value } : { ok: false, error: String(r.reason) }) }));
}