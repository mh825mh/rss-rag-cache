import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

export function parseRss(xml, feedUrl) {
  const doc = parser.parse(xml);
  const items = [];

  // RSS 2.0
  const rssItems = doc?.rss?.channel?.item;
  if (Array.isArray(rssItems)) {
    for (const it of rssItems) items.push(normalizeRssItem(it, feedUrl));
  } else if (rssItems) {
    items.push(normalizeRssItem(rssItems, feedUrl));
  }

  // Atom
  const atomEntries = doc?.feed?.entry;
  if (Array.isArray(atomEntries)) {
    for (const it of atomEntries) items.push(normalizeAtomItem(it, feedUrl));
  } else if (atomEntries) {
    items.push(normalizeAtomItem(atomEntries, feedUrl));
  }

  return items;
}

function firstOf(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

function normalizeRssItem(it, feedUrl) {
  const link = firstOf(it.link);
  const guid = it.guid ?? link ?? `${feedUrl}#${it.title}`;
  return {
    guid: String(guid),
    feed_url: feedUrl,
    title: it.title ?? "",
    link: typeof link === "object" ? link?.["#text"] ?? "" : link ?? "",
    author: it["dc:creator"] ?? it.author ?? "",
    pub_date: it.pubDate ? Date.parse(it.pubDate) : Date.now(),
    summary: it.description ?? "",
    content: it["content:encoded"] ?? it.description ?? "",
  };
}

function normalizeAtomItem(it, feedUrl) {
  const linkEl = Array.isArray(it.link) ? it.link.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") : it.link;
  const link = typeof linkEl === "object" ? linkEl?.["@_href"] ?? "" : linkEl ?? "";
  const guid = it.id ?? link ?? `${feedUrl}#${it.title}`;
  return {
    guid: String(guid),
    feed_url: feedUrl,
    title: it.title ?? "",
    link,
    author: it.author?.name ?? "",
    pub_date: it.updated ? Date.parse(it.updated) : Date.now(),
    summary: it.summary ?? "",
    content: it.content?._ ?? it.content ?? it.summary ?? "",
  };
}