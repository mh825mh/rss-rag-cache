📡 RSS RAG Cache Plugin for LM Studio

Turn LM Studio into your own private, intelligent news archive. This plugin fetches your favorite RSS feeds, chunks the articles, embeds them using your local LM Studio server, and stores them in a local SQLite database for Retrieval-Augmented Generation (RAG).

Instead of searching the web, your LLM can instantly query your local cache of recent articles, blog posts, and newsletters.

✨ Features

- **Local RAG Pipeline**: Fetches RSS feeds, chunks text, and generates embeddings via LM Studio's local server.
- **Hybrid Search**: Combines SQLite FTS5 (trigram keyword search, great for CJK and noisy text) with a bounded semantic full-scan (vector cosine similarity over the cache). If the embedding model is offline, it automatically falls back to pure keyword search.
- **Retry & Backoff**: Fetch requests retry on 429/403/5xx using `Retry-After` (capped at 15s), so flaky or rate-limited feeds fail gracefully instead of erroring out.
- **Auto-HTML Scraper (Cheerio)**: If a URL doesn't have an RSS feed (like a standard news webpage), the plugin automatically scrapes the page for article links using configurable keywords (`news`, `article`, `post`, ...).
- **Smart Throttling**: Fetches standard RSS feeds instantly and concurrently, but uses a 1.5–3 second randomized delay when scraping HTML pages to bypass 403 Forbidden firewalls and look like a human user.
- **RSS/Atom XML via fast-xml-parser**: Robust parsing of RSS 2.0 and Atom feeds, with a regex-based fallback parser for malformed XML.
- **Admin Tools**: Add/remove/test feeds, re-embed missing vectors, and prune orphaned articles — all from chat via tools.
- **Configurable Retention**: Keeps entries by publish date (falling back to cache date) for 30, 60, 90, or 365 days.
- **Startup Model Check**: Warns (non-fatally) if your configured embedding model isn't loaded, so you know why search drops to keyword-only.
- **Native SQLite Database**: Uses Node.js's built-in `node:sqlite` module (WAL mode). No C++ addons or Visual Studio build tools required!
- **Safe Data Storage**: Stores your `feeds.txt` and `cache.db` in `~/.lmstudio/plugin-data/rss-rag-cache/` so they survive plugin updates.

📋 Requirements

- **LM Studio**: Running the local server.
- **Embedding Model**: You must download and load an embedding model in LM Studio (e.g., `nomic-embed-text-v1.5`) and start the local server on port 1234.
- **Node.js v22+**: Requires Node version 22 or higher for native SQLite support.

🚀 Installation

1. Download or install this plugin directly from the LM Studio Plugin Hub.
2. Ensure LM Studio is running an embedding model on the Local Server.
3. The plugin will automatically create `feeds.txt` in your plugin-data folder on the first run.

⚙️ Configuration

**1. Adding Feeds (feeds.txt)**

Your feeds file is located at:

- Windows: `C:\Users\YOUR_USERNAME\.lmstudio\plugin-data\rss-rag-cache\feeds.txt`
- Mac/Linux: `~/.lmstudio/plugin-data/rss-rag-cache/feeds.txt`

Add one RSS/Atom URL per line. You can also add standard webpage URLs (the plugin will scrape them automatically). Lines starting with `#` are ignored.

```
https://news.ycombinator.com/rss
https://www.theverge.com/rss/index.xml
# Non-RSS webpages (scraped automatically, slower):
https://example.com/news
```

**2. Plugin Settings UI**

You can adjust these values in the LM Studio plugin settings panel:

