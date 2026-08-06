import * as fs from "node:fs";
import { FileWorkflowApprovalStore } from "../approval.js";

const [file, boundary, key, ready, gate] = process.argv.slice(2);
if (!file || !boundary || !key || !ready || !gate) throw new Error("Missing helper argument");
await fs.promises.writeFile(ready, "");
const deadline = Date.now() + 30_000;
for (;;) {
    try {
        await fs.promises.stat(gate);
        break;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for approval test gate");
    await new Promise((resolve) => setTimeout(resolve, 5));
}
await new FileWorkflowApprovalStore(file, boundary).add(key);
