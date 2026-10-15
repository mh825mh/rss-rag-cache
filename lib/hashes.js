import { createHash } from "node:crypto";
import { computeSimhash, hamming, toStoredSimhash, fromStoredSimhash } from "./simhash.js";

// Stable content fingerprint used for update detection: if an entry's text
// changes (same guid), we re-chunk and re-embed it instead of ignoring it.
// Includes the title so a headline-only edit is also picked up.
export function contentHash(title, summary, content) {
  return createHash("sha1")
    .update(`${title ?? ""}\n${summary ?? ""}\n${content ?? ""}`)
    .digest("hex");
}

// Fingerprint used for near-duplicate detection. Deliberately body-only (no
// title) so the same syndicated article published under different headlines
// still collapses to one result.
export function entrySimhash(summary, content) {
  const body = `${summary ?? ""} ${content ?? ""}`.trim();
  return body ? computeSimhash(body) : null;
}

export { computeSimhash, hamming, toStoredSimhash, fromStoredSimhash };
