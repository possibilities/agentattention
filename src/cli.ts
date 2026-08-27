#!/usr/bin/env bun

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  type AppConfig,
  addCredential,
  createInitialConfig,
  defaultConfigPath,
  loadConfig,
  saveConfig,
} from "./config.ts";
import { startDaemon } from "./daemon.ts";
import { conflict, notFound, ServiceError } from "./errors.ts";

const SERVICE_LABEL = "com.arthack.agentattention";

interface CliContext {
  json: boolean;
  configPath: string;
  args: string[];
}

await main();

async function main(): Promise<void> {
  try {
    const context = parseGlobal(process.argv.slice(2));
    const [command, ...args] = context.args;
    if (!command || command === "help" || command === "--help" || command === "-h") {
      console.log(usage());
      return;
    }
    if (command === "init") {
      initialize(context);
      return;
    }
    if (command === "serve") {
      await serve(context);
      return;
    }
    if (command === "credential") {
      credential(context, args);
      return;
    }
    if (command === "daemon") {
      daemon(context, args);
      return;
    }
    throw new UsageError(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${usage()}`);
      process.exitCode = 2;
      return;
    }
    const serviceError =
      error instanceof ServiceError
        ? error
        : new ServiceError(
            "internal_error",
            500,
            error instanceof Error ? error.message : String(error),
          );
    const json = process.argv.includes("--json");
    if (json) {
      console.log(
        JSON.stringify({
          ok: false,
          error: { code: serviceError.code, message: serviceError.message },
        }),
      );
    } else {
      console.error(`${serviceError.code}: ${serviceError.message}`);
    }
    process.exitCode = 1;
  }
}

function initialize(context: CliContext): void {
  if (existsSync(context.configPath)) {
    throw conflict("config_exists", `Configuration already exists at ${context.configPath}`);
  }
  const { config, token } = createInitialConfig();
  saveConfig(context.configPath, config);
  output(context, {
    configPath: context.configPath,
    database: config.database,
    principal: config.credentials[0]?.id,
    token,
    warning: "This administrator token is shown once; store it securely.",
  });
}

async function serve(context: CliContext): Promise<void> {
  const config = loadConfig(context.configPath);
  const daemon = startDaemon(config);
  if (context.json) {
    console.log(JSON.stringify({ ok: true, data: { status: "ready", url: daemon.url } }));
  } else {
    console.log(`agentattention ready at ${daemon.url}`);
  }
  await new Promise<void>((resolvePromise) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await daemon.stop();
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function credential(context: CliContext, args: string[]): void {
  const [subcommand, ...rest] = args;
  const config = loadConfig(context.configPath);
  if (subcommand === "list") {
    output(
      context,
      config.credentials.map(({ id, name, scopes }) => ({ id, name, scopes })),
    );
    return;
  }
  if (subcommand === "create") {
    const name = option(rest, "--name");
    const scopes = option(rest, "--scopes")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);
    const created = addCredential(config, name, scopes);
    saveConfig(context.configPath, created.config);
    output(context, {
      id: created.credential.id,
      name: created.credential.name,
      scopes: created.credential.scopes,
      token: created.token,
      warning: "This token is shown once; restart the daemon after credential changes.",
    });
    return;
  }
  if (subcommand === "revoke") {
    const reference = rest[0];
    if (!reference || rest.length !== 1)
      throw new UsageError("credential revoke requires one id or exact name");
    const matches = config.credentials.filter(
      (entry) => entry.id === reference || entry.name.toLowerCase() === reference.toLowerCase(),
    );
    if (matches.length === 0) throw notFound("Credential not found");
    if (matches.length > 1)
      throw conflict("ambiguous_credential", "Credential name is ambiguous; use its id");
    const target = matches[0];
    if (!target) throw notFound("Credential not found");
    const remaining = config.credentials.filter((entry) => entry.id !== target.id);
    if (
      target.scopes.includes("admin") &&
      !remaining.some((entry) => entry.scopes.includes("admin"))
    ) {
      throw conflict("last_admin", "Cannot revoke the last administrator credential");
    }
    saveConfig(context.configPath, { ...config, credentials: remaining });
    output(context, { revoked: { id: target.id, name: target.name }, restartRequired: true });
    return;
  }
  throw new UsageError("credential requires create, list, or revoke");
}

function daemon(context: CliContext, args: string[]): void {
  const [subcommand] = args;
  if (!subcommand || args.length !== 1)
    throw new UsageError("daemon requires install, start, stop, status, or uninstall");
  const plistPath = launchAgentPath();
  if (subcommand === "install") {
    const config = loadConfig(context.configPath);
    installLaunchAgent(context, config, plistPath);
    return;
  }
  if (subcommand === "start") {
    if (!existsSync(plistPath)) throw notFound(`LaunchAgent is not installed at ${plistPath}`);
    const alreadyRunning = Bun.spawnSync(
      ["launchctl", "print", `${launchDomain()}/${SERVICE_LABEL}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (alreadyRunning.exitCode === 0) {
      output(context, { status: "running", label: SERVICE_LABEL });
      return;
    }
    runLaunchctl(["bootstrap", launchDomain(), plistPath], false);
    output(context, { status: "started", label: SERVICE_LABEL });
    return;
  }
  if (subcommand === "stop") {
    const stopped = runLaunchctl(["bootout", `${launchDomain()}/${SERVICE_LABEL}`], true);
    output(context, { status: stopped ? "stopped" : "not_loaded", label: SERVICE_LABEL });
    return;
  }
  if (subcommand === "status") {
    const result = Bun.spawnSync(["launchctl", "print", `${launchDomain()}/${SERVICE_LABEL}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const loaded = result.exitCode === 0;
    output(context, {
      status: loaded ? "running" : "stopped",
      installed: existsSync(plistPath),
      label: SERVICE_LABEL,
    });
    if (!loaded) process.exitCode = 3;
    return;
  }
  if (subcommand === "uninstall") {
    runLaunchctl(["bootout", `${launchDomain()}/${SERVICE_LABEL}`], true);
    if (existsSync(plistPath)) unlinkSync(plistPath);
    output(context, { status: "uninstalled", label: SERVICE_LABEL, removed: plistPath });
    return;
  }
  throw new UsageError(`Unknown daemon command: ${subcommand}`);
}

function installLaunchAgent(context: CliContext, config: AppConfig, plistPath: string): void {
  const stateDirectory = dirname(config.database);
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const cliPath = resolve(process.argv[1] ?? "src/cli.ts");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(cliPath)}</string>
    <string>serve</string>
    <string>--config</string>
    <string>${xml(context.configPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(resolve(stateDirectory, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(resolve(stateDirectory, "daemon.error.log"))}</string>
</dict>
</plist>
`;
  writeFileSync(plistPath, plist, { mode: 0o644 });
  runLaunchctl(["bootout", `${launchDomain()}/${SERVICE_LABEL}`], true);
  runLaunchctl(["bootstrap", launchDomain(), plistPath], false);
  output(context, { status: "installed", label: SERVICE_LABEL, plist: plistPath });
}

function runLaunchctl(args: string[], allowFailure: boolean): boolean {
  const result = Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 && !allowFailure) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new ServiceError("launchctl_failed", 500, detail || `launchctl ${args[0]} failed`);
  }
  return result.exitCode === 0;
}

function parseGlobal(args: string[]): CliContext {
  let json = false;
  let configPath = defaultConfigPath();
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--config") {
      const value = args[index + 1];
      if (!value) throw new UsageError("--config requires a path");
      configPath = resolve(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--config=")) {
      configPath = resolve(argument.slice("--config=".length));
      continue;
    }
    remaining.push(argument ?? "");
  }
  return { json, configPath, args: remaining };
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new UsageError(`${name} is required`);
  return value;
}

function output(context: CliContext, data: unknown): void {
  if (context.json) console.log(JSON.stringify({ ok: true, data }));
  else console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function launchAgentPath(): string {
  return resolve(homedir(), "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function launchDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function usage(): string {
  return `agentattention — durable human-attention control plane

Usage:
  agentattention [--config PATH] [--json] init
  agentattention [--config PATH] [--json] serve
  agentattention [--config PATH] [--json] credential create --name NAME --scopes SCOPE,...
  agentattention [--config PATH] [--json] credential list
  agentattention [--config PATH] [--json] credential revoke ID_OR_NAME
  agentattention [--config PATH] [--json] daemon install|start|stop|status|uninstall

The default config is ${defaultConfigPath()}.
Run init once; it prints the only copy of the initial administrator token.`;
}

class UsageError extends Error {}
