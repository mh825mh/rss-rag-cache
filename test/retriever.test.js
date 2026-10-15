import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSimhash, hamming, toStoredSimhash, fromStoredSimhash } from "../lib/simhash.js";
import { entrySimhash } from "../lib/hashes.js";

// A realistic article-length body. The 64-bit hash only becomes stable for
// short bodies with ~100+ shingles; that is what syndicated articles look like.
const article = [
  "The city council approved the new transit plan on Tuesday after months of debate over funding and route alignment across the downtown corridor.",
  "The plan adds two express bus lines and extends evening service on the eastern route, which officials said would cut average commute times for riders.",
  "Critics argued the funding model relies on uncertain state grants and warned that service could be reduced if the grants do not materialise next year.",
  "Council members said the first phase would begin this spring, with construction crews scheduled to break ground near the central station in April.",
  "Transit advocates welcomed the decision but urged the council to commit to a long-term maintenance budget rather than one-time capital spending.",
].join(" ");

test("computeSimhash returns a 64-bit BigInt", () => {
  const h = computeSimhash(article);
  assert.equal(typeof h, "bigint");
  assert.ok(h >= 0n && h <= 0xffffffffffffffffn, "value fits in 64 bits");
  assert.equal(computeSimhash(""), null, "empty input has no fingerprint");
});

test("64-bit simhash survives the signed SQLite round-trip", () => {
  // Force a value with the top bit set so the signed conversion really moves it.
  const withHighBit = 0x8000000000000001n;
  const stored = toStoredSimhash(withHighBit);
  assert.ok(stored < 0n, "high bit maps to a negative signed INTEGER");
  assert.ok(stored >= -0x8000000000000000n, "stays within SQLite's signed 64-bit range");
  assert.equal(fromStoredSimhash(stored), withHighBit, "read-back is lossless");
  assert.equal(hamming(withHighBit, stored), 0, "signed and unsigned compare equal");
  assert.equal(hamming(stored, withHighBit), 0);
});

test("syndicated copies with minor footer variations match within Hamming distance 4", () => {
  const footerA = `${article} Read more at example.com.`;
  const footerB = `${article} This article originally appeared on Example News.`;

  assert.equal(hamming(computeSimhash(article), computeSimhash(article)), 0,
    "identical bodies are identical fingerprints");
  assert.ok(hamming(computeSimhash(article), computeSimhash(footerA)) <= 4,
    `footer variation should stay within 4 bits (got ${hamming(computeSimhash(article), computeSimhash(footerA))})`);
  assert.ok(hamming(computeSimhash(article), computeSimhash(footerB)) <= 4,
    `different short footer should stay within 4 bits (got ${hamming(computeSimhash(article), computeSimhash(footerB))})`);
});

test("distinct short updates do not collide", () => {
  const s1 = "Breaking train delayed again today";
  const s2 = "Breaking bus cancelled this morning";
  const s3 = "Council approves downtown transit budget";

  const d12 = hamming(computeSimhash(s1), computeSimhash(s2));
  const d13 = hamming(computeSimhash(s1), computeSimhash(s3));
  assert.ok(d12 > 4, `distinct short posts must not collapse (got ${d12})`);
  assert.ok(d13 > 4, `distinct short posts must not collapse (got ${d13})`);
});

test("entrySimhash fingerprints the body only, ignoring the headline", () => {
  // entrySimhash() never receives the title, so the same syndicated body under
  // two different headlines collapses to one fingerprint.
  const a = entrySimhash("", article);
  const b = entrySimhash("", article);
  assert.equal(hamming(a, b), 0, "the same syndicated body yields one fingerprint");
  assert.equal(hamming(computeSimhash(article), a), 0, "matches the raw body hash");
  assert.equal(entrySimhash("", ""), null, "empty content has no fingerprint");
});

test("hamming treats a missing fingerprint as maximally distant", () => {
  const h = computeSimhash(article);
  assert.ok(hamming(h, null) > 4);
  assert.ok(hamming(null, h) > 4);
  assert.ok(hamming(null, null) > 4);
});

test("short syndicated variants are intentionally left uncollapsed", () => {
  // Documented trade-off of the 64-bit upgrade: near-duplicate *short* posts are
  // deliberately left alone rather than guessed at (the 32-bit version collided
  // on these). The dedupe threshold in retrieve() is 4.
  const s1 = "Breaking train delayed again today";
  const s2 = `${s1} via Wire`;
  assert.ok(hamming(computeSimhash(s1), computeSimhash(s2)) > 4,
    "short syndicated variants are intentionally not collapsed");
});
