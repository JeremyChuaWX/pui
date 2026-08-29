import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createBundledSkillResources } from "#pi-core/bundled-skills.js";
import { BUNDLED_EXTENSION_FACTORIES } from "#pi-core/register.js";

export interface SmokeReport {
    /** Tool names registered by the bundled Extensions, in registration order. */
    tools: string[];
    /** Skill names Pi loaded from the bundled skill assets. */
    skills: string[];
    extensionErrors: string[];
    skillDiagnostics: string[];
}

export interface CollectSmokeReportOptions {
    temporaryDirectory?: string;
}

/**
 * Boot the Pi runtime headlessly against an isolated agent directory with only the bundled
 * Extensions and skills, and report what got registered. Never touches the user's Pi config.
 */
export async function collectSmokeReport(options: CollectSmokeReportOptions = {}): Promise<SmokeReport> {
    const root = await fs.promises.mkdtemp(path.join(options.temporaryDirectory ?? os.tmpdir(), "pui-smoke-"));
    try {
        const cwd = path.join(root, "cwd");
        const agentDir = path.join(root, "agent");
        await Promise.all([
            fs.promises.mkdir(cwd, { recursive: true }),
            fs.promises.mkdir(agentDir, { recursive: true }),
        ]);
        const bundledSkillResources = await createBundledSkillResources({ temporaryDirectory: root });
        try {
            const settingsManager = SettingsManager.inMemory();
            const resourceLoader = new DefaultResourceLoader({
                cwd,
                agentDir,
                settingsManager,
                additionalSkillPaths: bundledSkillResources.skillPaths,
                extensionFactories: BUNDLED_EXTENSION_FACTORIES,
                noPromptTemplates: true,
                noThemes: true,
                noContextFiles: true,
            });
            await resourceLoader.reload();
            const { session } = await createAgentSession({
                cwd,
                agentDir,
                settingsManager,
                resourceLoader,
                sessionManager: SessionManager.inMemory(cwd),
                sessionStartEvent: { type: "session_start", reason: "startup" },
            });
            try {
                const extensions = resourceLoader.getExtensions();
                const skills = resourceLoader.getSkills();
                return {
                    tools: extensions.extensions.flatMap((extension) => [...extension.tools.keys()]),
                    skills: skills.skills.map(({ name }) => name),
                    extensionErrors: extensions.errors.map(({ error }) => error),
                    skillDiagnostics: skills.diagnostics.map(({ message }) => message),
                };
            } finally {
                session.dispose();
            }
        } finally {
            await bundledSkillResources.dispose();
        }
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

/** `pui --smoke`: print the report as one JSON line; a non-empty error list fails the run. */
export async function runSmoke(): Promise<void> {
    const report = await collectSmokeReport();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.extensionErrors.length > 0 || report.skillDiagnostics.length > 0) {
        throw new Error("Smoke found extension errors or skill diagnostics; see the report on stdout.");
    }
}
