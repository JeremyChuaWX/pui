import { describe, expect, test } from "bun:test";
import { maskLiterals, regexLiteralStartsAt, skipRegexLiteral, skipStringLiteral } from "./js-scan.js";

describe("regexLiteralStartsAt", () => {
    test("treats a slash at the start of input or after a statement boundary as a regex", () => {
        expect(regexLiteralStartsAt("/re/", 0, undefined, false)).toBe(true);
        expect(regexLiteralStartsAt("if (a) /re/", 7, undefined, true)).toBe(true);
        expect(regexLiteralStartsAt("}\n/re/", 2, undefined, false)).toBe(true);
    });

    test("treats a slash after operators, keywords, and punctuation as a regex", () => {
        expect(regexLiteralStartsAt("x = /re/", 4, undefined, false)).toBe(true);
        expect(regexLiteralStartsAt("f(/re/)", 2, undefined, false)).toBe(true);
        expect(regexLiteralStartsAt("return /re/", 7, "return", false)).toBe(true);
        expect(regexLiteralStartsAt("typeof /re/", 7, "typeof", false)).toBe(true);
        expect(regexLiteralStartsAt("case /re/", 5, "case", false)).toBe(true);
    });

    test("treats a slash after values as division", () => {
        expect(regexLiteralStartsAt("a /2", 2, "a", false)).toBe(false);
        expect(regexLiteralStartsAt("f() /2", 4, undefined, false)).toBe(false);
        expect(regexLiteralStartsAt("a[0] /2", 5, undefined, false)).toBe(false);
    });

    test("treats a slash after ++ and -- as division", () => {
        expect(regexLiteralStartsAt("a++ /re/", 4, undefined, false)).toBe(false);
        expect(regexLiteralStartsAt("a-- /re/", 4, undefined, false)).toBe(false);
    });
});

describe("skip helpers", () => {
    test("skipStringLiteral honors escape sequences and stops at the matching quote", () => {
        expect(skipStringLiteral('"a\\"b" rest', 0)).toBe(5);
        expect(skipStringLiteral("'it\\'s' rest", 0)).toBe(6);
        expect(skipStringLiteral('"unterminated', 0)).toBe(13);
    });

    test("skipRegexLiteral honors escapes, character classes, and flags", () => {
        expect(skipRegexLiteral("/a\\/b[/]c/i;", 0)).toBe(10);
        expect(skipRegexLiteral("/[^a-z]/gu + 1", 0)).toBe(9);
    });
});

describe("maskLiterals", () => {
    test("masks quoted strings with escape sequences and keeps trailing division", () => {
        const script = 'x = "a\\"b" / 2';
        expect(maskLiterals(script)).toBe(`x = ${" ".repeat(6)} / 2`);
        expect(maskLiterals(script)).toHaveLength(script.length);
    });

    test("masks line and block comments while preserving newlines", () => {
        expect(maskLiterals("a // x\nb; /* y */ c")).toBe(`a ${" ".repeat(4)}\nb; ${" ".repeat(7)} c`);
        expect(maskLiterals("/* a\nb */ x")).toBe(`${" ".repeat(4)}\n${" ".repeat(4)} x`);
    });

    test("masks whole template literals by default, including interpolation code", () => {
        expect(maskLiterals(`\`a\${b}c\` + d`)).toBe(`${" ".repeat(8)} + d`);
        expect(maskLiterals(`\`\${process.env}\``)).not.toContain("process");
    });

    test("keeps interpolation code visible when preserveTemplateInterpolations is set", () => {
        const options = { preserveTemplateInterpolations: true };
        expect(maskLiterals(`\`\${process.env}\``, options)).toBe("   process.env  ");
        expect(maskLiterals(`\`a\${\`b\${c}\`}d\`;`, options)).toBe(`${" ".repeat(8)}c${" ".repeat(5)};`);
    });

    test("masks regex literals after operators, keywords, and control parens", () => {
        expect(maskLiterals("x = /ab/g;")).toBe(`x = ${" ".repeat(5)};`);
        expect(maskLiterals("return /ab/;")).toBe(`return ${" ".repeat(4)};`);
        expect(maskLiterals("if (a) /re/.test(x)")).toBe(`if (a) ${" ".repeat(4)}.test(x)`);
        expect(maskLiterals("x = /ab/g; // c", { preserveTemplateInterpolations: true })).toBe(
            `x = ${" ".repeat(5)}; ${" ".repeat(4)}`,
        );
    });

    test("leaves division untouched after identifiers, calls, and ++/--", () => {
        for (const script of ["a / b / c", "(1 + 2) / 3", "a++ / 2", "i-- / 2 / j"]) {
            expect(maskLiterals(script)).toBe(script);
            expect(maskLiterals(script, { preserveTemplateInterpolations: true })).toBe(script);
        }
    });

    test("masks regexes containing escaped slashes and character classes exactly", () => {
        const script = "x = /a\\/b[/]c/i; y";
        expect(maskLiterals(script)).toBe(`x = ${" ".repeat(11)}; y`);
    });
});
