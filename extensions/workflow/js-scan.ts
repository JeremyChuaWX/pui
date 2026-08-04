/** Shared JavaScript source-scanning primitives for workflow validation and masking. */

/** Decide whether a `/` at `index` starts a regex literal rather than division. */
export function regexLiteralStartsAt(
    script: string,
    index: number,
    previousWord: string | undefined,
    followsStatement: boolean,
): boolean {
    const rawPrefix = script.slice(0, index),
        prefix = rawPrefix.trimEnd();
    if (!prefix || followsStatement) return true;
    if (/(?:\+\+|--)\s*$/.test(prefix)) return false;
    const previous = prefix.at(-1);
    if (previous === "}" && /[\r\n]/.test(rawPrefix.slice(prefix.length))) return true;
    if (previous && "([{=,:;!?&|+-*%^~<>".includes(previous)) return true;
    return (
        previousWord !== undefined &&
        /^(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/.test(previousWord)
    );
}

/** Skip the quoted literal opening at `index`, returning the index of its closing quote (or the scan end). */
export function skipStringLiteral(script: string, index: number): number {
    const quote = script[index];
    for (index++; index < script.length; index++) {
        if (script[index] === "\\") index++;
        else if (script[index] === quote) break;
    }
    return index;
}

/** Skip the regex literal opening at `index`, returning the index of its last character including flags. */
export function skipRegexLiteral(script: string, index: number): number {
    let characterClass = false;
    for (index++; index < script.length; index++) {
        if (script[index] === "\\") index++;
        else if (script[index] === "[") characterClass = true;
        else if (script[index] === "]") characterClass = false;
        else if (script[index] === "/" && !characterClass) break;
    }
    while (/[a-z]/i.test(script[index + 1] ?? "")) index++;
    return index;
}

/** Blank out `output[start..end]` with spaces while preserving line breaks. */
function maskRange(output: string[], start: number, end: number): void {
    for (let index = start; index <= end && index < output.length; index++)
        if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
}

/**
 * Tracks the lexical context (previous identifier, control-flow parens, block braces, bracket depth)
 * needed to disambiguate regex literals from division and blocks from object literals.
 */
export class CodeScanState {
    depth = 0;
    previousWord: string | undefined;
    followsControlCondition = false;
    private readonly controlParens: boolean[] = [];
    private readonly declarationParens: boolean[] = [];
    private readonly blockBraces: boolean[] = [];
    private functionDeclarationPending = false;
    private declarationBlockPending = false;

    /** Forget the pending word context, as after any literal or declaration jump. */
    resetWord(): void {
        this.previousWord = undefined;
        this.followsControlCondition = false;
    }

    /** Consume the plain-code character (or identifier run) at `index`, returning the last index consumed. */
    step(script: string, index: number): number {
        const character = script[index];
        if (/[A-Za-z_$]/.test(character)) {
            const end = /^[\w$]*/.exec(script.slice(index + 1))?.[0].length ?? 0;
            this.previousWord = script.slice(index, index + end + 1);
            if (this.previousWord === "function" || this.previousWord === "class") {
                const prefix = script.slice(0, index).trimEnd(),
                    declarationPrefix = /(?:^|[{};])\s*(?:export(?:\s+default)?)?$/;
                if (this.previousWord === "function")
                    this.functionDeclarationPending =
                        declarationPrefix.test(prefix) || /(?:^|[{};])\s*(?:export\s+)?async\s*$/.test(prefix);
                else this.declarationBlockPending = declarationPrefix.test(prefix);
            }
            this.followsControlCondition = false;
            return index + end;
        }
        if (character === "(") {
            this.controlParens.push(/^(?:catch|for|if|switch|while|with)$/.test(this.previousWord ?? ""));
            this.declarationParens.push(this.functionDeclarationPending);
            this.functionDeclarationPending = false;
            this.depth++;
            this.resetWord();
        } else if (character === "{") {
            this.blockBraces.push(
                this.declarationBlockPending ||
                    this.followsControlCondition ||
                    /^(?:do|else|finally|try)$/.test(this.previousWord ?? "") ||
                    !script.slice(0, index).trim(),
            );
            this.declarationBlockPending = false;
            this.depth++;
            this.resetWord();
        } else if (character === "[") {
            this.depth++;
            this.resetWord();
        } else if (character === ")") {
            this.depth = Math.max(0, this.depth - 1);
            this.followsControlCondition = this.controlParens.pop() ?? false;
            this.declarationBlockPending ||= this.declarationParens.pop() ?? false;
            this.previousWord = undefined;
        } else if (character === "}") {
            this.depth = Math.max(0, this.depth - 1);
            this.previousWord = undefined;
            this.followsControlCondition = this.blockBraces.pop() ?? false;
        } else if (character === "]") {
            this.depth = Math.max(0, this.depth - 1);
            this.resetWord();
        } else if (!/\s/.test(character)) {
            this.resetWord();
        }
        return index;
    }
}

/** Mask comments and string/template text while leaving `${...}` interpolation code executable. */
function maskCommentsAndStrings(source: string): string {
    const output = [...source];
    let mode: "code" | "single" | "double" | "template" | "line" | "block" = "code",
        escaped = false;
    const templates: number[] = [];
    for (let i = 0; i < source.length; i++) {
        const c = source[i],
            next = source[i + 1];
        if (mode === "code") {
            if (c === "'" || c === '"' || c === "`") {
                mode = c === "'" ? "single" : c === '"' ? "double" : "template";
                output[i] = " ";
                continue;
            } else if (c === "/" && next === "/") mode = "line";
            else if (c === "/" && next === "*") mode = "block";
            else if (templates.length && c === "{") templates[templates.length - 1]++;
            else if (templates.length && c === "}" && --templates[templates.length - 1] === 0) {
                templates.pop();
                mode = "template";
            } else continue;
        } else if (mode === "template" && c === "$" && next === "{" && !escaped) {
            output[i] = output[i + 1] = " ";
            templates.push(1);
            i++;
            mode = "code";
            continue;
        } else if (mode === "line" && (c === "\n" || c === "\r")) {
            mode = "code";
            continue;
        } else if (mode === "block" && c === "*" && next === "/") {
            output[i] = output[i + 1] = " ";
            i++;
            mode = "code";
            continue;
        } else if (
            (mode === "single" && c === "'") ||
            (mode === "double" && c === '"') ||
            (mode === "template" && c === "`")
        ) {
            if (!escaped) mode = "code";
        }
        output[i] = c === "\n" || c === "\r" ? c : " ";
        escaped = c === "\\" && !escaped;
        if (c !== "\\") escaped = false;
    }
    return output.join("");
}

/** Mask regex literals in code whose comments and string/template text are already masked. */
function maskRegexLiterals(source: string): string {
    const output = [...source],
        state = new CodeScanState();
    for (let index = 0; index < source.length; index++) {
        if (
            source[index] === "/" &&
            regexLiteralStartsAt(source, index, state.previousWord, state.followsControlCondition)
        ) {
            const start = index;
            index = skipRegexLiteral(source, index);
            maskRange(output, start, index);
            state.resetWord();
        } else index = state.step(source, index);
    }
    return output.join("");
}

/** Mask comments, strings, and templates in a single pass, hiding interpolation code entirely. */
function maskAllLiterals(script: string): string {
    const output = [...script],
        state = new CodeScanState();
    for (let index = 0; index < script.length; index++) {
        const start = index,
            character = script[index],
            next = script[index + 1];
        if (character === "/" && next === "/") {
            const newline = script.indexOf("\n", index + 2);
            index = newline === -1 ? script.length - 1 : newline - 1;
            maskRange(output, start, index);
        } else if (character === "/" && next === "*") {
            const end = script.indexOf("*/", index + 2);
            index = end === -1 ? script.length - 1 : end + 1;
            maskRange(output, start, index);
        } else if (character === '"' || character === "'" || character === "`") {
            index = skipStringLiteral(script, index);
            maskRange(output, start, index);
            state.resetWord();
        } else if (
            character === "/" &&
            regexLiteralStartsAt(script, index, state.previousWord, state.followsControlCondition)
        ) {
            index = skipRegexLiteral(script, index);
            maskRange(output, start, index);
            state.resetWord();
        } else index = state.step(script, index);
    }
    return output.join("");
}

/**
 * Mask comments, string/template literals, and regex literals while retaining source offsets.
 * With `preserveTemplateInterpolations`, code inside `${...}` stays visible (used to vet executable
 * capability probes); without it, entire template literals are blanked (used for offset-safe parsing).
 */
export function maskLiterals(script: string, options: { preserveTemplateInterpolations?: boolean } = {}): string {
    return options.preserveTemplateInterpolations
        ? maskRegexLiterals(maskCommentsAndStrings(script))
        : maskAllLiterals(script);
}
