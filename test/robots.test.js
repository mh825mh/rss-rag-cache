import { test } from "node:test";
import assert from "node:assert/strict";
import { createRobotsCache, parseRobots, isAllowed } from "../lib/robots.js";

test("parseRobots handles wildcards and allow/disallow precedence", () => {
  const text = `
User-agent: Googlebot
Disallow: /admin/
Allow: /admin/public/

User-agent: *
Disallow: /private/
Allow: /
`;
  const groups = parseRobots(text);
  assert.ok(groups.length >= 2);
  const gstar = groups.find((g) => g.agents.includes("*"));
  assert.ok(gstar);
  assert.equal(isAllowed(groups, "/private/secret.html"), false);
  assert.equal(isAllowed(groups, "/public/page.html"), true);
});

test("isAllowed respects longest match and $ anchor", () => {
  const groups = parseRobots(`
User-agent: *
Disallow: /*.gif$
Disallow: /admin/
Allow: /admin/view/
`);
  assert.equal(isAllowed(groups, "/image.gif"), false);
  assert.equal(isAllowed(groups, "/image.gif?size=large"), true);
  assert.equal(isAllowed(groups, "/admin/view/index.html"), true);
  assert.equal(isAllowed(groups, "/admin/delete.php"), false);
});

test("createRobotsCache treats missing robots as allowed", async () => {
  const cache = createRobotsCache({
    fetchText: async () => { throw new Error("nope"); },
    ttlMs: 10,
  });
  assert.equal(await cache.allowed("https://example.com/page.html"), true);
});
