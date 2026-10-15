import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkSections, contextualEmbedInput } from "../lib/retriever.js";
import { formatEmbeddingInput } from "../lib/embedder.js";

test("chunkSections tracks heading breadcrumbs", () => {
  const text = "# Intro\n\n" + "alpha ".repeat(50) + "\n\n## Details\n\nBeta test content.";
  const secs = chunkSections(text, 200, 0);
  assert.ok(secs.length > 0);
  const detailSec = secs.find((s) => /Beta/.test(s.text));
  if (detailSec) assert.ok(/Intro > Details/.test(detailSec.heading), `got: ${detailSec.heading}`);
  const introSec = secs.find((s) => /alpha/.test(s.text));
  if (introSec && !/Beta/.test(introSec.text)) assert.equal(introSec.heading, "Intro");
});

test("contextualEmbedInput includes heading breadcrumb when provided", () => {
  const withHeading = contextualEmbedInput("Crumb Story", "Beta content", true, "Intro > Details", "test-embed");
  assert.ok(withHeading.includes("Crumb Story | Intro > Details"));
  assert.ok(withHeading.includes("Beta content"));
});

test("nomic-embed-text-v1.5 uses document/query prefixes", () => {
  assert.equal(formatEmbeddingInput("hello", "document", "nomic-embed-text-v1.5"), "search_document: hello");
  assert.equal(formatEmbeddingInput("hello", "query", "nomic-embed-text-v1.5"), "search_query: hello");
});