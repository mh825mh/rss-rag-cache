// OPML (Outline Processor Markup Language) — the standard interchange format
// for feed subscriptions, understood by essentially every RSS reader.
//
// `exportOpml` renders the current feed list; `parseOpml` accepts any
// OPML 1.x/2.0 document and returns candidate feeds. Nested folder outlines
// are flattened; `category` attributes, collection folders and feed title
// `text` attributes are carried through where present. We already ship
// fast-xml-parser, so no new dependency is needed.

import { XMLParser } from "fast-xml-parser";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attrArray(tags) {
  return Array.isArray(tags) ? tags : tags ? String(tags).split(",") : [];
}

// Renders one feed entry as an outline. `collection` nests under a folder
// outline; searxng query feeds get their synthetic URL like any other feed.
function outlineXml(f) {
  const parts = [`type="rss"`, `xmlUrl="${esc(f.url)}"`];
  if (f.title && f.title !== f.url) parts.push(`text="${esc(f.title)}"`, `title="${esc(f.title)}"`);
  const tags = attrArray(f.tags);
  if (tags.length) parts.push(`category="${esc(tags.join(","))}"`);
  return `    <outline ${parts.join(" ")} />`;
}

export function exportOpml(feedConfigs = [], { title = "RSS RAG Cache" } = {}) {
  const byCollection = new Map();
  const plain = [];
  for (const f of feedConfigs) {
    if (!f?.url) continue;
    if (f.collection) {
      const bucket = byCollection.get(f.collection) || [];
      bucket.push({ ...f, title: f.title || f.url });
      byCollection.set(f.collection, bucket);
    } else {
      plain.push({ ...f, title: f.title || f.url });
    }
  }

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="2.0">`,
    `  <head><title>${esc(title)}</title></head>`,
    `  <body>`,
  ];
  for (const f of plain) lines.push(`    ${outlineXml(f).trimStart()}`);
  for (const [collection, feeds] of byCollection) {
    lines.push(`    <outline text="${esc(collection)}">`);
    for (const f of feeds) lines.push(`      ${outlineXml(f).trimStart()}`);
    lines.push(`    </outline>`);
  }
  lines.push(`  </body>`, `</opml>`, "");
  return lines.join("\n");
}

// Accepts an OPML string and returns { url, title?, tags?[] } candidates.
// Malformed XML resolves to an empty list (the caller reports counts), and
// entries without an xmlUrl (folder outlines) are skipped.
export function parseOpml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: () => false, // singletons are normalized below
  });
  let doc;
  try {
    doc = parser.parse(String(xml ?? ""));
  } catch {
    return [];
  }
  const root = doc?.opml ?? doc?.OPML ?? doc; // some producers emit <OPML>
  const body = root?.body;
  if (!body) return [];

  const out = [];
  const seen = new Set();
  const walk = (node) => {
    // outline can be one node or a list; normalize.
    const list = Array.isArray(node) ? node : [node];
    for (const o of list) {
      if (!o) continue;
      const xmlUrl = o["@_xmlUrl"] || o["@_xmlurl"] || "";
      if (xmlUrl) {
        const url = String(xmlUrl).trim();
        if (url && !seen.has(url)) {
          seen.add(url);
          const title = o["@_title"] || o["@_text"] || "";
          const cat = o["@_category"] || "";
          const tags = cat ? cat.split(",").map((t) => t.trim()).filter(Boolean) : [];
          out.push({ url, title: String(title).trim(), tags });
        }
      }
      if (o.outline) walk(o.outline);
    }
  };
  walk(body.outline);
  return out;
}
