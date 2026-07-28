import * as fs from "node:fs";
import { FileWorkflowApprovalStore } from "./approval.js";

const [file, boundary, key, ready, gate] = process.argv.slice(2);
if (!file || !boundary || !key || !ready || !gate) throw new Error("Missing helper argument");
await fs.promises.writeFile(ready, "");
while (
    !(await fs.promises.stat(gate).then(
        () => true,
        () => false,
    ))
)
    await new Promise((resolve) => setTimeout(resolve, 5));
await new FileWorkflowApprovalStore(file, boundary).add(key);
