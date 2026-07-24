# File-search tools

This application-owned extension registers `fd` for file discovery and `rg` for content search. pui bundles it automatically; regular `pi` does not. For standalone use:

```sh
pi -e /absolute/path/to/pui/extensions/file-search/index.ts
```

Install [`fd`](https://github.com/sharkdp/fd) (called `fdfind` by some Linux packages) and [ripgrep](https://github.com/BurntSushi/ripgrep), and ensure they are on `PATH`. pui never downloads them.

Both tools execute the resolved binary directly without a shell, time out after 60 seconds, and honor cancellation. Output is limited to Pi's 50KB/2000-line context ceiling. When truncated, the complete output is retained in a private temporary file and its path is included in the result.

Prefer `fd` for names, extensions, and globs and `rg` for file contents. Use `fixed_strings` for literal code containing regex metacharacters; use `bash` for complex pipelines or post-processing.
