📡 RSS RAG Cache Plugin for LM Studio

Turn LM Studio into your own private, intelligent news archive. This plugin fetches your favorite RSS feeds, chunks the articles, embeds them using your local LM Studio server, and stores them in a local SQLite database for Retrieval-Augmented Generation (RAG).

Instead of searching the web, your LLM can instantly query your local cache of recent articles, blog posts, and newsletters.

✨ Features

- **Local RAG Pipeline**: Fetches RSS feeds, chunks text, and generates embeddings via LM Studio's local server.
- **Hybrid Search (BM25 + RRF)**: Combines two SQLite FTS5 indexes (trigram for CJK/substrings, and `porter unicode61` for real BM25 word ranking) with a resident in-memory vector index (falling back to a bounded SQL scan when the matrix would exceed the memory ceiling), fused by Reciprocal Rank Fusion. Active filters (feed / author / tag / collection / date range) are resolved to an entry-ID allow-list **before** ranking, so both keyword lists and the vector scan only score in-scope articles — a filtered search on a large cache costs time proportional to the matches, not to the cache. If the embedding model is offline, it automatically falls back to pure keyword search.
- **Contextual Chunk Embeddings**: Each chunk is embedded as `title | section breadcrumb` + newline + chunk (embed style `contextual-v2`), so summary-only feeds and mid-article passages still produce self-contained vectors. Document/query inputs then receive model-aware asymmetric prefixes (`search_document:` / `search_query:` for `nomic-embed-text-*`, `Represent this sentence…` for bge/mxbai/snowflake). The stored/displayed text is unchanged. Switchable via `contextualChunks`; caches on older embed styles are upgraded lazily by `reindex_missing_embeddings`.
- **Heading Breadcrumbs**: `<h1>`–`<h3>` are preserved as Markdown headings during extraction, and each chunk records the heading path that was active where the chunk ends (e.g. `Title > Setup > Windows`), so expanded context tells the model *where* a passage came from.
- **Small-to-Big Context**: Each search hit is expanded to include up to `contextChunks` neighbouring chunks, so the returned snippet carries surrounding context rather than an isolated passage.
- **Fast, Incremental Vector Index**: All embeddings are packed once into a single, densely-packed, pre-normalised `Float32Array`, so a semantic query is one tight dot-product loop with zero per-query allocation. The index is then maintained **in place**: newly indexed chunks append into recycled slots (tombstones tracked through an O(1) free list) and removed articles are tombstoned, so refreshes and retention no longer rebuild the whole matrix. It still rebuilds on a dimension change or when tombstones exceed 20% of capacity; a configurable byte ceiling (`RSS_RAG_INDEX_MAX_MB`, default 256 MB, with 15% headroom) falls back to the streaming scan when exceeded.
- **Feed Auto-Discovery**: `manage_rss_feeds` accepts a blog homepage and follows `<link rel="alternate" type="application/rss+xml|atom+xml">` to the real feed, adding that instead. The granular `test_feed` reports any discovered alternates.
- **Per-Feed TTL & Collections**: `feeds.json` supports a per-feed `retentionDays` override and a `collection` label; retention honours the override, and search can be scoped with the `collection` filter.
- **Agent-Optimized Tool Surface**: The default surface is just 4 tools — `search_rss_cache`, `get_rss_article`, `get_recent_cache_articles`, `manage_rss_feeds` — so every chat only pays the token cost of 4 tool schemas. One multiplexed `admin_rss_cache` tool (gated by `enableAdminTools`) covers diagnostics/optimization/reindexing/debug, and the legacy one-purpose tools come back with `exposeGranularAdminTools`.
- **Full Article Reader**: `get_rss_article` returns a cached article's complete text and metadata given an `entryId` or canonical `url`, with `offset`/`maxChars` paging (default 12,000 chars) and an optional chunk layout (`includeChunks: true`) — so the model can read past the 600-character search snippet.
- **Ranking Debug**: `admin_rss_cache` with `action: "debug_search"` (or the granular `search_rss_cache_debug`) explains each result — per-list rank, RRF contribution, cosine similarity, fused score — for observability without changing behaviour.
- **Eval Harness**: `npm run eval` indexes a frozen corpus against a deterministic fake embedding server and reports recall@1/3/5/10, MRR, nDCG@10, and latency p50/p95, gating on regressions versus a committed baseline.
- **Structure-Aware Chunking**: Text is split on paragraph and sentence boundaries (with a small overlap) instead of a fixed character window, so chunks never cut a sentence in half and embeddings represent coherent passages.
- **Content-Change Re-Indexing**: Each entry stores a content hash; when a feed edits an article (same GUID, new body), the entry's chunks are rebuilt and re-embedded instead of being ignored forever.
- **Robust Article Extraction**: Reads `<article>` / content selectors, strips boilerplate, preserves paragraph breaks and heading structure, and falls back to Open Graph / meta descriptions.
- **Self-Healing Embeddings**: A bounded backfill runs once the model is detected at startup and after every refresh, so gaps from an offline model repair themselves. Embedding batches run with bounded concurrency and repeated queries are cached.
- **Per-Feed Configuration (`feeds.json`)**: Optionally override `enabled`, `tags`, `scrapeFullText`, `linkPatterns`, `maxItems`, and request `headers` for individual feeds; tags become a search filter.
- **Near-Duplicate Collapse (64-bit SimHash)**: Each entry stores a 64-bit SimHash over 3-gram word shingles (FNV-1a); syndicated articles that differ only in a footer or byline collapse to a single result, while genuinely distinct short updates are left uncollapsed.
- **Rich Search Controls**: Filter by `days`/`after`/`before`, feed, author, or tag; sort by relevance or date; paginate with `limit`/`offset`. Filters are applied before ranking, not after.
- **Diagnostics**: `cache_diagnostics` (or `admin_rss_cache` with `action: "diagnostics"`) reports coverage, sizes, feed health, and suggested fixes.
- **Conditional Fetching**: Background refreshes send `If-None-Match` / `If-Modified-Since` (ETag / Last-Modified) so unchanged feeds answer `304 Not Modified` and cost almost no bandwidth. A manual refresh (or `force: true`) re-downloads everything.
- **Retry & Per-Feed Backoff**: Requests retry on 429/403/5xx using `Retry-After` (capped at 15s). Feeds that keep failing are placed in an exponential backoff (15 min doubling to 24 h) and skipped until their retry time, so one broken feed can't slow every refresh.
- **Embedding-Model Guard**: The model ID and vector dimension are recorded with the cache. If you switch models, a dimension mismatch is detected and surfaced (instead of silently degrading search) and `admin_rss_cache` with `action: "reembed"` rebuilds the index.
- **Diversified, Recency-Aware Ranking**: Results blend the fused relevance score with a gentle recency boost and pass through MMR (Maximal Marginal Relevance) so syndicated near-duplicate headlines don't crowd out distinct results. Snippets are windowed around the matching query terms.
- **Auto-HTML Scraper (Cheerio)**: If a URL doesn't have an RSS feed (like a standard news webpage), the plugin automatically scrapes the page for article links using configurable keywords (`news`, `article`, `post`, ...).
- **Smart Throttling**: Fetches standard RSS feeds instantly and concurrently, but uses a 1.5–3 second randomized delay when scraping HTML pages to bypass 403 Forbidden firewalls and look like a human user.
- **RSS/Atom XML via fast-xml-parser**: Robust parsing of RSS 2.0 and Atom feeds, with a regex-based fallback parser for malformed XML.
- **Admin Tools (Opt-In)**: Feed add/remove/test/configure, pruning, reindexing, and `VACUUM` are available from chat through `manage_rss_feeds` and `admin_rss_cache`; the legacy granular tools remain available behind `exposeGranularAdminTools`.
- **Configurable Retention**: Keeps entries by publish date (falling back to cache date) for 30, 60, 90, or 365 days.
- **Startup Model Check**: Warns (non-fatally) if your configured embedding model isn't loaded, so you know why search drops to keyword-only.
- **Native SQLite Database**: Uses Node.js's built-in `node:sqlite` module (WAL mode). No C++ addons or Visual Studio build tools required!
- **Versioned Migrations**: The schema is upgraded through an idempotent `PRAGMA user_version` migration runner (currently version 10), so new columns/indexes and data upgrades (like the 64-bit SimHash backfill) are applied safely to existing databases.
- **Resilient Indexing**: Articles and their chunks are embedded first and committed in a single transaction, so an interrupted or failed refresh never leaves half-indexed entries behind. Store-time L2 norms keep semantic search fast.
- **Automatic Maintenance**: After each refresh the retention pass runs `PRAGMA optimize` and `VACUUM`s the database only when enough free pages have accumulated (so routine refreshes stay fast).
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

