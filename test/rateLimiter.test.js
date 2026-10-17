import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostLimiter, hostOf } from "../lib/rateLimiter.js";

test("hostOf extracts lowercase host (port preserved)", () => {
  assert.equal(hostOf("https://Example.COM:8080/path"), "example.com:8080");
  assert.equal(hostOf("https://Example.COM/path"), "example.com");
  assert.equal(hostOf("not a url"), "");
});

test("createHostLimiter enforces max per host", async () => {
  const lim = createHostLimiter({ perHost: 2, minGapMs: 0, jitterMs: 0 });
  let active = 0;
  let peak = 0;
  const jobs = Array.from({ length: 5 }, () => lim.run("test", async () => {
    active++;
    if (active > peak) peak = active;
    await new Promise((r) => setTimeout(r, 10));
    active--;
  }));
  await Promise.all(jobs);
  assert.equal(peak, 2);
});
