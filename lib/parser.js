import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", deg: "°", copy: "©", reg: "®", trade: "™",
  middot: "·", bull: "•", permil: "‰", euro: "€", pound: "£",
  yen: "¥", cent: "¢", szlig: "ß", aacute: "á", eacute: "é",
  iacute: "í", oacute: "ó", uacute: "ú", agrave: "à", egrave: "è",
  igrave: "ì", ograve: "ò", ugrave: "ù", ntilde: "ñ", ccedil: "ç",
};

export function decodeEntities(str) {
  if (!str) return "";
  let prev = "";
  let out = str;
  let guard = 0;
  while (out !== prev && guard < 5) {
    prev = out;
    out = out
      .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h) => safeCodePoint(parseInt(h, 16)))
      .replace(/&#(\d{1,7});/g, (_, d) => safeCodePoint(parseInt(d, 10)))
      .replace(/&([a-zA-Z][a-zA-Z0-9]{1,15});/g, (m, n) => NAMED_ENTITIES[n] ?? m);
    guard++;
  }
  return out;
}

function safeCodePoint(n) {
  try {
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

function stripTags(html) {
  return decodeEntities(html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
    .replace(/<[^>]*>/g, "")
    .trim();
}

function safeTimestamp(ts) {
  return Number.isFinite(ts) ? ts : Date.now();
}

export function titleKey(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 200);
}

// ---------- Structured RSS/Atom parsing (fast-xml-parser) ----------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

const asArray = (v) => (v == null ? null : Array.isArray(v) ? v : [v]);

function clean(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") return clean(v["#text"] ?? "");
  return String(v);
}

function rawText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return rawText(v["#text"]);
  return String(v);
}

function hrefAttr(v) {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return "";
  return typeof v["@_href"] === "string" ? v["@_href"].trim() : "";
}

export function parseRss(xml, feedUrl) {
  let parsed;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return parseRssLegacy(xml, feedUrl);
  }

  const items = [];
  try {
    if (parsed && parsed.rss && parsed.rss.channel) {
      const channel = parsed.rss.channel;
      const list = asArray(channel.item) || [];
      for (const it of list) {
        const title = clean(it.title);
        let link = clean(it.link);
        if (!link) link = hrefAttr(it.link);
        const guid = clean(it.guid) || link || `${feedUrl}#${title}`;
        const desc = rawText(it.description);
        const contentRaw = rawText(it["content:encoded"]) || desc || "";
        const pub = it.pubDate ?? it["dc:date"];
        items.push({
          guid: String(guid),
          feed_url: feedUrl,
          title,
          link,
          author: clean(it["dc:creator"]) || clean(it.author),
          pub_date: pub ? safeTimestamp(Date.parse(pub)) : Date.now(),
          summary: stripTags(desc),
          content: stripTags(contentRaw),
        });
      }
    } else if (parsed && parsed.feed) {
      const list = asArray(parsed.feed.entry) || [];
      for (const e of list) {
        const title = clean(e.title);
        let link = "";
        for (const l of asArray(e.link) || []) {
          if (typeof l === "string") { link = l; break; }
          const href = hrefAttr(l);
          const rel = typeof l["@_rel"] === "string" ? l["@_rel"] : "";
          if (href && (!rel || rel === "alternate")) { link = href; break; }
        }
        const updated = e.updated ?? e.published;
        const authors = asArray(e.author) || [];
        const contentRaw = typeof e.content === "string" ? e.content : rawText(e.content ?? e.summary);
        items.push({
          guid: String(clean(e.id) || link || `${feedUrl}#${title}`),
          feed_url: feedUrl,
          title,
          link,
          author: clean(authors.map((a) => a && a.name).find((n) => n) ?? ""),
          pub_date: updated ? safeTimestamp(Date.parse(updated)) : Date.now(),
          summary: stripTags(rawText(e.summary)),
          content: stripTags(contentRaw),
        });
      }
    }
  } catch (e) {
    return parseRssLegacy(xml, feedUrl);
  }
  return items;
}

// ---------- Legacy regex parser (fallback for malformed feeds) ----------