Cache and indexing settings are **global** (they configure the shared on-disk
cache). Only `topK` is **per-chat**, since it governs how much context a single
conversation pulls in.

*Global plugin settings:*

| Setting | Default | Description |
|---|---|---|
| `retentionDays` | 90 | How long to keep articles (30, 60, 90, or 365 days). |
| `refreshIntervalHours` | 6 | How often the plugin automatically fetches new RSS items in the background. |
| `embeddingModel` | `nomic-embed-text-v1.5` | The exact model ID loaded in your LM Studio server. |
| `chunkSize` | 800 | Length (in characters) of each text chunk used for embedding and search. |
| `embedBatchSize` | 16 | How many chunks are sent to the embedding model per request (higher = faster but more VRAM). |
| `embedConcurrency` | 3 | How many embedding requests run in parallel during indexing/backfill. |
| `maxConcurrentFeeds` | 8 | How many RSS/Atom feeds are fetched at the same time. |
| `semanticScanLimit` | 50000 | Maximum chunks scanned per semantic search (higher = better recall, slower). |
| `htmlLinkPatterns` | `news,article,post,blog,stories,press` | Comma-separated URL keywords used when scraping non-RSS pages. |
| `contextualChunks` | On | Embed each chunk as `title \| section breadcrumb` + text so vectors are self-contained (improves recall on summary-only feeds). Changing it re-embeds the cache; older embed styles upgrade lazily. |
| `contextChunks` | 1 | How many adjacent chunks to include around each match (0–2) for extra context. |
| `refreshOnStartup` | On | Automatically fetch feeds when the plugin loads. |
| `lmStudioBaseUrl` | `http://localhost:1234` | Where the embedding model is served. |
| `enableAdminTools` | Off | Registers the multiplexed `admin_rss_cache` tool (diagnostics, optimize, prune, reindex, reembed, debug search). |
| `exposeGranularAdminTools` | Off | Registers the legacy one-purpose tools (`refresh_rss_feeds`, `list_rss_feeds`, `add_rss_feed`, …) in addition to `admin_rss_cache`. |

