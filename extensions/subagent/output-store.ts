import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Owns private full-output files for one extension session. */
export class SessionOutputStore {
    private readonly directories = new Set<string>();
    private readonly pending = new Set<Promise<string | undefined>>();
    private closed = false;

    save(output: string): Promise<string | undefined> {
        if (this.closed) return Promise.resolve(undefined);
        const pending = this.write(output).finally(() => this.pending.delete(pending));
        this.pending.add(pending);
        return pending;
    }

    async cleanup(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await Promise.allSettled([...this.pending]);
        const directories = [...this.directories];
        this.directories.clear();
        await Promise.allSettled(
            directories.map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
        );
    }

    private async write(output: string): Promise<string | undefined> {
        let directory: string | undefined;
        try {
            directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
            this.directories.add(directory);
            await fs.promises.chmod(directory, 0o700);
            const outputPath = path.join(directory, "output.md");
            await fs.promises.writeFile(outputPath, output, { encoding: "utf8", mode: 0o600 });
            if (!this.closed) return outputPath;
        } catch {
            // A spill failure leaves the bounded result usable.
        }
        if (directory) {
            this.directories.delete(directory);
            await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
        }
        return undefined;
    }
}
