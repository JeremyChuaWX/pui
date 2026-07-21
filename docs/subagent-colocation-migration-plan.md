# Subagent extension colocation migration plan

Status: complete — migration and cleanup verified on 2026-07-21

## 1. Goal

Move the complete subagent Pi extension from the local dotfiles repository into `pi-tui`, then make every Pi runtime created by `pi-tui` load that extension directly from this repository.

The migration is complete when:

- `pi-tui` no longer depends on `~/.pi/agent/extensions/subagent`;
- the extension implementation, fixtures, tests, preset prompt, protocol producer, and pi-tui presentation code live in one repository;
- the extension path is resolved relative to a pi-tui module, never relative to the user's session cwd;
- startup, `/reload`, `/new`, resume, fork, and cwd-changing session replacement continue to load exactly one `subagent` tool;
- ordinary global and project Pi extensions continue to load normally;
- the old dotfiles extension is removed without losing its uncommitted working-tree implementation.

## 2. Pre-migration state and migration constraint

Before migration, the implementation was split between:

- Extension working tree: `/Users/jer/.dotfiles/stowables/pi/.pi/agent/extensions/subagent/`
- Host implementation: `/Users/jer/dev/pi-tui/src/`

The dotfiles source was not represented completely by its Git `HEAD`:

- `index.ts` is modified;
- most protocol, runner, test, fixture, and documentation files are untracked;
- `stowables/pi/.pi/agent/tsconfig.json` has a subagent-test-related modification.

Therefore, the migration used the filesystem working tree rather than `git show`, a clean checkout, or the last dotfiles commit. The source and destination were compared recursively before migration-specific edits, and the dotfiles copy was removed only after the relocated extension passed its tests.

## 3. Design decisions

### 3.1 Target location

Use a top-level extension directory:

```text
pi-tui/
├── extensions/
│   └── subagent/
│       ├── index.ts
│       ├── protocol.ts
│       ├── runner.ts
│       ├── json-events.ts
│       ├── semaphore.ts
│       ├── agents/
│       │   └── explore.md
│       ├── fixtures/
│       ├── README.md
│       └── *.test.ts
└── src/
    ├── controller.ts
    └── subagent.ts
```

Do not put the extension in `.pi/extensions`. Project extension discovery depends on the active session cwd and project trust, while this extension is trusted application code that must load for every pi-tui session.

### 3.2 Runtime loading mechanism

Load the extension with `DefaultResourceLoader`'s supported `additionalExtensionPaths` option, passed through `createAgentSessionServices`:

```ts
const bundledSubagentExtensionPath = fileURLToPath(
  new URL("../extensions/subagent/index.ts", import.meta.url),
);

const services = await createAgentSessionServices({
  cwd,
  agentDir: targetAgentDir,
  resourceLoaderOptions: {
    additionalExtensionPaths: [bundledSubagentExtensionPath],
  },
});
```

The source path is module-relative but converted to an absolute filesystem path before Pi receives it. It must not use `process.cwd()`, `options.cwd`, the session cwd, or a hard-coded checkout path.

Keep this configuration inside the existing `CreateAgentSessionRuntimeFactory` path in `src/controller.ts`. The runtime invokes that factory again when replacement sessions require cwd-bound services, so the bundled extension remains present after resume, new-session, fork, clone, and cwd changes. Pi's existing session reload path will reload the additional path.

Prefer a small `src/bundled-extensions.ts` module for the path constant/array so path resolution can be tested independently and future bundled extensions have one registration point. `src/controller.ts` should consume that exported array.

### 3.3 Preserve the extension boundary

This is a relocation, not a rewrite:

- Keep the subagent capability as a Pi extension registered through `ExtensionAPI`.
- Keep `extensions/subagent/protocol.ts` as the producer's canonical protocol implementation.
- Keep `src/subagent.ts` as a defensive `unknown`-to-view-model parser for live and persisted external data.
- Do not replace the extension with an SDK `customTools` definition.
- Do not make pi-tui rendering depend on the extension's `@earendil-works/pi-tui` render components.
- Defer protocol-code deduplication until after migration; changing validation and ownership during the move would unnecessarily expand risk.

### 3.4 Scope of availability

After cleanup, `pi-tui` always loads the bundled extension. The regular `pi` command no longer auto-loads it globally, but the relocated extension remains standalone and can be tested or used explicitly:

```bash
pi -e /Users/jer/dev/pi-tui/extensions/subagent/index.ts
```

Do not leave a second global symlink or settings entry enabled by default. Loading both copies would register two tools named `subagent`; Pi reports the conflict but keeps both extensions loaded, making precedence dependent on load order.

## 4. Migration tasks

### COL-01 — Capture a baseline and protect the working-tree source

Status: complete

Repository scope:

- `/Users/jer/.dotfiles`
- `/Users/jer/dev/pi-tui`

Work:

1. Record `git status --short` in both repositories.
2. Inventory every file under the dotfiles `extensions/subagent` directory, including fixtures and Markdown prompts.
3. Run the existing extension and host checks before moving anything.
4. Confirm no live child Pi process from a previous subagent test remains.
5. Treat unrelated dotfiles changes as out of scope; do not reset the repository.