*Per-chat settings:*

| Setting | Default | Description |
|---|---|---|
| `topK` | 8 | How many unique articles to return per search. |

**3. Per-Feed Options (`feeds.json`)**

For fine-grained control, create `feeds.json` next to `feeds.txt` (or use the `set_feed_options` tool). Feeds listed in `feeds.txt` are merged with their JSON overrides:

```json
{
  "feeds": [
    { "url": "https://news.ycombinator.com/rss", "tags": ["tech", "startups"], "maxItems": 50 },
    { "url": "https://example.com/private.xml", "headers": { "Authorization": "Bearer ..." } },
    { "url": "https://example.com/news", "enabled": false }
  ]
}
```

Supported fields per feed: `enabled`, `tags`, `scrapeFullText`, `linkPatterns`, `maxItems`, `headers`, `retentionDays`, `collection`. Set `enabled: false` to keep a feed configured but skip fetching it, and use `tags` and `collection` to filter searches.

🛠️ LM Studio Tools

The default surface is intentionally small — 4 tools — so each chat only pays the token cost of 4 tool schemas.

**Default tools (always registered)**

- **`search_rss_cache`** — Hybrid (BM25 keyword + semantic) search. Filter by `days`, `after`/`before` (ISO date), `feed` (URL substring), `author`, `tag`, or `collection`; sort by `relevance` (default) or `date`; paginate with `limit`/`offset`. Filters are resolved to an entry-ID allow-list *before* ranking, results are recency-weighted, de-duplicated (SimHash), and diversified (MMR). Each hit includes expanded context (via `contextChunks`) and a snippet windowed around the matching query terms.
- **`get_rss_article`** — Full article reader: returns the complete stored text and metadata (title, link, feed, author, date, tags, collection, `totalChars`) for a cached article given an `entryId` **or** a `url`. Page through long articles with `offset` / `maxChars` (default 12,000, capped at 50,000) — the response reports `hasMore` / `nextOffset` — and pass `includeChunks: true` to also get the chunk layout with each chunk's embed style.
- **`get_recent_cache_articles`** — Returns the most recent cached articles. Use this to see what news is available without guessing keywords.
- **`manage_rss_feeds`** — One tool for every feed operation via `action`: `list` (feeds with tags/enabled state, per-feed health — last status, failure count, next retry — cache stats, and the last refresh report), `add` (auto-discovers `<link rel="alternate">` feeds from homepages and accepts per-feed `options`), `remove`, `test`, `configure` (per-feed `feeds.json` overrides), and `refresh` (pass `force: true` to re-download everything and ignore backoff).

