// Minimal, dependency-free robots.txt support.
//
// Only the parts a polite crawler needs are implemented: User-agent groups,
// Allow/Disallow with `*` and `$` wildcards, longest-match-wins, and
// Crawl-delay parsing (exposed but not enforced here — the per-host limiter in
// rateLimiter.js is what actually spaces requests).
//
// `createRobotsCache` wraps a text fetcher so the caller decides how robots.txt
// itself is fetched (with which headers, timeouts and pacing). A missing or
// unreadable robots.txt is treated as "everything allowed", which is the
// convention every major crawler follows.

export function parseRobots(text) {
  const groups = [];
  let current = null;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();

    if (field === "user-agent") {
      // A new agent name starts a new group unless the current group has no
      // rules yet (consecutive User-agent lines share one group).
      if (!current || current.rules.length) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
    } else if (field === "disallow" || field === "allow") {
      if (!current) {
        current = { agents: ["*"], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.rules.push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      if (current && !current.rules.length) {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      }
    }
  }
  return groups;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(value) {
  const anchored = value.endsWith("$");
  const body = anchored ? value.slice(0, -1) : value;
  const parts = body.split("*").map(escapeRe);
  return new RegExp("^" + parts.join("[\\s\\S]*") + (anchored ? "$" : ""));
}

function matchesPath(pattern, path) {
  if (!pattern) return false;
  try {
    return compile(pattern).test(path);
  } catch {
    return false;
  }
}

// Picks the most specific group for `userAgent` (longest matching token prefix,
// falling back to the wildcard group) then the longest matching rule inside it.
// An empty Disallow means "no restriction"; ties between Allow and Disallow are
// resolved in favour of Allow, per the de-facto standard.
export function isAllowed(groups, path, userAgent = "*") {
  const target = path || "/";
  const token = String(userAgent || "*").toLowerCase().split("/")[0].trim() || "*";

  let group = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const agent of g.agents) {
      if (agent === "*") continue;
      if (token.startsWith(agent) && agent.length > bestLen) {
        group = g;
        bestLen = agent.length;
      }
    }
  }
  if (!group) group = groups.find((g) => g.agents.includes("*")) || null;
  if (!group) return true;

  let allowed = true;
  let bestPath = -1;
  for (const rule of group.rules) {
    if (!rule.path) continue; // empty Allow/Disallow = no restriction
    if (!matchesPath(rule.path, target)) continue;
    const len = rule.path.length;
    if (len > bestPath || (len === bestPath && rule.allow)) {
      bestPath = len;
      allowed = rule.allow;
    }
  }
  return allowed;
}

export function createRobotsCache({ fetchText, userAgent = "*", ttlMs = 3600_000, maxEntries = 512, now = Date.now } = {}) {
  const cache = new Map();

  function evictIfNeeded() {
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  async function lookup(host, origin) {
    let entry = cache.get(host);
    if (entry && entry.expires > now()) return entry;
    let text = null;
    try {
      text = await fetchText(`${origin}/robots.txt`);
    } catch {
      text = null;
    }
    entry = {
      groups: text ? parseRobots(text) : null,
      expires: now() + ttlMs,
    };
    cache.set(host, entry);
    evictIfNeeded();
    return entry;
  }

  return {
    // Returns true when the URL may be fetched. Unparseable URLs are allowed.
    async allowed(url) {
      let parsed;
      try {
        parsed = new URL(String(url));
      } catch {
        return true;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
      const host = parsed.host.toLowerCase();
      const entry = await lookup(host, parsed.origin);
      if (!entry.groups) return true;
      return isAllowed(entry.groups, parsed.pathname + parsed.search, userAgent);
    },
    invalidate(host) {
      cache.delete(String(host).toLowerCase());
    },
    clear() {
      cache.clear();
    },
    get size() {
      return cache.size;
    },
    _cache: cache,
  };
}