Baseline verification:

```bash
cd /Users/jer/.dotfiles/stowables/pi/.pi/agent
bun test extensions/subagent
npm run typecheck

cd /Users/jer/dev/pi-tui
npm run check
```

Acceptance:

- Both suites have a recorded baseline result.
- The inventory includes all source files, `agents/explore.md`, `fixtures/fake-child.mjs`, `fixtures/success.jsonl`, tests, and the extension README.
- The current uncommitted dotfiles implementation remains intact.

### COL-02 — Relocate the extension and transfer test ownership

Status: complete

Repository: `/Users/jer/dev/pi-tui`

Work:

1. Copy the complete current dotfiles directory to `extensions/subagent/` without changing behavior.
2. Compare the source and destination recursively before making migration-specific edits.
3. Update `package.json` so `typebox` is a direct dependency at the version currently used by the extension (`1.1.38`), and update `package-lock.json` through npm.
4. Expand the test script so the default repository check runs both `src` tests and `extensions/subagent` tests.
5. Include `extensions/**/*.ts` in `tsconfig.json`; exclude only extension `*.test.ts` files if required to preserve the extension's current typecheck policy. Do not stop typechecking existing `src` tests.
6. Update the relocated extension README's verification cwd and commands.
7. Preserve all current internal module- and fixture-relative URL resolution. `agents/explore.md` and `fixtures/fake-child.mjs` should continue resolving through `import.meta.url`.

Suggested package commands after the move:

```json
{
  "test": "bun test src extensions/subagent",
  "check": "npm run typecheck && npm test"
}
```

Acceptance:

- The relocated extension tests pass without a model or network request.
- Extension source files typecheck against pi-tui's pinned Pi dependencies.
- The runner still distinguishes Pi CLI hosting from SDK hosting.
- Child isolation flags, timeout, cancellation, process-group cleanup, concurrency, output limits, and failure-detail persistence are unchanged.

Verification:

```bash
cd /Users/jer/dev/pi-tui
bun test extensions/subagent
npm run typecheck
```

### COL-03 — Register the bundled extension in every pi-tui Pi runtime

Status: complete

Repository: `/Users/jer/dev/pi-tui`

Files:

- Add `src/bundled-extensions.ts`
- Update `src/controller.ts`

Work:

1. Resolve `extensions/subagent/index.ts` with `new URL(..., import.meta.url)` and `fileURLToPath` in `src/bundled-extensions.ts`.
2. Export the bundled extension path list as already-resolved absolute paths.
3. Pass that list as `resourceLoaderOptions.additionalExtensionPaths` in the existing `createAgentSessionServices` call.
4. Keep `agentDir` unchanged so auth, models, settings, sessions, normal global extensions, skills, prompts, themes, and context continue to come from Pi's normal configuration.
5. Do not set `noExtensions`; the bundled path augments normal discovery.
6. Do not add special extension binding code. The existing `session.bindExtensions(...)`, runtime rebind hook, and session reload lifecycle remain responsible for activation.

Acceptance:

- Launching through `bin/pi-tui` finds the extension regardless of shell cwd.
- A session whose stored cwd differs from the pi-tui checkout still loads it.
- The resource loader reports the bundled extension without errors.
- The active tools contain one `subagent` registration when the old global copy is absent.
- Existing global/project extensions are not disabled.

### COL-04 — Add migration-focused integration coverage

Status: complete

Repository: `/Users/jer/dev/pi-tui`

Files:

- Add `src/bundled-extensions.test.ts`
- Update moved tests under `extensions/subagent/` as needed
- Update controller/integration tests only where they verify runtime lifecycle behavior

Work:

1. Test that the bundled extension path is absolute, exists, and is independent of `process.cwd()`.
2. Construct a `DefaultResourceLoader` with temporary `cwd` and `agentDir`, pass the same bundled extension path list used by the controller, and assert:
   - no load errors;
   - exactly one bundled extension is loaded;
   - it registers the `subagent` tool and its local modules/preset resolve.
3. Reload that loader and verify the extension does not accumulate duplicate registrations.
4. Preserve and run the moved SDK integration test for partial updates, parallel sibling calls, success/failure details, persistence, and resume.
5. Retain host tests for malformed and unknown protocol details, legacy sessions, generic tools, and persisted terminal cards.
6. Where practical, cover runtime recreation with a temporary session cwd and assert the same bundled path is supplied after replacement. Do not make tests depend on the user's real `~/.pi/agent` directory.

Acceptance:

- Tests prove the controller's configured path, rather than merely loading a separately hard-coded test path.
- Tests remain deterministic and network-free.
- `/reload` and session replacement do not require a second extension registration path.
- Generic tools and extension-neutral protocol fallback behavior remain unchanged.

Verification:

```bash
cd /Users/jer/dev/pi-tui
npm run check
```

### COL-05 — Update ownership documentation and remove the global copy

Status: complete

Repository scope:

- `/Users/jer/dev/pi-tui`
- `/Users/jer/.dotfiles`

Work in pi-tui:

1. Update `README.md` to say the subagent extension is bundled with pi-tui and loaded directly into its embedded Pi runtime.
2. Continue documenting that subagents are not Pi core and that progress uses ordinary structured tool details.
3. Document that regular Pi can load the standalone source explicitly with `pi -e` if desired.
4. Update `docs/subagent-implementation-plan.md` canonical repository/path references, verification commands, and extension-absence language that is no longer true for the shipped pi-tui runtime.
5. Link that implementation plan to this completed migration where useful.

Work in dotfiles, only after the new repository passes its checks:

1. Remove `stowables/pi/.pi/agent/extensions/subagent/` from the dotfiles working tree.
2. Remove the subagent-only `tsconfig.json` test exclusion if no remaining dotfiles tests require it; preserve all unrelated compiler settings.
3. Do not remove shared dependencies from the dotfiles package merely because the subagent moved: other extensions currently use `typebox`, Pi AI types, and Pi TUI utilities.
4. Confirm `~/.pi/agent/extensions/subagent` no longer resolves through the stowed extensions symlink.
5. Search both repositories and Pi settings for stale extension paths or a settings-based duplicate registration.

Acceptance:

- `pi-tui` documentation identifies `extensions/subagent/` as the canonical source.
- No implementation remains under the dotfiles subagent path.
- No global extension or settings entry causes a duplicate `subagent` tool.
- Other dotfiles extensions and dependencies remain untouched.

### COL-06 — Final regression and manual lifecycle verification

Status: complete

Automated verification:

```bash
cd /Users/jer/dev/pi-tui
npm ci --ignore-scripts
npm run check

# Confirm the old auto-discovered copy is gone.
test ! -e /Users/jer/.pi/agent/extensions/subagent
```

Manual pi-tui smoke test:

1. Launch `pi-tui --no-session` from a directory outside the repository.
2. Confirm startup has no extension-load or duplicate-tool diagnostic.
3. Run one `explore` subagent and confirm queued, starting, running, and terminal UI states.
4. Start sibling subagents and confirm independent rows and concurrency behavior.
5. Abort a run and confirm terminal structured failure details.
6. Run `/reload`, then invoke a subagent again.
7. Run `/new` and resume a persisted session; confirm the tool remains available and completed cards restore.
8. If practical, open a session whose cwd differs from the launch cwd and repeat one call.

Standalone regular-Pi compatibility smoke test:

```bash
pi -e /Users/jer/dev/pi-tui/extensions/subagent/index.ts
```

Confirm the regular Pi renderer remains useful and that child Pi still runs with extensions, skills, prompts, context, and sessions disabled.

Final acceptance:

- All automated checks pass from a clean install.
- No child process survives cancellation, timeout, or test teardown.
- The bundled extension loads exactly once through startup, reload, and session replacement.
- pi-tui has no runtime dependency on the dotfiles repository.
- Regular Pi can still load the relocated extension explicitly.

Completion evidence:

- `npm ci --ignore-scripts` and `npm run check` passed in pi-tui with 63 tests.
- The remaining dotfiles extensions pass their TypeScript check after removal of the subagent-only test exclusion.
- `~/.pi/agent/extensions/subagent` no longer exists through the stowed global extensions symlink, and no settings entry registers a duplicate path.
- Standalone regular-Pi JSON and TUI invocations loaded `extensions/subagent/index.ts` explicitly. JSON mode emitted queued, starting, running, and succeeded protocol snapshots with a persisted successful tool result, and the regular Pi renderer displayed a useful terminal card.
- pi-tui launched from `/tmp` without extension diagnostics; live subagents succeeded after `/reload` and again after `/new`, sibling calls rendered independently, and an aborted call persisted a structured cancelled card.
- A persisted terminal card restored when the session was launched from a different cwd. Automated runtime coverage also recreates services for new, forked, and resumed sessions and still finds exactly one `subagent` tool.

## 5. Execution order and rollback

Execute tasks strictly in this order:

```text
COL-01 baseline
  -> COL-02 copy and verify
  -> COL-03 runtime loading
  -> COL-04 integration coverage
  -> COL-05 docs and dotfiles cleanup
  -> COL-06 final verification
```

The safe rollback point is before COL-05: the old global extension remains available while the relocated copy is developed and tested. Do not run a pi-tui live smoke test with both copies enabled and interpret duplicate registration as a migration defect; remove or temporarily disable the global copy first.

After COL-05, rollback by restoring the dotfiles extension from the verified relocated directory, then removing the bundled path registration. Never restore from the old dotfiles Git `HEAD` alone because it does not contain the complete pre-migration working tree.

## 6. Out of scope

- Adding write-capable or project-local subagent presets.
- Changing the `pi.subagent` protocol version.
- Replacing child-process execution with Pi core changes.
- Sharing the host's defensive parser directly with the producer.
- Packaging the extension as a separate npm package.
- Adding selective conflict resolution for arbitrary third-party tools also named `subagent`; the known global duplicate is removed as part of this migration.