**Optional: `enableAdminTools`**

- **`admin_rss_cache`** — Cache administration multiplexer via `action`: `diagnostics` (entry/chunk counts, embedding coverage and gaps, DB/WAL size, resident vector-index stats, feed backoff state, embedding model/dimension, schema version, suggested actions), `optimize` (WAL checkpoint, `VACUUM`, `ANALYZE`), `prune` (delete cached articles of feeds no longer configured), `reindex` (embed chunks stored text-only while the model was offline), `reembed` (rebuild the vector index with the current model; optional `rechunk: true` also re-chunks), and `debug_search` (the search pipeline with per-result ranking details: per-list ranks, RRF contribution, cosine similarity, fused score).

**Optional: `exposeGranularAdminTools`** (adds `admin_rss_cache` plus the legacy one-purpose tools)

- **`refresh_rss_feeds`** — Refreshes all feeds listed in `feeds.txt`, indexes new items, generates embeddings, and applies the retention policy. Feeds are fetched conditionally (ETag / Last-Modified) and failing feeds back off; pass `force: true` to re-download everything and ignore backoff. Returns a report of successes, not-modified, skipped, and failed feeds.
- **`list_rss_feeds`** — Lists configured feeds (with their tags/enabled state) plus cache stats: entry/chunk counts, missing embeddings, DB size, the embedding model/dimension the cache was built with, per-feed health (last status, failure count, next retry), and the last refresh report.
- **`add_rss_feed`** — Adds an RSS/Atom feed URL or webpage URL to `feeds.txt`. If a homepage is given, it auto-discovers the alternate feed via `<link rel="alternate">` and adds the discovered feed URL instead (returns `requestedUrl`, `discoveredFeedUrl`, `type`, and any `candidates`).
- **`remove_rss_feed`** — Removes a feed URL from `feeds.txt` (and any `feeds.json` override). Cached articles are kept until pruned.
- **`set_feed_options`** — Sets per-feed options in `feeds.json` (`enabled`, `tags`, `scrapeFullText`, `linkPatterns`, `maxItems`, `headers`, `retentionDays`, `collection`). Only the supplied fields change.
- **`test_feed`** — Checks whether a URL is a working RSS/Atom feed or scrapeable HTML page, and how many items it exposes. When the URL is an HTML page, it also returns a `discovered` object listing any alternate feeds found.
- **`prune_removed_feeds`** — Deletes cached articles whose source feed is no longer in `feeds.txt`.
- **`reindex_missing_embeddings`** — Re-embeds chunks stored as text-only while the embedding model was offline, and re-chunks any entries that ended up with no chunks. Also lazily upgrades older embed styles.
- **`reembed_all`** — Rebuilds the entire vector index with the currently configured embedding model. Use after switching embedding models (or when a dimension-mismatch warning appears). Optional `rechunk: true` also re-chunks with the current `chunkSize`.
- **`optimize_rss_cache`** — Runs a WAL checkpoint, `VACUUM`, and `ANALYZE` to reclaim disk space (e.g. after retention deletes) and refresh query statistics. A lighter version of this (`PRAGMA optimize`, and `VACUUM` when enough free pages accumulate) now runs automatically after each refresh.
- **`search_rss_cache_debug`** — Diagnostic version of `search_rss_cache` that returns per-result ranking details (`_debug`) including per-list ranks, RRF contribution, cosine similarity, and the fused combined score. No behaviour change to the non-debug search.
- **`cache_diagnostics`** — Reports cache health in one call: entry/chunk counts, embedding coverage and gaps, DB/WAL size, feed backoff state, embedding model/dimension, schema version, and suggested next actions.

