import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(join(import.meta.dir, ".."));
const script = join(root, "scripts", "install.sh");
const source = join(root, "src", "cli.ts");
const expectedSha = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"])
  .stdout.toString()
  .trim();
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const path of temporaryRoots) rmSync(path, { recursive: true, force: true });
});

interface Layout {
  home: string;
  binDir: string;
  stateDir: string;
  target: string;
  receipt: string;
  serverConfig: string;
  clientConfig: string;
}

function layout(): Layout {
  const home = mkdtempSync(join(tmpdir(), "agentattention-install-"));
  temporaryRoots.push(home);
  chmodSync(home, 0o700);
  const binDir = join(home, "bin");
  const stateDir = join(home, "state");
  mkdirSync(binDir, { mode: 0o755 });
  mkdirSync(stateDir, { mode: 0o700 });
  return {
    home,
    binDir,
    stateDir,
    target: join(binDir, "agentattention"),
    receipt: join(stateDir, "deployed-sha"),
    serverConfig: join(home, "config", "config.json"),
    clientConfig: join(home, "config", "client.json"),
  };
}

async function run(
  installLayout: Layout,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["bash", script, ...args], {
    cwd: tmpdir(),
    env: {
      ...Bun.env,
      HOME: installLayout.home,
      AGENTATTENTION_INSTALL_BIN_DIR: installLayout.binDir,
      AGENTATTENTION_INSTALL_STATE_DIR: installLayout.stateDir,
      AGENTATTENTION_INSTALL_SERVER_CONFIG: installLayout.serverConfig,
      AGENTATTENTION_INSTALL_CLIENT_CONFIG: installLayout.clientConfig,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("installer links the checkout, writes a receipt, and bootstraps private configs", async () => {
  const installLayout = layout();
  const first = await run(installLayout, "--install");

  expect(first.exitCode).toBe(0);
  expect(lstatSync(installLayout.target).isSymbolicLink()).toBe(true);
  expect(readlinkSync(installLayout.target)).toBe(source);
  expect(readFileSync(installLayout.receipt, "utf8")).toBe(`${expectedSha}\n`);
  expect(lstatSync(installLayout.receipt).mode & 0o777).toBe(0o600);
  expect(lstatSync(installLayout.serverConfig).mode & 0o777).toBe(0o600);
  expect(lstatSync(installLayout.clientConfig).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(installLayout.clientConfig, "utf8")).token).toStartWith("aat_");

  expect((await run(installLayout, "--install")).exitCode).toBe(0);
});

test("installer refuses foreign commands and uncorroborated receipts", async () => {
  const foreign = layout();
  writeFileSync(foreign.target, "foreign\n");
  const foreignResult = await run(foreign, "--install");
  expect(foreignResult.exitCode).toBe(1);
  expect(foreignResult.stderr).toContain("refusing foreign command path");
  expect(readFileSync(foreign.target, "utf8")).toBe("foreign\n");

  const uncorroborated = layout();
  writeFileSync(uncorroborated.receipt, `${expectedSha}\n`, { mode: 0o600 });
  const receiptResult = await run(uncorroborated, "--install");
  expect(receiptResult.exitCode).toBe(1);
  expect(receiptResult.stderr).toContain("uncorroborated deployed receipt");
});

test("uninstall removes only the command and receipt", async () => {
  const installLayout = layout();
  expect((await run(installLayout, "--install")).exitCode).toBe(0);
  expect((await run(installLayout, "--uninstall")).exitCode).toBe(0);
  expect(existsSync(installLayout.target)).toBe(false);
  expect(existsSync(installLayout.receipt)).toBe(false);
  expect(existsSync(installLayout.serverConfig)).toBe(true);
  expect(existsSync(installLayout.clientConfig)).toBe(true);
});
