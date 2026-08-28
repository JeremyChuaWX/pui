import { parseHeadlessWorkflowArgs, runHeadlessWorkflow } from "#modules/workflows/interfaces/host.js";

/** Headless `pui workflow` entry: Pi Core + the workflows Host Entry, no UI imports. */
export async function runHeadlessWorkflowCli(argv: string[]): Promise<void> {
    const result = await runHeadlessWorkflow({
        ...parseHeadlessWorkflowArgs(argv),
        onProgress: (message) => process.stderr.write(`pui workflow: ${message}\n`),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}
