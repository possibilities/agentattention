#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ClientCommandContext,
  ClientUsageError,
  runClientCommand,
} from "./client-commands.ts";
import {
  addCredential,
  createInitialConfig,
  createOrRotateLocalClient,
  defaultClientConfigPath,
  defaultConfigPath,
  loadConfig,
  saveClientConfig,
  saveConfig,
} from "./config.ts";
import { startDaemon } from "./daemon.ts";
import { failureEnvelope, successEnvelope } from "./envelope.ts";
import { conflict, notFound, ServiceError } from "./errors.ts";
import { contract, renderAgentHelp, renderHelp, renderTeaser } from "./guide.ts";

interface CliContext extends ClientCommandContext {
  args: string[];
}

class UsageError extends Error {}

await main();

async function main(): Promise<void> {
  try {
    const context = parseGlobal(process.argv.slice(2));
    const [command, ...args] = context.args;
    if (command === "help" || command === "--help" || command === "-h") {
      console.log(renderHelp(args));
      return;
    }
    if (command === "--agent-help") {
      console.log(renderAgentHelp());
      return;
    }
    if (command === "--agent-teaser") {
      console.log(renderTeaser());
      return;
    }
    if (command === "guide") {
      if (args.length > 0) throw new UsageError("guide takes no arguments");
      console.log(context.json ? JSON.stringify(successEnvelope(contract())) : renderAgentHelp());
      return;
    }
    if (!command) {
      await runClientCommand("tui", [], context);
      return;
    }
    if (command === "init") {
      initialize(context, args);
      return;
    }
    if (command === "serve") {
      if (args.length > 0) throw new UsageError("serve takes no arguments");
      await serve(context);
      return;
    }
    if (command === "credential") {
      credential(context, args);
      return;
    }
    if (command === "client") {
      client(context, args);
      return;
    }
    if (await runClientCommand(command, args, context)) return;
    throw new UsageError(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ClientUsageError) {
      console.error(`${error.message}\n\n${renderHelp()}`);
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
      console.log(JSON.stringify(failureEnvelope(serviceError.code, serviceError.message)));
    } else {
      console.error(`${serviceError.code}: ${serviceError.message}`);
    }
    process.exitCode = 1;
  }
}

function initialize(context: CliContext, args: string[]): void {
  if (args.length > 0) throw new UsageError("init takes no arguments");
  if (existsSync(context.serverConfigPath)) {
    throw conflict("config_exists", `Configuration already exists at ${context.serverConfigPath}`);
  }
  if (existsSync(context.clientConfigPath)) {
    throw conflict(
      "client_config_exists",
      `Client configuration already exists at ${context.clientConfigPath}`,
    );
  }
  const created = createInitialConfig();
  saveConfig(context.serverConfigPath, created.config);
  saveClientConfig(context.clientConfigPath, created.client);
  output(context, {
    configPath: context.serverConfigPath,
    clientConfigPath: context.clientConfigPath,
    database: created.config.database,
    administratorPrincipal: created.config.credentials[0]?.id,
    administratorToken: created.administratorToken,
    clientPrincipal: created.client.principal,
    warning: "The administrator token is shown once; the local client token is stored mode 0600.",
  });
}

async function serve(context: CliContext): Promise<void> {
  const config = loadConfig(context.serverConfigPath);
  const daemon = startDaemon(config);
  if (context.json) {
    console.log(JSON.stringify(successEnvelope({ status: "ready", url: daemon.url })));
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
  const config = loadConfig(context.serverConfigPath);
  if (subcommand === "list") {
    if (rest.length > 0) throw new UsageError("credential list takes no arguments");
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
    saveConfig(context.serverConfigPath, created.config);
    output(context, {
      id: created.credential.id,
      name: created.credential.name,
      scopes: created.credential.scopes,
      token: created.token,
      warning: "This token is shown once; restart the service after credential changes.",
    });
    return;
  }
  if (subcommand === "revoke") {
    const reference = rest[0];
    if (!reference || rest.length !== 1) {
      throw new UsageError("credential revoke requires one id or exact name");
    }
    const matches = config.credentials.filter(
      (entry) => entry.id === reference || entry.name.toLowerCase() === reference.toLowerCase(),
    );
    if (matches.length === 0) throw notFound("Credential not found");
    if (matches.length > 1) {
      throw conflict("ambiguous_credential", "Credential name is ambiguous; use its id");
    }
    const target = matches[0];
    if (!target) throw notFound("Credential not found");
    const remaining = config.credentials.filter((entry) => entry.id !== target.id);
    if (
      target.scopes.includes("admin") &&
      !remaining.some((entry) => entry.scopes.includes("admin"))
    ) {
      throw conflict("last_admin", "Cannot revoke the last administrator credential");
    }
    saveConfig(context.serverConfigPath, { ...config, credentials: remaining });
    output(context, { revoked: { id: target.id, name: target.name }, restartRequired: true });
    return;
  }
  throw new UsageError("credential requires create, list, or revoke");
}

function client(context: CliContext, args: string[]): void {
  const [subcommand, ...rest] = args;
  if (subcommand !== "init") throw new UsageError("client requires init");
  if (rest.length > 0) throw new UsageError("client init takes no arguments");
  if (existsSync(context.clientConfigPath)) {
    throw conflict(
      "client_config_exists",
      `Client configuration already exists at ${context.clientConfigPath}`,
    );
  }

  const created = createOrRotateLocalClient(loadConfig(context.serverConfigPath));
  saveConfig(context.serverConfigPath, created.config);
  saveClientConfig(context.clientConfigPath, created.client);
  output(context, {
    clientConfigPath: context.clientConfigPath,
    principal: created.client.principal,
    credential: created.action,
    restartRequired: true,
    warning: "The local client token was stored mode 0600 and was not printed.",
  });
}

function parseGlobal(args: string[]): CliContext {
  let json = false;
  let serverConfigPath = defaultConfigPath();
  let clientConfigPath = defaultClientConfigPath();
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--config" || argument === "--client-config") {
      const value = args[index + 1];
      if (!value) throw new UsageError(`${argument} requires a path`);
      if (argument === "--config") serverConfigPath = resolve(value);
      else clientConfigPath = resolve(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--config=")) {
      serverConfigPath = resolve(argument.slice("--config=".length));
      continue;
    }
    if (argument?.startsWith("--client-config=")) {
      clientConfigPath = resolve(argument.slice("--client-config=".length));
      continue;
    }
    remaining.push(argument ?? "");
  }
  return { json, serverConfigPath, clientConfigPath, args: remaining };
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new UsageError(`${name} is required`);
  return value;
}

function output(context: CliContext, data: unknown): void {
  if (context.json) console.log(JSON.stringify(successEnvelope(data)));
  else console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}
