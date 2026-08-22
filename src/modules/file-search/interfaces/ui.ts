import { resolveFdBinary } from "../binaries.js";

/**
 * UI Entry: the `@`-completion surface. The Controller feeds this command to
 * the TUI's file autocomplete provider; `undefined` means fd is unavailable
 * and file completion is disabled.
 */
export function fdCompletionCommand(): string | undefined {
    try {
        return resolveFdBinary().command;
    } catch {
        return undefined;
    }
}

export { resolveFdBinary };
