RSS RAG Cache Plugin for LM Studio

Turn LM Studio into your own private, intelligent news archive. This plugin fetches your favorite RSS feeds, chunks the articles, embeds them using your local LM Studio server, and stores them in a local SQLite database for Retrieval-Augmented Generation (RAG). 

Instead of searching the web, your LLM can instantly query your local cache of recent articles, blog posts, and newsletters.
✨ Features

     Local RAG Pipeline: Fetches RSS feeds, chunks text, and generates embeddings via LM Studio's local server.
     Hybrid Search: Combines SQLite FTS5 (keyword search) with Vector Cosine Similarity (semantic search) for highly accurate retrieval.
     Configurable Retention: Automatically cleans up old data. Keep your cache for 30, 60, 90, or 365 days.
     Zero-Compilation Database: Uses Node.js's built-in node:sqlite module. No native C++ addons or Visual Studio build tools required!
     Simple Configuration: Just paste your RSS URLs into a plain text feeds.txt file.
     Automatic Refresh: Background timer fetches new articles at a configurable interval.

📋 Requirements

    LM Studio: Running the local server.
    Embedding Model: You must download and load an embedding model in LM Studio (e.g., nomic-embed-text-v1.5) and start the local server on port 1234.
    Node.js v22+: Requires Node version 22 or higher (Node 24+ recommended for native SQLite support without flags).

🚀 Installation

    Download or clone this plugin folder into your LM Studio plugins directory.
    Open a terminal in the plugin folder.
    Run npm install to download the XML parser dependency.
    Ensure LM Studio is running an embedding model on the Local Server.

⚙️ Configuration
1. Adding Feeds (feeds.txt)

Open the feeds.txt file in the plugin root directory. Add one RSS/Atom URL per line. Lines starting with # are ignored.
text
 
  
 
 
# Tech News
https://news.ycombinator.com/rss
https://www.theverge.com/rss/index.xml

# Dev Blogs
https://blog.rust-lang.org/feed.xml
 
 
2. Settings (settings.json & plugin.json)

You can adjust these values in settings.json or via the LM Studio plugin UI:
Setting
	
Default
	
Description
retentionDays	90	How long to keep articles (30, 60, 90, or 365 days).
refreshIntervalHours	6	How often the plugin automatically fetches new RSS items.
embeddingModel	nomic-embed-text-v1.5	The exact model ID loaded in your LM Studio server.
topK	8	How many text chunks the retriever returns to the LLM per query.
  
🛠️ LM Studio Tools

The plugin exposes three tools to the LLM:
refresh_rss_feeds

Force-refreshes all feeds listed in feeds.txt, indexes new items, generates embeddings, and applies the retention policy (deletes old articles).

     

    Example LLM prompt: "Refresh my RSS feeds."

search_rss_cache

Performs a hybrid (keyword + semantic) search over your cached RSS articles. 

     

    Example LLM prompt: "Search my RSS cache for recent updates about the Rust programming language."

list_rss_feeds

Lists all currently configured RSS URLs and basic database stats (total entries, total chunks, oldest/newest dates).

     

    Example LLM prompt: "Show me my RSS cache stats."

🧠 How It Works

    Fetch & Parse: The plugin pulls XML data from your URLs and extracts titles, links, authors, and content.
    Chunking: Article content is split into ~800-character overlapping chunks to fit context windows.
    Embedding: Chunks are sent to LM Studio's /v1/embeddings endpoint.
    Storage: Text, metadata, and vector embeddings (stored as BLOBs) are saved in a local cache.db SQLite file.
    Retrieval: When the LLM searches, the plugin finds the best matching chunks using FTS5 (for exact keywords) and Cosine Similarity (for semantic meaning), passing the best results back to the LLM as context.

📁 Project Structure
text
 
  
 
 
rss-rag-cache/
├── plugin.json          # LM Studio plugin definition & settings schema
├── package.json         # Node dependencies
├── index.js             # Plugin entry point & tool definitions
├── feeds.txt            # <-- Add your RSS URLs here
├── settings.json        # User configuration
├── data/
│   └── cache.db         # Auto-generated SQLite database (ignored by git)
└── lib/
    ├── config.js        # Loads settings and feeds.txt
    ├── db.js            # Native Node SQLite setup
    ├── parser.js        # XML to JSON parser
    ├── fetcher.js       # HTTP fetcher
    ├── embedder.js      # LM Studio API calls & math functions
    ├── retriever.js     # RAG logic (chunking, indexing, searching)
    └── retention.js     # Database cleanup logic
 
 
🐛 Troubleshooting

"Error: Cannot find module 'node:sqlite'"
You are using an older version of Node.js. Update to Node v22 or v24. If you are on v22, you may need to start Node with the --experimental-sqlite flag.

Embedding errors / Connection refused
Ensure LM Studio is open, an embedding model is loaded, and the Local Server is running and accessible at http://localhost:1234.

No articles found when searching
Run the refresh_rss_feeds tool first to populate the database. You can ask the LLM: "Please refresh my feeds and then list the stats."