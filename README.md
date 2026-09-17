📡 RSS RAG Cache Plugin for LM Studio

Turn LM Studio into your own private, intelligent news archive. This plugin fetches your favorite RSS feeds, chunks the articles, embeds them using your local LM Studio server, and stores them in a local SQLite database for Retrieval-Augmented Generation (RAG). 

Instead of searching the web, your LLM can instantly query your local cache of recent articles, blog posts, and newsletters.
✨ Features

    Local RAG Pipeline: Fetches RSS feeds, chunks text, and generates embeddings via LM Studio's local server.
    Hybrid Search: Combines SQLite FTS5 (keyword search) with Vector Cosine Similarity (semantic search). If the embedding model is offline, it automatically falls back to pure keyword search.
    Auto-HTML Scraper (Cheerio): If a URL doesn't have an RSS feed (like a standard news webpage), the plugin automatically scrapes the page for article links using Cheerio.
    Smart Throttling: Fetches standard RSS feeds instantly and concurrently, but uses a 1.5–3 second randomized delay when scraping HTML pages to bypass 403 Forbidden firewalls and look like a human user.
    Configurable Retention: Automatically cleans up old data. Keep your cache for 30, 60, 90, or 365 days.
    Native SQLite Database: Uses Node.js's built-in node:sqlite module. No C++ addons or Visual Studio build tools required!
    Safe Data Storage: Stores your feeds.txt and cache.db in ~/.lmstudio/plugin-data/rss-rag-cache/ so they survive plugin updates.

📋 Requirements

    LM Studio: Running the local server.
    Embedding Model: You must download and load an embedding model in LM Studio (e.g., nomic-embed-text-v1.5) and start the local server on port 1234.
    Node.js v22+: Requires Node version 22 or higher for native SQLite support.

🚀 Installation

    Download or install this plugin directly from the LM Studio Plugin Hub.
    Ensure LM Studio is running an embedding model on the Local Server.
    The plugin will automatically create a feeds.txt file in your plugin-data folder on the first run.

⚙️ Configuration
1. Adding Feeds (feeds.txt)

Your feeds file is located at:

    Windows: C:\Users\YOUR_USERNAME\.lmstudio\plugin-data\rss-rag-cache\feeds.txt
    Mac/Linux: ~/.lmstudio/plugin-data/rss-rag-cache/feeds.txt

Add one RSS/Atom URL per line. You can also add standard webpage URLs (the plugin will scrape them automatically). Lines starting with # are ignored.

# Standard RSS Feedshttps://news.ycombinator.com/rsshttps://www.theverge.com/rss/index.xml# Non-RSS Webpages (Will be scraped automatically with slow loading) https://www.*.com/news/.../news/

2. Plugin Settings UI

You can adjust these values in the LM Studio plugin settings panel:
Setting
	
Default
	
Description
retentionDays	90	How long to keep articles (30, 60, 90, or 365 days).
refreshIntervalHours	6	How often the plugin automatically fetches new RSS items in the background.
embeddingModel	nomic-embed-text-v1.5	The exact model ID loaded in your LM Studio server.
  
🛠️ LM Studio Tools

The plugin exposes three tools to the LLM:
refresh_rss_feeds

Force-refreshes all feeds listed in feeds.txt, indexes new items, generates embeddings, and applies the retention policy. Returns a detailed report of successes, failures, and added articles.

     

    Example LLM prompt: "Refresh my RSS feeds."

search_rss_cache

Performs a hybrid (keyword + semantic) search over your cached RSS articles. 

     

    Example LLM prompt: "Search my RSS cache for recent updates about the Rust programming language."

list_rss_feeds

Lists all currently configured RSS URLs and basic database stats (total entries, total chunks, oldest/newest dates).

     

    Example LLM prompt: "Show me my RSS cache stats."

🧠 How It Works

    Fetch & Parse: The plugin pulls XML data from your URLs. If a URL returns HTML, it uses Cheerio to scrape the page for article links.
    Throttling: RSS feeds are fetched concurrently for speed. HTML pages are fetched one-by-one with a 1.5-3 second delay to avoid triggering anti-bot firewalls.
    Chunking: Article content is split into ~800-character overlapping chunks to fit context windows.
    Embedding: Chunks are sent to LM Studio's /v1/embeddings endpoint.
    Storage: Text, metadata, and vector embeddings (stored as BLOBs) are saved in a local cache.db SQLite file.
    Retrieval: When the LLM searches, the plugin finds the best matching chunks using FTS5 (for exact keywords) and Cosine Similarity (for semantic meaning), passing the best results back to the LLM as context.

🐛 Troubleshooting

Search returns 0 matches
Ensure your embedding model is loaded and the server is running. If the model is offline, the plugin will fall back to keyword search, but if your articles don't contain the exact keywords, they won't be found. You can run list_rss_feeds to check if chunks is greater than 0.

HTTP 403 Forbidden on a feed
Some websites block automated requests. The plugin uses a Chrome User-Agent and throttles HTML requests, but strict firewalls might still block it. If this happens, you may need to find an alternative RSS URL or use an RSS Bridge service.

HTTP 429 Too Many Requests
Sites like Reddit aggressively block Node.js fetch requests. If this happens, you must use an RSS Bridge URL (e.g., https://rss-bridge.org/bridge01/?action=display&bridge=RedditBridge&context=by subreddit&r=NewportSW&format=Atom) instead of the native .rss link.