🧪 Development

```bash
npm install
npm test          # node:test suite (lib modules + a fake embedding server)
npm run typecheck # tsc --noEmit over src/*.ts
npm run eval      # Phase 0 retrieval eval (recall@k/MRR/nDCG@10 + latency)
```

Contributor notes:

- Do **not** add `"type": "module"` to `package.json`. LM Studio bundles the
  plugin to a CommonJS `.lmstudio/dev.js`; marking the package as ESM would make
  Node load that bundle as ESM and break its `require()` calls.
- Tests rely on Node's automatic module-syntax detection for the ESM `lib/*.js`
  files (Node 22.7+).
- Set `RSS_RAG_DATA_DIR` to relocate the data directory. The test suite uses it
  to run against a throwaway SQLite database.
- The registered tool list is decided by `lib/toolSurface.js`
  (`resolveToolSurface`); keep it in sync with the `toolsMap` in
  `src/toolsProvider.ts`.

🧠 How It Works

1. **Fetch & Parse**: The plugin pulls XML data from your URLs, parsing RSS 2.0 and Atom via `fast-xml-parser` (with a legacy regex fallback). If a URL returns HTML, it uses Cheerio to scrape the page for article links.
2. **Throttling, Conditional GET & Backoff**: RSS feeds are fetched concurrently (up to `maxConcurrentFeeds`) with `If-None-Match` / `If-Modified-Since`, so unchanged feeds return `304` and send no body. HTML pages are fetched one-by-one with a 1.5–3 second delay to avoid anti-bot firewalls. Requests retry with backoff on 429/403/5xx, and a feed that keeps failing enters exponential backoff so it is skipped until its retry time.
3. **Chunking**: Article content is split on paragraph and sentence boundaries into ~800-character passages (with a small overlap), so chunks are coherent and never cut a sentence in half. Headings (`h1`–`h3`, preserved as Markdown) give each chunk a section breadcrumb — the heading path active where the chunk ends.
4. **Embedding**: Chunks are embedded as `title | breadcrumb` + body (`contextual-v2`) and sent to LM Studio's `/v1/embeddings` endpoint in batches, with bounded request concurrency and model-aware document/query prefixes. If the model is offline, chunks are stored text-only and a backfill (`admin_rss_cache` → `reindex`, or automatically once the model is up) completes them later; caches built with older embed styles are upgraded the same way. Repeated search queries reuse a cached (prefixed) query embedding.
5. **Storage**: Text, metadata, content hashes, 64-bit SimHash fingerprints, and vector embeddings (stored as BLOBs) are saved in a WAL-mode SQLite file (`cache.db`) through a versioned migration runner (schema version 10). Newer items list first; retention purges by publish or cache date. When an existing entry's text changes, its chunks are transparently rebuilt.
6. **Retrieval**: Search filters first resolve to an entry-ID allow-list; the plugin then fuses a trigram FTS5 list, a `porter` BM25 FTS5 list, and a bounded cosine-similarity scan — all restricted to those entries — using Reciprocal Rank Fusion, deduplicates by article (collapsing syndicated duplicates via SimHash), blends in a gentle recency boost, and diversifies with MMR before returning results. Each result includes a snippet windowed around the matching query terms; the resident vector index is updated in place as articles are added or removed.
7. **Health & Maintenance**: Per-feed HTTP validators and failure state live in a `feeds_state` table; the retention pass keeps planner statistics fresh and vacuums only when warranted. `admin_rss_cache` (or `cache_diagnostics`) summarizes coverage, sizes, feed health, and suggested fixes in one call.