function getTextRegex(xml, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

function getAttrRegex(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["'][^>]*>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

export function parseRssLegacy(xml, feedUrl) {
  const items = [];
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/ig) || [];
  for (const itemXml of rssItems) {
    const title = stripTags(getTextRegex(itemXml, "title"));
    let link = getTextRegex(itemXml, "link");
    if (!link) link = getAttrRegex(itemXml, "link", "href");
    items.push({
      guid: String(getTextRegex(itemXml, "guid") || link || `${feedUrl}#${title}`),
      feed_url: feedUrl, title, link,
      author: getTextRegex(itemXml, "dc:creator") || getTextRegex(itemXml, "author"),
      pub_date: getTextRegex(itemXml, "pubDate") ? safeTimestamp(Date.parse(getTextRegex(itemXml, "pubDate"))) : Date.now(),
      summary: stripTags(getTextRegex(itemXml, "description")),
      content: stripTags(getTextRegex(itemXml, "content:encoded") || getTextRegex(itemXml, "description")),
    });
  }

  const atomEntries = xml.match(/<entry[\s\S]*?<\/entry>/ig) || [];
  for (const entryXml of atomEntries) {
    const title = stripTags(getTextRegex(entryXml, "title"));
    let link = getAttrRegex(entryXml, "link", "href");
    if (!link) link = getTextRegex(entryXml, "link");
    const updated = getTextRegex(entryXml, "updated") || getTextRegex(entryXml, "published");
    items.push({
      guid: String(getTextRegex(entryXml, "id") || link || `${feedUrl}#${title}`),
      feed_url: feedUrl, title, link,
      author: getTextRegex(entryXml, "name"),
      pub_date: updated ? safeTimestamp(Date.parse(updated)) : Date.now(),
      summary: stripTags(getTextRegex(entryXml, "summary")),
      content: stripTags(getTextRegex(entryXml, "content") || getTextRegex(entryXml, "summary")),
    });
  }
  return items;
}

// ---------- HTML scraping (Cheerio) ----------

const BAD_TITLE = /\b(read more|sign up|subscribe|newsletter|privacy policy|terms of service|cookie|log ?in|follow us|advertisement|pagination|page \d+)\b/i;
const DEFAULT_PATTERNS = ["news", "article", "post", "blog", "stories", "story", "press", "releases"];

export function parseHtml(html, feedUrl, patterns = []) {
  const $ = cheerio.load(html);
  const linkPatterns = (patterns.length ? patterns : DEFAULT_PATTERNS).map((p) => p.toLowerCase());
  const items = [];
  const seenLinks = new Set();

  const matchesPattern = (lowerLink) => {
    if (!lowerLink.includes("/")) return false;
    const segments = lowerLink.split("/");
    // Skip the bare host/path root
    if (segments[segments.length - 1] === "" || lowerLink.endsWith("/")) return false;
    return linkPatterns.some((p) => segments.some((seg) => seg.includes(p)));
  };

  const tryAdd = (anchorText, href) => {
    if (!href || !anchorText) return;
    let link;
    try {
      link = new URL(href, feedUrl).href;
    } catch {
      return;
    }
    if (!/^https?:$/.test(new URL(link).protocol)) return;
    const lowerLink = link.toLowerCase();
    if (seenLinks.has(link)) return;
    if (anchorText.length < 15) return;
    if (/twitter\.com|facebook\.com|linkedin\.com|x\.com|instagram\.com|youtube\.com/.test(lowerLink)) return;
    if (BAD_TITLE.test(anchorText)) return;
    if (!matchesPattern(lowerLink)) return;

    seenLinks.add(link);
    items.push({
      guid: link,
      feed_url: feedUrl,
      title: anchorText,
      link: link,
      author: 'Web Scrape',
      pub_date: Date.now(),
      summary: anchorText,
      content: anchorText,
    });
  };

  // First pass: heading-wrapped links (best titles on landing pages)
  $("h1, h2, h3, h4").each((_, el) => {
    const a = $(el).find("a[href]").first();
    if (a.length) tryAdd(a.text().trim().replace(/\s+/g, " "), a.attr("href"));
  });

  // Second pass: general links with longer anchor text (shorter titles are
  // accepted when the link lives inside an <article> element)
  $("a[href]").each((_, el) => {
    const a = $(el);
    const t = a.text().trim().replace(/\s+/g, " ");
    const href = a.attr("href");
    const inArticle = a.closest("article").length > 0;
    if (!a.find("h1, h2, h3, h4").length && t.length >= (inArticle ? 15 : 25)) tryAdd(t, href);
  });

  return items.slice(0, 30);
}

export function extractReadable(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, nav, footer, header, aside, form, button, .ad, .ads, [class*='advert'], [class*='social'], [class*='share'], [data-ad]").remove();
  const content =
    $("article").first().text() ||
    $(".post-content, .entry-content, .article-content, .post-body, [class*='content']").first().text() ||
    $("main").first().text() ||
    $("body").text();
  return content.replace(/\s+/g, " ").trim().slice(0, 20000);
}