import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBan, detectInterstitial, describeBan } from "../lib/bans.js";

test("429 is classified as rate-limited", () => {
  const ban = detectBan({ status: 429, headers: {}, body: "" });
  assert.equal(ban.kind, "rate-limited");
  assert.equal(ban.status, 429);
});

test("403 is classified as blocked", () => {
  const ban = detectBan({ status: 403, headers: {}, body: "" });
  assert.equal(ban.kind, "blocked");
});

test("401/407 (auth) and plain 5xx are not bans", () => {
  assert.equal(detectBan({ status: 401 }), null);
  assert.equal(detectBan({ status: 407 }), null);
  assert.equal(detectBan({ status: 500, headers: {}, body: "<html>oops</html>" }), null);
  assert.equal(detectBan({ status: 502 }), null);
});

test("Cloudflare challenge bodies are detected", () => {
  const body = "<html><head><title>Just a moment...</title></head><body>checking your browser</body></html>";
  const interstitial = detectInterstitial(body);
  assert.ok(interstitial);
  assert.equal(interstitial.vendor, "cloudflare");
  assert.equal(interstitial.kind, "challenge");
});

test("a 503 with a Cloudflare challenge is a ban, a plain 503 is not", () => {
  const challenged = detectBan({
    status: 503,
    headers: { server: "cloudflare" },
    body: "<html><title>Just a moment...</title></html>",
  });
  assert.ok(challenged);
  assert.equal(challenged.vendor, "cloudflare");

  assert.equal(detectBan({ status: 503, headers: { server: "nginx" }, body: "<html>503 Service Unavailable</html>" }), null);
});

test("vendor headers alone identify the wall", () => {
  const ban = detectBan({ status: 403, headers: { server: "cloudflare", "cf-ray": "abc123-FRA" }, body: "" });
  assert.equal(ban.vendor, "cloudflare");
});

test("generic captcha wording only fires on small documents", () => {
  const short = "<html><body>Please complete the reCAPTCHA to continue</body></html>";
  assert.ok(detectInterstitial(short), "small captcha page is an interstitial");

  // A long article that merely mentions a captcha must not be flagged.
  const long = "<html><body>" + "the captcha debate ".repeat(2000) + "</body></html>";
  assert.equal(detectInterstitial(long), null, "long article mentioning captcha is content");
});

test("describeBan returns a readable string", () => {
  const s = describeBan({ kind: "blocked", vendor: "akamai", status: 403, reason: "blocked by akamai (HTTP 403)" });
  assert.match(s, /akamai/);
  assert.match(s, /403/);
});