🐛 Troubleshooting

**Search returns 0 matches**
Ensure your embedding model is loaded and the server is running. If the model is offline, the plugin falls back to keyword search — but if your articles don't contain the exact keywords, they won't be found. Run `manage_rss_feeds` with `action: "list"` to check that `chunks > 0`; with `enableAdminTools` on, `admin_rss_cache` with `action: "reindex"` fills the gaps once the model is loaded.

**HTTP 403 Forbidden on a feed**
Some websites block automated requests. The plugin uses a Chrome User-Agent, throttles HTML requests, and retries with backoff, but strict firewalls might still block it. Try an alternative RSS URL or an RSS Bridge service.

**HTTP 429 Too Many Requests**
Sites like Reddit aggressively block Node.js fetch requests. If this happens, use an RSS Bridge URL (e.g., `https://rss-bridge.org/bridge01/?action=display&bridge=RedditBridge&format=Atom`) instead of the native `.rss` link.

**I changed the embedding model and search got worse**
Vectors from different models aren't comparable. The plugin logs a dimension-mismatch / model-change warning and `manage_rss_feeds` (`action: "list"`) shows the model and dimension the cache was built with. Run `admin_rss_cache` with `action: "reembed"` (enable `enableAdminTools`, or use `reembed_all` when granular tools are exposed) with the new model loaded to rebuild the index.

**A feed keeps failing**
Repeated failures trigger exponential backoff (15 min → 24 h); `manage_rss_feeds` with `action: "list"` shows each feed's failure count and next retry time. Fix the URL, or run `manage_rss_feeds` with `action: "refresh"` and `force: true` to retry immediately.

📦 Changelog

**1.4.0**
- Pre-filtered hybrid retrieval: search filters resolve to an entry-ID allow-list first, and both FTS5 keyword lists and the vector scan (resident and streaming) only score in-scope articles — filtered searches scale with match count instead of cache size.
- Asymmetric embedding prefixes + heading breadcrumbs (embed style `contextual-v2`): chunks embed as `title | section breadcrumb` + body, queries/documents receive model-specific prefixes (`search_query:`/`search_document:` for nomic, `Represent this sentence…` for bge/mxbai/snowflake), and `<h1>`–`<h3>` are preserved as Markdown so each chunk knows its section. Older embed styles upgrade lazily (migrations 9–10; schema version 10).
- Agent-optimized tool surface: the default is 4 core tools (`search_rss_cache`, `get_rss_article`, `get_recent_cache_articles`, `manage_rss_feeds`). New full-article reader `get_rss_article` (by entry ID or URL, `offset`/`maxChars` paging, optional chunk layout), new multiplexed `manage_rss_feeds` (`list`/`add`/`remove`/`test`/`configure`/`refresh`), and new `admin_rss_cache` (`diagnostics`/`optimize`/`prune`/`reindex`/`reembed`/`debug_search`). `enableAdminTools` and `exposeGranularAdminTools` opt back into the admin and granular tools.
- Incremental in-memory vector index: appended chunks and removed articles update the resident matrix in place (tombstones + O(1) free list) instead of triggering a full rebuild, with `vectorIndexStats()` reporting live/tombstone/capacity counts.
- 64-bit SimHash: FNV-1a over 3-gram word shingles replaces the 32-bit hash with a ≤4-bit Hamming threshold, so syndicated articles with footer drift collapse while distinct short posts don't; legacy 32-bit fingerprints are backfilled on migration.
- Retrieval eval re-baselined after these changes (no regressions); new tests for the tool surface, prefix routing, chunking/breadcrumbs, the incremental index, and SimHash dedupe.

