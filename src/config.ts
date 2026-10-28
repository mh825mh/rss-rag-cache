import { createConfigSchematics } from "@lmstudio/sdk";

// Per-chat settings: only knobs that legitimately vary per conversation.
export const configSchematics = createConfigSchematics()
  .field(
    "topK",
    "numeric",
    {
      displayName: "Search Results (Top K)",
      subtitle: "How many unique articles to return per search.",
      min: 1,
      max: 50,
      int: true,
      slider: { step: 1, min: 1, max: 20 },
    },
    8,
  )
  .build();

// Global settings: they configure the shared cache/index, so they apply to the
// plugin as a whole rather than to a single chat.
export const globalConfigSchematics = createConfigSchematics()
  .field(
    "retentionDays",
    "select",
    {
      displayName: "Retention Period",
      subtitle: "How long to keep cached RSS entries in the local database.",
      options: [
        { value: "30", displayName: "30 Days" },
        { value: "60", displayName: "60 Days" },
        { value: "90", displayName: "90 Days" },
        { value: "365", displayName: "365 Days" },
      ],
    },
    "90",
  )
  .field(
    "refreshIntervalHours",
    "numeric",
    {
      displayName: "Refresh Interval (Hours)",
      subtitle: "How often to automatically fetch new RSS items.",
      min: 1,
      max: 168,
      int: true,
      slider: { step: 1, min: 1, max: 24 },
    },
    6,
  )
  .field(
    "embeddingModel",
    "select",
    {
      displayName: "Embedding Model",
      subtitle: "The embedding model loaded in LM Studio server.",
      options: [
        { value: "nomic-embed-text-v1.5", displayName: "nomic-embed-text-v1.5" },
        { value: "text-embedding-nomic-embed-text-v1.0", displayName: "text-embedding-nomic-embed-text-v1.0" },
        { value: "bge-large-en-v1.5", displayName: "bge-large-en-v1.5" },
        { value: "all-MiniLM-L6-v2", displayName: "all-MiniLM-L6-v2" }
      ],
    },
    "nomic-embed-text-v1.5",
  )
  .field(
    "chunkSize",
    "numeric",
    {
      displayName: "Chunk Size (characters)",
      subtitle: "Article text is split into overlapping chunks of this length.",
      min: 200,
      max: 3000,
      int: true,
      slider: { step: 100, min: 200, max: 3000 },
    },
    800,
  )
  .field(
    "contextualChunks",
    "boolean",
    {
      displayName: "Contextual Chunk Embeddings",
      subtitle: "Prefix each chunk with its article title before embedding. Improves recall on summary-only feeds; changing it re-embeds the cache.",
    },
    true,
  )
  .field(
    "contextChunks",
    "numeric",
    {
      displayName: "Neighbouring Chunks (Context)",
      subtitle: "How many adjacent chunks to include around each search hit, for extra context (0–2).",
      min: 0,
      max: 2,
      int: true,
      slider: { step: 1, min: 0, max: 2 },
    },
    1,
  )
  .field(
    "embedBatchSize",
    "numeric",
    {
      displayName: "Embedding Batch Size",
      subtitle: "How many chunks to send to the embedding model per request.",
      min: 1,
      max: 128,
      int: true,
      slider: { step: 1, min: 1, max: 64 },
    },
    16,
  )
  .field(
    "embedConcurrency",
    "numeric",
    {
      displayName: "Embedding Concurrency",
      subtitle: "How many embedding requests to run in parallel during indexing/backfill.",
      min: 1,
      max: 16,
      int: true,
      slider: { step: 1, min: 1, max: 8 },
    },
    3,
  )
  .field(
    "maxConcurrentFeeds",
    "numeric",
    {
      displayName: "Concurrent Feed Fetches",
      subtitle: "How many RSS/Atom feeds to fetch at the same time (across all hosts).",
      min: 1,
      max: 32,
      int: true,
      slider: { step: 1, min: 1, max: 16 },
    },
    4,
  )
  .field(
    "maxConcurrentPerHost",
    "numeric",
    {
      displayName: "Concurrent Requests Per Host",
      subtitle: "Cap on simultaneous requests to any single domain. Low values are what keep anti-bot firewalls calm.",
      min: 1,
      max: 16,
      int: true,
      slider: { step: 1, min: 1, max: 8 },
    },
    2,
  )
  .field(
    "minRequestGapMs",
    "numeric",
    {
      displayName: "Min Gap Between Requests (ms)",
      subtitle: "Minimum delay between two requests to the same host. Higher = safer, slower.",
      min: 200,
      max: 30000,
      int: true,
      slider: { step: 100, min: 200, max: 10000 },
    },
    1500,
  )
  .field(
    "requestGapJitterMs",
    "numeric",
    {
      displayName: "Request Gap Jitter (ms)",
      subtitle: "Random extra delay added to each gap so the crawl pattern is not perfectly regular.",
      min: 0,
      max: 30000,
      int: true,
      slider: { step: 100, min: 0, max: 10000 },
    },
    1500,
  )
  .field(
    "respectRobotsTxt",
    "boolean",
    {
      displayName: "Respect robots.txt",
      subtitle: "Check robots.txt before scraping HTML pages or fetching full article text. Recommended.",
    },
    true,
  )
  .field(
    "contactUserAgent",
    "string",
    {
      displayName: "Contact Info (User-Agent)",
      subtitle: "Optional contact URL/email appended to the User-Agent so site owners can reach you instead of blocking you.",
      placeholder: "https://example.com/bot or you@example.com",
    },
    "",
  )
  .field(
    "semanticScanLimit",
    "numeric",
    {
      displayName: "Semantic Scan Limit",
      subtitle: "Maximum chunks scanned per semantic search. Higher = better recall, slower searches.",
      min: 1000,
      max: 1000000,
      int: true,
      slider: { step: 1000, min: 1000, max: 200000 },
    },
    50000,
  )
  .field(
    "htmlLinkPatterns",
    "string",
    {
      displayName: "HTML Link Keywords",
      subtitle: "Comma-separated URL keywords used when scraping non-RSS pages.",
      placeholder: "news,article,post,blog,stories,press",
    },
    "news,article,post,blog,stories,press",
  )
  .field(
    "scrapeFullText",
    "boolean",
    {
      displayName: "Fetch Full Article Text",
      subtitle: "For scraped HTML pages, also download each article body (slower refresh).",
    },
    false,
  )
  .field(
    "retentionBasis",
    "select",
    {
      displayName: "Retention Basis",
      subtitle: "Whether old entries are removed by publish date or cache date.",
      options: [
        { value: "publish_date", displayName: "Publish date (recommended)" },
        { value: "cached_at", displayName: "Cached date" },
      ],
    },
    "publish_date",
  )
  .field(
    "refreshOnStartup",
    "boolean",
    {
      displayName: "Refresh on Startup",
      subtitle: "Automatically fetch feeds when the plugin loads.",
    },
    true,
  )
  .field(
    "lmStudioBaseUrl",
    "string",
    {
      displayName: "LM Studio Base URL",
      subtitle: "Where the embedding model is served.",
      placeholder: "http://localhost:1234",
    },
    "http://localhost:1234",
  )
  .field(
    "enableAdminTools",
    "boolean",
    {
      displayName: "Enable Admin Tools",
      subtitle: "Expose admin_rss_cache (diagnostics, optimize, prune, reindex, reembed, debug search). Off by default.",
    },
    false,
  )
  .field(
    "exposeGranularAdminTools",
    "boolean",
    {
      displayName: "Expose Granular Admin Tools",
      subtitle: "Also register legacy individual admin/feed tools. Off by default; prefer manage_rss_feeds/admin_rss_cache.",
    },
    false,
  )
  .field(
    "searxngBaseUrl",
    "string",
    {
      displayName: "SearXNG Base URL (Local)",
      subtitle: "Optional local SearXNG instance, e.g. http://localhost:8080. Enables query feeds ('subscribe to a topic'), web-result backfill into the cache, and feed discovery. Empty = disabled.",
      placeholder: "http://localhost:8080",
    },
    "",
  )
  .field(
    "webFallback",
    "boolean",
    {
      displayName: "Live Web Fallback On Cache Miss",
      subtitle: "When a cache search returns no results, also run the query through local SearXNG and return web results (title + URL + snippet only) so the model can still answer honestly. Requires SearXNG json format enabled.",
    },
    false,
  )
  .field(
    "webSourceRetentionDays",
    "numeric",
    {
      displayName: "Web-Sourced Entry Retention (Days)",
      subtitle: "How long entries backfilled from the web into the cache are kept before they expire (they never outlive regular feeds).",
      min: 1,
      max: 365,
      int: true,
      slider: { step: 1, min: 1, max: 90 },
    },
    14,
  )
  .field(
    "rerankDocs",
    "numeric",
    {
      displayName: "Rerank Shortlist (0 = Off)",
      subtitle: "If a reranker model is loaded in LM Studio, re-rank this many fused candidates per search for higher precision on ambiguous queries. Falls back silently when no reranker is loaded.",
      min: 0,
      max: 200,
      int: true,
      slider: { step: 10, min: 0, max: 100 },
    },
    0,
  )
  .build();
