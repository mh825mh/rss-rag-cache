import * as cheerio from "cheerio";

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
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .trim();
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
      pub_date: getText(itemXml, "pubDate") ? Date.parse(getText(itemXml, "pubDate")) : Date.now(),
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
      pub_date: updated ? Date.parse(updated) : Date.now(),
      summary: stripTags(getText(entryXml, "summary")),
      content: stripTags(getText(entryXml, "content") || getText(entryXml, "summary")),
    });
  }
  return items;
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