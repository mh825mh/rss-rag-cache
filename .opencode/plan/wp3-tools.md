# WP-3 Task Specification: Atomic Tool Surface Consolidation

## Objectives
1. Implement `get_rss_article` in `src/toolsProvider.ts` to allow the LLM to inspect full article text and chunk sequences.
2. Implement `manage_rss_feeds` multiplexer (`list`, `add`, `remove`, `test`, `configure`, `refresh`).
3. Implement `admin_rss_cache` multiplexer (`diagnostics`, `optimize`, `prune`, `reindex`, `reembed`, `debug_search`).
4. Replace the hardcoded 14-tool return array with dynamic selection honoring `enableAdminTools` and `exposeGranularAdminTools`.
5. Maintain backward compatibility: export `CORE_TOOLS`, `ADMIN_TOOLS`, `GRANULAR_TOOLS`, and `ALL_TOOLS`.

---

## Target File: `src/toolsProvider.ts`

```typescript
import { getDb } from '../lib/db';
import {
  searchRssCache,
  searchRssCacheDebug,
  getRecentArticles,
  reindexMissing,
  reembedAll
} from '../lib/retriever';
import {
  listFeeds,
  addFeed,
  removeFeed,
  setFeedOptions,
  getSettings
} from '../lib/config';
import { refreshFeeds, testFeed } from '../lib/fetcher';
import { pruneRemovedFeeds, optimizeRssCache } from '../lib/retention';
import { getCacheDiagnostics } from '../lib/diagnostics';

export interface ToolParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  required?: string[];
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterSchema>;
    required?: string[];
  };
  run: (params: any) => Promise<unknown> | unknown;
  execute?: (params: any) => Promise<unknown> | unknown;
  handler?: (params: any) => Promise<unknown> | unknown;
}

export interface ToolsConfig {
  enableAdminTools?: boolean;
  exposeGranularAdminTools?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

export async function handleGetRssArticle(params: {
  entryId?: number;
  url?: string;
  maxChars?: number;
  offset?: number;
  includeChunks?: boolean;
}) {
  const entryId = params.entryId ? Number(params.entryId) : undefined;
  const url = params.url ? String(params.url).trim() : undefined;
  const maxChars = Math.min(Math.max(params.maxChars ?? 12000, 500), 50000);
  const offset = Math.max(params.offset ?? 0, 0);
  const includeChunks = Boolean(params.includeChunks);

  if (!entryId && !url) {
    return { error: 'Must provide either entryId (number) or url (string).' };
  }

  const db = getDb();
  let entry: any;
  if (entryId) {
    entry = db.prepare(`
      SELECT id, guid, feed_url, title, link, pub_date, author, tags, collection, content, cached_at
      FROM entries
      WHERE id = ?
    `).get(entryId);
  } else if (url) {
    entry = db.prepare(`
      SELECT id, guid, feed_url, title, link, pub_date, author, tags, collection, content, cached_at
      FROM entries
      WHERE link = ? OR guid = ?
      LIMIT 1
    `).get(url, url);
  }

  if (!entry) {
    return {
      found: false,
      message: `No article found matching ${entryId ? `id=${entryId}` : `url="${url}"`}`
    };
  }

  const rawContent = entry.content || '';
  const totalChars = rawContent.length;
  const slicedContent = rawContent.slice(offset, offset + maxChars);
  const hasMore = offset + maxChars < totalChars;

  let parsedTags: string[] = [];
  try {
    parsedTags = entry.tags ? JSON.parse(entry.tags) : [];
  } catch {
    parsedTags = entry.tags ? String(entry.tags).split(',').map((t: string) => t.trim()) : [];
  }

  const response: Record<string, unknown> = {
    found: true,
    article: {
      id: entry.id,
      title: entry.title,
      link: entry.link,
      guid: entry.guid,
      feedUrl: entry.feed_url,
      pubDate: entry.pub_date,
      author: entry.author || null,
      collection: entry.collection || null,
      tags: parsedTags,
      cachedAt: entry.cached_at,
      totalChars,
      offset,
      returnedChars: slicedContent.length,
      hasMore,
      nextOffset: hasMore ? offset + maxChars : null,
      content: slicedContent
    }
  };

  if (includeChunks) {
    const chunks = db.prepare(`
      SELECT chunk_index, text, embed_style
      FROM chunks
      WHERE entry_id = ?
      ORDER BY chunk_index ASC
    `).all(entry.id);
    response.chunks = chunks;
  }

  return response;
}

export async function handleManageRssFeeds(params: {
  action: 'list' | 'add' | 'remove' | 'test' | 'configure' | 'refresh';
  url?: string;
  options?: Record<string, unknown>;
  force?: boolean;
}) {
  const action = params.action;
  switch (action) {
    case 'list':
      return await listFeeds();

    case 'add':
      if (!params.url) return { error: 'url parameter is required for action "add".' };
      return await addFeed(params.url, params.options || {});

    case 'remove':
      if (!params.url) return { error: 'url parameter is required for action "remove".' };
      return await removeFeed(params.url);

    case 'test':
      if (!params.url) return { error: 'url parameter is required for action "test".' };
      return await testFeed(params.url);

    case 'configure':
      if (!params.url) return { error: 'url parameter is required for action "configure".' };
      return await setFeedOptions(params.url, params.options || {});

    case 'refresh':
      return await refreshFeeds({ force: Boolean(params.force) });

    default:
      return {
        error: `Unknown action: "${action}". Valid actions are: list, add, remove, test, configure, refresh.`
      };
  }
}

export async function handleAdminRssCache(params: {
  action: 'diagnostics' | 'optimize' | 'prune' | 'reindex' | 'reembed' | 'debug_search';
  query?: string;
  filters?: Record<string, unknown>;
  forceRechunk?: boolean;
}) {
  const action = params.action;
  switch (action) {
    case 'diagnostics':
      return await getCacheDiagnostics();

    case 'optimize':
      return await optimizeRssCache();

    case 'prune':
      return await pruneRemovedFeeds();

    case 'reindex':
      return await reindexMissing();

    case 'reembed':
      return await reembedAll({ forceRechunk: Boolean(params.forceRechunk) });

    case 'debug_search':
      if (!params.query) return { error: 'query parameter is required for action "debug_search".' };
      return await searchRssCacheDebug({
        query: params.query,
        ...(params.filters || {})
      });

    default:
      return {
        error: `Unknown action: "${action}". Valid actions are: diagnostics, optimize, prune, reindex, reembed, debug_search.`
      };
  }
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

function makeTool(def: ToolDefinition): ToolDefinition {
  def.execute = def.run;
  def.handler = def.run;
  return def;
}

export const searchRssCacheTool = makeTool({
  name: 'search_rss_cache',
  description: 'Hybrid search (BM25 + trigram + semantic vector) across cached RSS articles.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keywords or natural language question.' },
      topK: { type: 'number', description: 'Max articles to return (1-50, default 8).' },
      days: { type: 'number', description: 'Filter to articles published within the last N days.' },
      after: { type: 'string', description: 'ISO date string lower bound (e.g. 2026-01-01).' },
      before: { type: 'string', description: 'ISO date string upper bound.' },
      feed: { type: 'string', description: 'Filter by feed URL substring.' },
      author: { type: 'string', description: 'Filter by author substring.' },
      tag: { type: 'string', description: 'Filter by exact tag match.' },
      collection: { type: 'string', description: 'Filter by exact collection match.' }
    },
    required: ['query']
  },
  run: async (params) => await searchRssCache(params)
});

export const getRssArticleTool = makeTool({
  name: 'get_rss_article',
  description: 'Fetch the full text content, metadata, and chunk layout of a cached article by ID or URL.',
  parameters: {
    type: 'object',
    properties: {
      entryId: { type: 'number', description: 'The numeric article ID returned by search.' },
      url: { type: 'string', description: 'The canonical article link or GUID.' },
      maxChars: { type: 'number', description: 'Max characters to return (default 12000, max 50000).' },
      offset: { type: 'number', description: 'Character offset for paginating long articles (default 0).' },
      includeChunks: { type: 'boolean', description: 'Whether to include chunk index and raw chunk texts.' }
    }
  },
  run: async (params) => await handleGetRssArticle(params)
});

export const getRecentCacheArticlesTool = makeTool({
  name: 'get_recent_cache_articles',
  description: 'Get the most recently cached or published articles across all feeds.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Number of articles to return (default 10, max 50).' },
      feed: { type: 'string', description: 'Optional feed URL filter substring.' },
      collection: { type: 'string', description: 'Optional collection filter.' }
    }
  },
  run: async (params) => await getRecentArticles(params)
});

export const manageRssFeedsTool = makeTool({
  name: 'manage_rss_feeds',
  description: 'Manage RSS/Atom feeds: list feeds, add new feeds, remove feeds, test discovery, configure overrides, or refresh.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'test', 'configure', 'refresh'],
        description: 'Operation to perform.'
      },
      url: { type: 'string', description: 'Target feed or homepage URL (required for add, remove, test, configure).' },
      options: {
        type: 'object',
        description: 'Feed options for add/configure (tags, collection, scrapeFullText, retentionDays, enabled).'
      },
      force: { type: 'boolean', description: 'For refresh: bypass backoff and conditional HTTP validators.' }
    },
    required: ['action']
  },
  run: async (params) => await handleManageRssFeeds(params)
});

export const adminRssCacheTool = makeTool({
  name: 'admin_rss_cache',
  description: 'Administrative cache operations: health diagnostics, VACUUM/optimize, prune orphaned feeds, reindex missing embeddings, re-embed all, or run debug search.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['diagnostics', 'optimize', 'prune', 'reindex', 'reembed', 'debug_search'],
        description: 'Maintenance action to run.'
      },
      query: { type: 'string', description: 'Search query for debug_search action.' },
      filters: { type: 'object', description: 'Search filters for debug_search action.' },
      forceRechunk: { type: 'boolean', description: 'For reembed: re-chunk article text before re-embedding.' }
    },
    required: ['action']
  },
  run: async (params) => await handleAdminRssCache(params)
});

// Granular tools (preserved for backwards compatibility and explicit debugging)
export const searchRssCacheDebugTool = makeTool({
  name: 'search_rss_cache_debug',
  description: 'Search with detailed RRF candidate rankings, BM25/trigram scores, and cosine similarities.',
  parameters: searchRssCacheTool.parameters,
  run: async (params) => await searchRssCacheDebug(params)
});

export const refreshRssFeedsTool = makeTool({
  name: 'refresh_rss_feeds',
  description: 'Manually trigger RSS feed refresh.',
  parameters: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: 'Bypass HTTP conditional headers and backoff.' }
    }
  },
  run: async (params) => await refreshFeeds(params)
});

export const listRssFeedsTool = makeTool({
  name: 'list_rss_feeds',
  description: 'List all configured feeds with fetch state, health, and entry counts.',
  parameters: { type: 'object', properties: {} },
  run: async () => await listFeeds()
});

export const addRssFeedTool = makeTool({
  name: 'add_rss_feed',
  description: 'Add a feed URL or homepage URL with auto-discovery.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Feed URL or website homepage.' },
      tags: { type: 'array', items: { type: 'string' } },
      collection: { type: 'string' },
      scrapeFullText: { type: 'boolean' }
    },
    required: ['url']
  },
  run: async (params) => await addFeed(params.url, params)
});

export const removeRssFeedTool = makeTool({
  name: 'remove_rss_feed',
  description: 'Remove a feed from configuration.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Feed URL to remove.' }
    },
    required: ['url']
  },
  run: async (params) => await removeFeed(params.url)
});

export const testFeedTool = makeTool({
  name: 'test_feed',
  description: 'Test a feed or discover feeds on a homepage without adding.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to test.' }
    },
    required: ['url']
  },
  run: async (params) => await testFeed(params.url)
});

export const setFeedOptionsTool = makeTool({
  name: 'set_feed_options',
  description: 'Set per-feed override options in feeds.json.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Feed URL.' },
      options: { type: 'object', description: 'Options to set.' }
    },
    required: ['url', 'options']
  },
  run: async (params) => await setFeedOptions(params.url, params.options)
});

export const pruneRemovedFeedsTool = makeTool({
  name: 'prune_removed_feeds',
  description: 'Delete cached articles from feeds no longer configured.',
  parameters: { type: 'object', properties: {} },
  run: async () => await pruneRemovedFeeds()
});

export const reindexMissingEmbeddingsTool = makeTool({
  name: 'reindex_missing_embeddings',
  description: 'Scan cache for chunks missing vector embeddings and embed them.',
  parameters: { type: 'object', properties: {} },
  run: async () => await reindexMissing()
});

export const reembedAllTool = makeTool({
  name: 'reembed_all',
  description: 'Rebuild the entire vector index from scratch.',
  parameters: {
    type: 'object',
    properties: {
      forceRechunk: { type: 'boolean', description: 'Re-chunk article text before embedding.' }
    }
  },
  run: async (params) => await reembedAll(params)
});

export const optimizeRssCacheTool = makeTool({
  name: 'optimize_rss_cache',
  description: 'Run SQLite VACUUM, ANALYZE, and WAL checkpoint.',
  parameters: { type: 'object', properties: {} },
  run: async () => await optimizeRssCache()
});

export const cacheDiagnosticsTool = makeTool({
  name: 'cache_diagnostics',
  description: 'Get health report, chunk stats, embedding coverage, and vector index status.',
  parameters: { type: 'object', properties: {} },
  run: async () => await getCacheDiagnostics()
});

// ---------------------------------------------------------------------------
// Tool Collections & Export Resolution
// ---------------------------------------------------------------------------

export const CORE_TOOLS: ToolDefinition[] = [
  searchRssCacheTool,
  getRssArticleTool,
  getRecentCacheArticlesTool,
  manageRssFeedsTool
];

export const ADMIN_TOOLS: ToolDefinition[] = [
  adminRssCacheTool
];

export const GRANULAR_TOOLS: ToolDefinition[] = [
  searchRssCacheDebugTool,
  refreshRssFeedsTool,
  listRssFeedsTool,
  addRssFeedTool,
  removeRssFeedTool,
  testFeedTool,
  setFeedOptionsTool,
  pruneRemovedFeedsTool,
  reindexMissingEmbeddingsTool,
  reembedAllTool,
  optimizeRssCacheTool,
  cacheDiagnosticsTool
];

export const ALL_TOOLS: ToolDefinition[] = [
  ...CORE_TOOLS,
  ...ADMIN_TOOLS,
  ...GRANULAR_TOOLS
];

/**
 * Returns active tool set based on plugin configuration.
 * Default: 4 core tools (search, article reader, recent articles, feed management).
 */
export function getTools(config?: ToolsConfig): ToolDefinition[] {
  let settings: ToolsConfig = {};
  try {
    settings = (getSettings() as ToolsConfig) || {};
  } catch {
    settings = {};
  }
  const merged = { ...settings, ...(config || {}) };

  const tools: ToolDefinition[] = [...CORE_TOOLS];

  if (Boolean(merged.enableAdminTools)) {
    tools.push(...ADMIN_TOOLS);
  }

  if (Boolean(merged.exposeGranularAdminTools)) {
    tools.push(...GRANULAR_TOOLS);
  }

  return tools;
}

export default getTools;