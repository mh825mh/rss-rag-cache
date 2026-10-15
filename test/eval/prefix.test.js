import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEmbeddingInput } from "../../lib/embedder.js";

test("nomic-embed-text-v1.5 uses document/query prefixes", () => {
  assert.equal(formatEmbeddingInput("hello", "document", "nomic-embed-text-v1.5"), "search_document: hello");
  assert.equal(formatEmbeddingInput("hello", "query", "nomic-embed-text-v1.5"), "search_query: hello");
});

test("mxbai and bge use decoder-style query prefixes and no document prefix", () => {
  assert.equal(formatEmbeddingInput("hello", "document", "mxbai-embed-large-v1"), "hello");
  assert.equal(formatEmbeddingInput("hello", "query", "mxbai-embed-large-v1"), "Represent this sentence for searching relevant passages: hello");
  assert.equal(formatEmbeddingInput("hello", "document", "bge-large-en-v1.5"), "hello");
  assert.equal(formatEmbeddingInput("hello", "query", "bge-large-en-v1.5"), "Represent this sentence for searching relevant passages: hello");
});

test("snowflake-arctic-embed uses query prefix and no document prefix", () => {
  assert.equal(formatEmbeddingInput("hello", "document", "snowflake-arctic-embed-l-v2.0"), "hello");
  assert.equal(formatEmbeddingInput("hello", "query", "snowflake-arctic-embed-l-v2.0"), "Represent this sentence for searching relevant passages: hello");
});

test("unknown models get no prefixes by default", () => {
  assert.equal(formatEmbeddingInput("hello", "document", "test-embed"), "hello");
  assert.equal(formatEmbeddingInput("hello", "query", "eval-embed"), "hello");
});