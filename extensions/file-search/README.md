# File-search tools

This application-owned extension registers `fd` for file discovery and `rg` for content search. pui bundles it automatically; regular `pi` does not. Tool-name conflicts follow Pi's normal load semantics: global and trusted project extensions load before pui's inline bundled extensions, the first registration of a name is the single active definition, and Pi reports later registrations as conflicts. Thus a discovered extension that registers `fd` or `rg` owns that name; pui still loads the bundled extension and all unrelated tools. `@` file completion remains host-owned and uses pui's system `fd`/`fdfind` resolver independently of which extension owns a model-facing tool name.

For standalone use:

```sh
pi -e /absolute/path/to/pui/extensions/file-search/index.ts
```

Install [`fd`](https://github.com/sharkdp/fd) (called `fdfind` by some Linux packages) and [ripgrep](https://github.com/BurntSushi/ripgrep), and ensure they are on `PATH`. pui never downloads them.

Both tools execute the resolved binary directly without a shell, time out after 60 seconds, and honor cancellation. Output is limited to Pi's 50KB/2000-line context ceiling. When truncated, the complete output is retained in a private temporary file and its path is included in the result. It remains available for inspection until the current session shuts down, when the extension removes it.

Prefer `fd` for names, extensions, and globs and `rg` for file contents. Use `fixed_strings` for literal code containing regex metacharacters; use `bash` for complex pipelines or post-processing.