**1.3.0**
- Contextual chunk embeddings (prefix title to chunk before embedding) and background upgrade of stale chunks via `reindex_missing_embeddings`.
- Small-to-big context: each hit expands to neighbouring chunks (configurable via `contextChunks`).
- In-memory vector index: pre-normalised flat `Float32Array` with lazy rebuilds, zero per-query allocations, and a memory ceiling (`RSS_RAG_INDEX_MAX_MB`) falling back to the streaming SQL scan.
- Feed auto-discovery: `add_rss_feed` discovers `<link rel="alternate">` feeds from blog homepages; `test_feed` reports discovered alternates.
- Per-feed TTL overrides and `collection` labels (`feeds.json`), with retention honouring overrides and search supporting a `collection` filter.
- `search_rss_cache_debug` tool for ranking introspection; `cache_diagnostics` reports vector-index and embed-style coverage.
- Phase 0 eval harness (`lib/eval.js`, `npm run eval`, frozen corpus, deterministic baseline) for recall@1/3/5/10, MRR, nDCG@10, and latency.

**1.2.0**
- Hybrid retrieval rewritten around Reciprocal Rank Fusion of a trigram FTS5 list, a new `porter unicode61` BM25 FTS5 list, and a bounded vector scan.
- Structure-aware, sentence-boundary chunking with overlap (replaces fixed-window slicing).
- Content-change re-indexing: entries store a content hash, so edited articles (same GUID) are re-chunked and re-embedded.
- Improved article extraction (content selectors, boilerplate stripping, paragraph preservation, Open Graph fallback).
- Self-healing embeddings: bounded backfill at startup and after each refresh, bounded-concurrency embedding batches, and a query-embedding cache.
- Per-feed configuration via `feeds.json` (`enabled`, `tags`, `scrapeFullText`, `linkPatterns`, `maxItems`, `headers`) and a new `set_feed_options` tool.
- SimHash near-duplicate collapse for syndicated articles.
- Search filters (`days`/`after`/`before`, `feed`, `author`, `tag`), `relevance`/`date` sorting, and `limit`/`offset` pagination.
- New `cache_diagnostics` tool and a versioned `PRAGMA user_version` migration runner.
- Added a GitHub Actions CI workflow (typecheck + tests) and expanded the test suite to 18 tests.

**1.1.0**
- Conditional HTTP fetching (`If-None-Match` / `If-Modified-Since`) with per-feed exponential backoff, backed by a new `feeds_state` table.
- Embedding model/dimension tracking: mismatches are detected and warned about instead of silently degrading search; new `reembed_all` tool rebuilds the index after a model change.
- Retrieval quality: gentle recency blending, MMR diversity, and snippets windowed around the matching query terms.
- Automatic maintenance after each refresh (`PRAGMA optimize`, plus `VACUUM` only when enough free pages accumulate).
- `refresh_rss_feeds` accepts a `force` flag; `list_rss_feeds` reports per-feed health and the model/dimension the cache was built with.
- Expanded the test suite (conditional GET/304/backoff, `reembedAll`, ranking) and added a `npm run typecheck` script.

**1.0.0**
- Initial public release.
