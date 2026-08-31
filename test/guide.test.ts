import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commandSpec, contract } from "../src/contract.ts";
import { renderAgentHelp, renderHelp, renderTeaser } from "../src/guide.ts";

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

  // The parser is built from the contract (commandSpec), so this asserts the
  // seam rather than a second list: every declared flag is accepted by the
  // command that declares it, and an undeclared one is refused.
  test("the argv grammar of every client command derives from the contract", () => {
    const paths = [
      "create question",
      "create approval",
      "create browser",
      "list",
      "status",
      "wait",
      "events",
      "claim",
      "release",
      "resolve",
      "return",
      "cancel",
      "prune",
    ];
    // A well-formed credential for a port nothing serves: the parse happens
    // before any request, and no call can reach a live queue.
    const directory = mkdtempSync(join(tmpdir(), "agentattention-grammar-"));
    const clientConfig = join(directory, "client.json");
    writeFileSync(
      clientConfig,
      JSON.stringify({
        version: 1,
        url: "http://127.0.0.1:1",
        token: "aat_grammar_probe",
        principal: { id: "prn_probe", name: "probe" },
      }),
    );
    const offline = ["--client-config", clientConfig];
    try {
      for (const path of paths) {
        const spec = commandSpec(path);
        for (const flag of [...spec.values, ...spec.repeat]) {
          const result = runCli([...offline, ...path.split(" "), flag, "value"]);
          expect(`${path} ${flag}: ${result.stderr}`).not.toContain("Unknown option");
        }
        for (const flag of spec.flags) {
          const result = runCli([...offline, ...path.split(" "), flag]);
          expect(`${path} ${flag}: ${result.stderr}`).not.toContain("Unknown option");
        }
        const refused = runCli([...offline, ...path.split(" "), "--undeclared", "value"]);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr).toContain("Unknown option: --undeclared");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the help surfaces render from the contract", () => {
    const top = renderHelp();
    for (const command of contract().commands) expect(top).toContain(command.summary);
    const question = renderHelp(["create", "question"]);
    expect(question).toContain("--payload-file");
    expect(question).toContain("Examples:");
    expect(question).toContain("at least one of --question, --payload-file");
    expect(renderHelp(["wait"])).toContain("Blocks:");
    expect(renderHelp(["help"])).toContain("Also spelled: --help, -h.");
    expect(renderHelp(["claim"])).toContain("(5 to");
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