| Setting | Default | Description |
|---|---|---|
| `retentionDays` | 90 | How long to keep articles (30, 60, 90, or 365 days). |
| `refreshIntervalHours` | 6 | How often the plugin automatically fetches new RSS items in the background. |
| `embeddingModel` | `nomic-embed-text-v1.5` | The exact model ID loaded in your LM Studio server. |
| `topK` | 8 | How many unique articles to return per search. |
| `chunkSize` | 800 | Length (in characters) of each text chunk used for embedding and search. |
| `embedBatchSize` | 16 | How many chunks are sent to the embedding model per request (higher = faster but more VRAM). |
| `maxConcurrentFeeds` | 8 | How many RSS/Atom feeds are fetched at the same time. |
| `htmlLinkPatterns` | `news,article,post,blog,stories,press` | Comma-separated URL keywords used when scraping non-RSS pages. |
| `scrapeFullText` | Off | For HTML-scraped pages, also download each article's full body text (slower refresh, richer content). |
| `retentionBasis` | `publish_date` | Whether old entries are removed by publish date or cache date. |
| `refreshOnStartup` | On | Automatically fetch feeds when the plugin loads. |

🛠️ LM Studio Tools

The plugin exposes these tools to the LLM:

- **`refresh_rss_feeds`** — Force-refreshes all feeds listed in `feeds.txt`, indexes new items, generates embeddings, and applies the retention policy. Returns a report of successes, failures, and added articles.
- **`search_rss_cache`** — Hybrid (keyword + semantic) search, optionally filtered by `days`, `feed` (URL substring), or `author`.
- **`list_rss_feeds`** — Lists all configured feed URLs plus cache stats: entry/chunk counts, missing embeddings, DB size, and last refresh report.
- **`get_recent_cache_articles`** — Returns the most recent cached articles. Use this to see what news is available without guessing keywords.
- **`add_rss_feed`** — Adds an RSS/Atom feed URL or webpage URL to `feeds.txt`.
- **`remove_rss_feed`** — Removes a feed URL from `feeds.txt` (cached articles kept until pruned).
- **`test_feed`** — Checks whether a URL is a working RSS/Atom feed or scrapeable HTML page, and how many items it exposes.
- **`prune_removed_feeds`** — Deletes cached articles whose source feed is no longer in `feeds.txt`.
- **`reindex_missing_embeddings`** — Re-embeds chunks stored as text-only while the embedding model was offline.

🧠 How It Works

1. **Fetch & Parse**: The plugin pulls XML data from your URLs, parsing RSS 2.0 and Atom via `fast-xml-parser` (with a legacy regex fallback). If a URL returns HTML, it uses Cheerio to scrape the page for article links.
2. **Throttling & Retries**: RSS feeds are fetched concurrently (up to `maxConcurrentFeeds`). HTML pages are fetched one-by-one with a 1.5–3 second delay to avoid anti-bot firewalls. Requests retry with backoff on 429/403/5xx.
3. **Chunking**: Article content is split into ~800-character overlapping chunks to fit context windows.
4. **Embedding**: Chunks are sent to LM Studio's `/v1/embeddings` endpoint in batches. If the model is offline, chunks are stored text-only and `reindex_missing_embeddings` completes them later.
5. **Storage**: Text, metadata, and vector embeddings (stored as BLOBs) are saved in a WAL-mode SQLite file (`cache.db`). Newer items list first; retention purges by publish or cache date.
6. **Retrieval**: When the LLM searches, the plugin finds the best-matching chunks using trigram FTS5 (exact/near keywords) plus a bounded cosine-similarity scan, deduplicates by article, applies any filters, and returns the top-K articles as context.

🐛 Troubleshooting

**Search returns 0 matches**
Ensure your embedding model is loaded and the server is running. If the model is offline, the plugin falls back to keyword search — but if your articles don't contain the exact keywords, they won't be found. Run `list_rss_feeds` to check that chunks > 0, or `reindex_missing_embeddings` once the model is loaded.

**HTTP 403 Forbidden on a feed**
Some websites block automated requests. The plugin uses a Chrome User-Agent, throttles HTML requests, and retries with backoff, but strict firewalls might still block it. Try an alternative RSS URL or an RSS Bridge service.

**HTTP 429 Too Many Requests**
Sites like Reddit aggressively block Node.js fetch requests. If this happens, use an RSS Bridge URL (e.g., `https://rss-bridge.org/bridge01/?action=display&bridge=RedditBridge&format=Atom`) instead of the native `.rss` link.