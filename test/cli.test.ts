import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ALL_SCOPES,
  createInitialConfig,
  loadClientConfig,
  loadConfig,
  saveConfig,
} from "../src/config.ts";
import { contract } from "../src/guide.ts";
import { hashToken } from "../src/ids.ts";

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const path of temporaryRoots) rmSync(path, { recursive: true, force: true });
});

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

describe("CLI entrypoint", () => {
  test("runs through its executable shebang without a startup initialization error", () => {
    const result = runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(contract().meta.purpose.split(":")[0] ?? "");
    expect(result.stdout).toContain("Agent commands:");
    expect(result.stderr).toBe("");
  });

  test("uses the queue TUI as the bare-command default", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentattention-bare-command-"));
    temporaryRoots.push(directory);
    const missingClientConfig = join(directory, "missing-client.json");
    const result = runCli(["--json", "--client-config", missingClientConfig]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).error.code).toBe("client_config_unreadable");
    expect(result.stdout).not.toContain("Agent commands:");
  });

  test("creates and recovers the standard local client without printing its token", () => {
    const directory = mkdtempSync(join(tmpdir(), "agentattention-client-init-"));
    temporaryRoots.push(directory);
    chmodSync(directory, 0o700);
    const serverConfig = join(directory, "config.json");
    const clientConfig = join(directory, "client.json");
    const initialized = createInitialConfig();
    const administrator = initialized.config.credentials.find((entry) =>
      entry.scopes.includes("admin"),
    );
    if (!administrator) throw new Error("initial config omitted administrator");
    saveConfig(serverConfig, {
      ...initialized.config,
      database: join(directory, "attention.sqlite3"),
      credentials: [administrator],
    });
    const args = [
      "--json",
      "--config",
      serverConfig,
      "--client-config",
      clientConfig,
      "client",
      "init",
    ];

    const first = runCli(args);
    const firstStdout = first.stdout;
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(firstStdout).not.toContain("aat_");
    expect(JSON.parse(firstStdout).data.credential).toBe("created");
    expect(lstatSync(clientConfig).mode & 0o777).toBe(0o600);

    const firstServer = loadConfig(serverConfig);
    const firstClient = loadClientConfig(clientConfig);
    const firstCredential = firstServer.credentials.find(
      (entry) => entry.id === firstClient.principal.id,
    );
    expect(firstCredential?.scopes).toEqual([...ALL_SCOPES]);
    expect(firstCredential?.tokenHash).toBe(hashToken(firstClient.token));

    const unchangedServer = readFileSync(serverConfig, "utf8");
    const refused = runCli(args);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.code).toBe("client_config_exists");
    expect(readFileSync(serverConfig, "utf8")).toBe(unchangedServer);

    unlinkSync(clientConfig);
    const recovered = runCli(args);
    const recoveredStdout = recovered.stdout;
    expect(recovered.exitCode).toBe(0);
    expect(recoveredStdout).not.toContain("aat_");
    expect(JSON.parse(recoveredStdout).data.credential).toBe("rotated");

    const recoveredServer = loadConfig(serverConfig);
    const recoveredClient = loadClientConfig(clientConfig);
    const recoveredCredential = recoveredServer.credentials.find(
      (entry) => entry.id === recoveredClient.principal.id,
    );
    expect(recoveredServer.credentials).toHaveLength(firstServer.credentials.length);
    expect(recoveredClient.principal).toEqual(firstClient.principal);
    expect(recoveredCredential?.tokenHash).not.toBe(firstCredential?.tokenHash);
    expect(recoveredCredential?.tokenHash).toBe(hashToken(recoveredClient.token));
  });
});
