import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectSmokeReport } from "./smoke.js";

describe("headless smoke entry", () => {
    test("reports every bundled tool and skill registered through Pi's runtime", async () => {
        const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pui-smoke-entry-test-"));
        try {
            const report = await collectSmokeReport({ temporaryDirectory: temp });
            expect(report.tools).toEqual([
                "fd",
                "rg",
                "explorer",
                "worker",
                "subagent_wait",
                "subagent_check",
                "subagent_cancel",
                "subagent",
                "web_search",
                "web_crawl",
            ]);
            expect(report.skills).toEqual(["unslop"]);
            expect(report.extensionErrors).toEqual([]);
            expect(report.skillDiagnostics).toEqual([]);
            // The isolated agent directory and skill copies are removed once the report is built.
            expect(await fs.promises.readdir(temp)).toEqual([]);
        } finally {
            await fs.promises.rm(temp, { recursive: true, force: true });
        }
    });
});
