// Single source of truth for which LM Studio tools the plugin registers.
// Default surface is small (4 core tools) to keep tool-schema token overhead low.
export const CORE_TOOLS = [
  "search_rss_cache",
  "get_rss_article",
  "get_recent_cache_articles",
  "manage_rss_feeds",
];

export const ADMIN_TOOL = "admin_rss_cache";

export const GRANULAR_TOOLS = [
  "refresh_rss_feeds",
  "list_rss_feeds",
  "add_rss_feed",
  "remove_rss_feed",
  "test_feed",
  "set_feed_options",
  "prune_removed_feeds",
  "reindex_missing_embeddings",
  "reembed_all",
  "optimize_rss_cache",
  "search_rss_cache_debug",
  "cache_diagnostics",
];

export function resolveToolSurface({ enableAdminTools = false, exposeGranularAdminTools = false, granular = false } = {}) {
  const names = [...CORE_TOOLS];
  if (enableAdminTools || granular) names.push(ADMIN_TOOL);
  if (exposeGranularAdminTools || granular) names.push(...GRANULAR_TOOLS);
  return names;
}