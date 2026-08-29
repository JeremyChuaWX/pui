# 02: Headless `--smoke` entry proves the built binary registers bundled tools and skills

**Parent:** issues/0002-remove-workflows.md

**What to build:** `pui --smoke` boots the Pi runtime headlessly with the bundled Extensions and skills, prints a JSON object listing the registered bundled tool names and skill names, and exits 0. The smoke build runs it against the compiled binary and fails if any bundled tool or the `unslop` skill is missing. This restores the packaging coverage the workflow smoke used to provide.

**Blocked by:** 01: Delete the workflows Module and everything that only served it.

**Status:** done

- [x] `pui --smoke` prints JSON containing the bundled tool names and `["unslop"]` and exits 0 without rendering any UI
- [x] The entry is loaded lazily so the normal TUI start path imports nothing extra
- [x] The smoke build asserts every bundled tool (`fd`, `rg`, the subagent tools, `web_crawl`, `web_search`) and `unslop` appear in the output; the expected subagent tool list is updated again by ticket 06
- [x] `--smoke` appears in `pui --help`
- [x] `bun run check` is green
