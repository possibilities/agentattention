import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("CLI entrypoint", () => {
  test("runs through its executable shebang without a startup initialization error", () => {
    const cli = resolve(import.meta.dir, "../src/cli.ts");
    const result = Bun.spawnSync([cli, "--help"], { stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("agentattention — durable human-attention control plane");
    expect(stderr).toBe("");
  });
});
