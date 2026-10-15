import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_TOOLS, ADMIN_TOOL, GRANULAR_TOOLS, resolveToolSurface } from "../lib/toolSurface.js";

test("default tool surface is the 4 core tools", () => {
  assert.deepEqual(resolveToolSurface(), CORE_TOOLS);
});

test("admin tools are opt-in", () => {
  assert.deepEqual(resolveToolSurface({ enableAdminTools: true }), [...CORE_TOOLS, ADMIN_TOOL]);
});

test("granular tools are opt-in", () => {
  assert.deepEqual(resolveToolSurface({ exposeGranularAdminTools: true }), [...CORE_TOOLS, ...GRANULAR_TOOLS]);
});

test("admin and granular can be combined", () => {
  assert.deepEqual(resolveToolSurface({ enableAdminTools: true, exposeGranularAdminTools: true }), [...CORE_TOOLS, ADMIN_TOOL, ...GRANULAR_TOOLS]);
});