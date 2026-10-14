# Archived files

These files are **not** part of the plugin and are kept only for reference.

- `index.js` — an early entrypoint that exported a `tools` array without the
  LM Studio SDK. It duplicated a 3-tool subset of `src/toolsProvider.ts` and
  was never loaded by LM Studio.
- `plugin.json` — an early, non-standard manifest (`"main": "index.js"`). The
  real plugin manifest is the repository-root `manifest.json`.

The live entrypoint is `.lmstudio/entry.ts` → `src/index.ts`.
