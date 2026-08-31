import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { contract, renderAgentHelp, renderHelp, renderTeaser } from "../src/guide.ts";

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

function agentstartValidator(): string {
  const root = process.env.AGENTSTART_HOME ?? resolve(homedir(), "code/agentstart");
  return resolve(root, "scripts/validate-agent-contract.ts");
}

describe("agent contract", () => {
  test("guide --json publishes the contract inside the standard envelope", () => {
    const emitted = runCli(["guide", "--json"]);
    expect(emitted.exitCode).toBe(0);
    const envelope = JSON.parse(emitted.stdout);
    expect(envelope.schema_version).toBe(1);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeNull();
    expect(envelope.data.contract_version).toBe(1);
  });

  // The fleet's validator executes the normative schema in agentstart; this
  // repository owns the assertion that its own contract passes it. The check
  // stands down only where that checkout has no contract yet — set
  // AGENTSTART_HOME to a checkout that does.
  test.skipIf(!existsSync(agentstartValidator()))(
    "the published contract conforms to fleet agent contract version 1",
    async () => {
      const { validateContract } = (await import(agentstartValidator())) as {
        validateContract: (value: unknown) => readonly string[];
      };
      expect(validateContract(JSON.parse(runCli(["guide", "--json"]).stdout))).toEqual([]);
    },
  );

  test("every command the CLI dispatches is described, and nothing else", () => {
    const declared = new Set(contract().commands.map((command) => command.name));
    const dispatched = [
      "create",
      "list",
      "show",
      "status",
      "wait",
      "events",
      "claim",
      "release",
      "resolve",
      "return",
      "cancel",
      "prune",
      "tui",
      "process",
      "init",
      "serve",
      "credential",
      "client",
      "guide",
      "help",
    ];
    expect([...declared].sort()).toEqual([...dispatched].sort());
  });

  test("the help surfaces render from the contract", () => {
    const top = renderHelp();
    for (const command of contract().commands) expect(top).toContain(command.summary);
    expect(renderHelp(["create", "question"])).toContain("--payload-file");
    expect(renderHelp(["nope"])).toContain("Unknown command");
    expect(renderAgentHelp()).toContain("client_config_unreadable");
    expect(renderTeaser()).toContain("agentattention");

    const help = runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.trim()).toBe(top);
    expect(runCli(["--agent-help"]).stdout.trim()).toBe(renderAgentHelp());
    expect(runCli(["--agent-teaser"]).stdout.trim()).toBe(renderTeaser());
  });
});
