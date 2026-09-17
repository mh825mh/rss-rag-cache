import * as cheerio from "cheerio";

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

function getText(xml, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
}

function getAttr(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']*)["'][^>]*>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : "";
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

export function parseRss(xml, feedUrl) {
  const items = [];
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/ig) || [];
  for (const itemXml of rssItems) {
    const title = stripTags(getText(itemXml, "title"));
    let link = getText(itemXml, "link");
    if (!link) link = getAttr(itemXml, "link", "href");
    items.push({
      guid: String(getText(itemXml, "guid") || link || `${feedUrl}#${title}`),
      feed_url: feedUrl, title, link,
      author: getText(itemXml, "dc:creator") || getText(itemXml, "author"),
      pub_date: getText(itemXml, "pubDate") ? safeTimestamp(Date.parse(getText(itemXml, "pubDate"))) : Date.now(),
      summary: stripTags(getText(itemXml, "description")),
      content: stripTags(getText(itemXml, "content:encoded") || getText(itemXml, "description")),
    });
  }

  const atomEntries = xml.match(/<entry[\s\S]*?<\/entry>/ig) || [];
  for (const entryXml of atomEntries) {
    const title = stripTags(getText(entryXml, "title"));
    let link = getAttr(entryXml, "link", "href");
    if (!link) link = getText(entryXml, "link");
    const updated = getText(entryXml, "updated") || getText(entryXml, "published");
    items.push({
      guid: String(getText(entryXml, "id") || link || `${feedUrl}#${title}`),
      feed_url: feedUrl, title, link,
      author: getText(entryXml, "name"),
      pub_date: updated ? safeTimestamp(Date.parse(updated)) : Date.now(),
      summary: stripTags(getText(entryXml, "summary")),
      content: stripTags(getText(entryXml, "content") || getText(entryXml, "summary")),
    });
  }
return items;
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

export function parseHtml(html, feedUrl) {
  const $ = cheerio.load(html);
  const items = [];
  const seenLinks = new Set();

  // Scan all links on the page
  $("a").each((i, el) => {
    let link = $(el).attr("href");
    let title = $(el).text().trim();

    if (!link || !title) return;

    // Convert relative URLs to absolute
    try {
      link = new URL(link, feedUrl).href;
    } catch {
      return; // Invalid URL
    }

    // Filter out navigation, buttons, and social media links
    if (title.length < 15) return;
    if (link.endsWith('/news/') || link.endsWith('/')) return;
    if (link.includes('twitter.com') || link.includes('facebook.com') || link.includes('linkedin.com')) return;
    
    // Only keep links that look like articles (contain /news/ or /article/ or /post/)
    const lowerLink = link.toLowerCase();
    if (!lowerLink.includes('/news/') && !lowerLink.includes('/article/') && !lowerLink.includes('/post/') && !lowerLink.includes('/blog/')) {
      return;
    }

    if (seenLinks.has(link)) return;
    seenLinks.add(link);

    items.push({
      guid: link,
      feed_url: feedUrl,
      title: title,
      link: link,
      author: 'Web Scrape',
      pub_date: Date.now(),
      summary: title,
      content: title,
    });
  });

  return items;
}