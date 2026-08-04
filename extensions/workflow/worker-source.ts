import bootstrapText from "./worker/bootstrap.js.txt" with { type: "text" };
import workerTemplate from "./worker/worker.js.txt" with { type: "text" };

// bootstrap.js.txt: the only cross-realm value retained by VM code is the closure's bridge. Its
// callable wrappers and every value visible to workflow code are created by the context itself.
// worker.js.txt: the function-entrypoint prefix keeps its historical byte length — stack columns
// feed durable agent identities — and bridge operations are drained because fail-fast user promises
// may otherwise leave sibling RPCs pending. Do not reformat either file.
const BOOTSTRAP_TOKEN = "__PUI_BOOTSTRAP_SOURCE_JSON__";
const BOOTSTRAP_SOURCE = bootstrapText.trimEnd();
if (!workerTemplate.includes(BOOTSTRAP_TOKEN)) throw new Error("Workflow worker template is missing bootstrap token.");
export const WORKER_SOURCE = workerTemplate.trimEnd().replace(BOOTSTRAP_TOKEN, () => JSON.stringify(BOOTSTRAP_SOURCE));
