import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { AttentionClient, type ListEventOptions, type ListItemOptions } from "./client.ts";
import { loadClientConfig } from "./config.ts";
import {
  BROWSER_INTERACTION_CONTRACT,
  DOCUMENT_APPROVAL_CONTRACT,
  parseBrowserInteractionPayload,
  parseDocumentApprovalPayload,
  parseQuestionPayload,
  QUESTION_CONTRACT,
} from "./contracts/index.ts";
import type { AttentionItem, AttentionStatus, CreateItemInput, JsonValue } from "./domain.ts";
import { badRequest } from "./errors.ts";
import { parseCreateItem } from "./validation.ts";
import { waitForAttention } from "./wait.ts";

export interface ClientCommandContext {
  json: boolean;
  clientConfigPath: string;
  serverConfigPath: string;
}

export class ClientUsageError extends Error {}

export async function runClientCommand(
  command: string,
  args: string[],
  context: ClientCommandContext,
): Promise<boolean> {
  if (command === "create") {
    await createCommand(context, args);
    return true;
  }
  if (command === "list") {
    await listCommand(context, args);
    return true;
  }
  if (command === "show") {
    await showCommand(context, args);
    return true;
  }
  if (command === "status") {
    await statusCommand(context, args);
    return true;
  }
  if (command === "wait") {
    await waitCommand(context, args);
    return true;
  }
  if (command === "events") {
    await eventsCommand(context, args);
    return true;
  }
  if (command === "claim") {
    await claimCommand(context, args);
    return true;
  }
  if (command === "release") {
    await releaseCommand(context, args);
    return true;
  }
  if (command === "resolve") {
    await resolveCommand(context, args);
    return true;
  }
  if (command === "return") {
    await returnCommand(context, args);
    return true;
  }
  if (command === "cancel") {
    await cancelCommand(context, args);
    return true;
  }
  if (command === "prune") {
    await pruneCommand(context, args);
    return true;
  }
  if (command === "tui") {
    exactPositionals(parseArgs(args, [], []), 0, "tui takes no arguments");
    const { runQueueTui } = await import("./tui/queue.ts");
    await runQueueTui(loadClientConfig(context.clientConfigPath), {
      clientConfigPath: context.clientConfigPath,
      serverConfigPath: context.serverConfigPath,
    });
    return true;
  }
  if (command === "process") {
    const parsed = parseArgs(args, [], []);
    exactPositionals(parsed, 1, "process requires one attention item id");
    const { runAttentionProcessor } = await import("./tui/processor.ts");
    await runAttentionProcessor(
      loadClientConfig(context.clientConfigPath),
      parsed.positionals[0] ?? "",
    );
    return true;
  }
  return false;
}

async function createCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const [kind, ...rest] = args;
  const client = commandClient(context);
  if (kind === "question") {
    const parsed = parseArgs(
      rest,
      [
        "--title",
        "--context",
        "--context-file",
        "--payload-file",
        "--priority",
        "--correlation",
        "--parent",
        "--use-before",
        "--idempotency-key",
      ],
      [],
      ["--question", "--choice", "--label"],
    );
    exactPositionals(parsed, 0, "create question accepts options only");
    const payloadFile = parsed.value("--payload-file");
    const questionTexts = parsed.values("--question");
    const choiceTexts = parsed.values("--choice");
    if (payloadFile && (questionTexts.length > 0 || choiceTexts.length > 0)) {
      throw new ClientUsageError("--payload-file cannot be combined with --question or --choice");
    }
    let payload: JsonValue;
    if (payloadFile) {
      payload = parseQuestionPayload(await readJsonSource(payloadFile)) as unknown as JsonValue;
    } else {
      if (questionTexts.length === 0)
        throw new ClientUsageError("create question requires --question");
      if (choiceTexts.length > 0 && questionTexts.length !== 1) {
        throw new ClientUsageError("--choice is available only when creating one question");
      }
      payload = parseQuestionPayload({
        questions: questionTexts.map((prompt, index) => ({
          id: `q${index + 1}`,
          prompt,
          ...(choiceTexts.length === 0
            ? {}
            : {
                choices: choiceTexts.map((choice) => {
                  const separator = choice.indexOf("=");
                  return separator < 1
                    ? { value: choice, label: choice }
                    : { value: choice.slice(0, separator), label: choice.slice(separator + 1) };
                }),
              }),
        })),
      }) as unknown as JsonValue;
    }
    const input = await createEnvelope(parsed, QUESTION_CONTRACT, payload);
    commandOutput(
      context,
      await client.createItem(input, parsed.value("--idempotency-key") ?? crypto.randomUUID()),
    );
    return;
  }
  if (kind === "approval") {
    const parsed = parseArgs(
      rest,
      [
        "--title",
        "--context",
        "--context-file",
        "--document",
        "--format",
        "--priority",
        "--correlation",
        "--parent",
        "--use-before",
        "--idempotency-key",
      ],
      [],
      ["--label"],
    );
    exactPositionals(parsed, 0, "create approval accepts options only");
    const documentPath = required(parsed, "--document");
    const format =
      parsed.value("--format") ??
      (extname(documentPath).toLowerCase() === ".md" ? "markdown" : "plain");
    const payload = parseDocumentApprovalPayload({
      format,
      document: await readTextSource(documentPath),
    }) as unknown as JsonValue;
    const input = await createEnvelope(parsed, DOCUMENT_APPROVAL_CONTRACT, payload);
    commandOutput(
      context,
      await client.createItem(input, parsed.value("--idempotency-key") ?? crypto.randomUUID()),
    );
    return;
  }
  if (kind === "browser") {
    const parsed = parseArgs(
      rest,
      [
        "--title",
        "--context",
        "--context-file",
        "--target",
        "--action",
        "--priority",
        "--correlation",
        "--parent",
        "--use-before",
        "--idempotency-key",
      ],
      [],
      ["--label"],
    );
    exactPositionals(parsed, 0, "create browser accepts options only");
    const payload = parseBrowserInteractionPayload({
      targetName: required(parsed, "--target"),
      requestedAction: required(parsed, "--action"),
    }) as unknown as JsonValue;
    const input = await createEnvelope(parsed, BROWSER_INTERACTION_CONTRACT, payload);
    commandOutput(
      context,
      await client.createItem(input, parsed.value("--idempotency-key") ?? crypto.randomUUID()),
    );
    return;
  }
  if (kind === "--file" || kind?.startsWith("--file=")) {
    const source = kind === "--file" ? rest.shift() : kind.slice("--file=".length);
    if (!source || rest.length > 0) {
      throw new ClientUsageError("create --file requires exactly one JSON file or - for stdin");
    }
    const input = parseCreateItem(await readJsonSource(source));
    commandOutput(context, await client.createItem(input));
    return;
  }
  throw new ClientUsageError("create requires question, approval, browser, or --file ITEM.json");
}

async function createEnvelope(
  parsed: ParsedArgs,
  contract: string,
  payload: JsonValue,
): Promise<CreateItemInput> {
  const context = await optionalText(parsed, "--context", "--context-file");
  const priorityText = parsed.value("--priority");
  const priority = priorityText === undefined ? undefined : integer(priorityText, "--priority");
  return parseCreateItem({
    contract,
    title: required(parsed, "--title"),
    context,
    payload,
    ...(priority === undefined ? {} : { priority }),
    labels: labels(parsed.values("--label")),
    correlationId: parsed.value("--correlation") ?? null,
    parentId: parsed.value("--parent") ?? null,
    useBefore: parsed.value("--use-before") ?? null,
  });
}

async function listCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = filterArgs(args, ["--cursor"], []);
  exactPositionals(parsed, 0, "list accepts options only");
  const client = commandClient(context);
  const page = await client.listItems(listOptions(parsed));
  if (context.json) commandOutput(context, page);
  else printItems(page.items, page.nextCursor);
}

async function showCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = parseArgs(args, [], []);
  exactPositionals(parsed, 1, "show requires one attention item id");
  commandOutput(context, await commandClient(context).getItem(parsed.positionals[0] ?? ""));
}

async function statusCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = filterArgs(args, [], []);
  exactPositionals(parsed, 0, "status accepts filters only");
  const items = await collectItems(commandClient(context), listOptions(parsed));
  const counts: Record<AttentionStatus, number> = {
    open: 0,
    resolved: 0,
    returned: 0,
    cancelled: 0,
    expired: 0,
  };
  for (const item of items) counts[item.status] += 1;
  commandOutput(context, { total: items.length, counts, items });
}

async function waitCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = parseArgs(args, ["--timeout", "--correlation"], ["--all"]);
  const client = commandClient(context);
  const correlationId = parsed.value("--correlation");
  if (correlationId && parsed.positionals.length > 0) {
    throw new ClientUsageError("wait accepts item ids or --correlation, not both");
  }
  let ids = parsed.positionals;
  if (correlationId) {
    ids = (await collectItems(client, { correlationId })).map((item) => item.id);
  }
  if (ids.length === 0)
    throw new ClientUsageError("wait requires item ids or a non-empty --correlation selection");
  const timeout = parsed.value("--timeout");
  const result = await waitForAttention(client, ids, {
    mode: parsed.flag("--all") ? "all" : "any",
    ...(timeout === undefined ? {} : { timeoutMs: durationMilliseconds(timeout) }),
  });
  commandOutput(context, result);
}

async function eventsCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = parseArgs(
    args,
    ["--after", "--limit", "--item", "--contract", "--correlation"],
    ["--follow"],
  );
  exactPositionals(parsed, 0, "events accepts options only");
  const client = commandClient(context);
  const itemId = parsed.value("--item");
  const contract = parsed.value("--contract");
  const correlationId = parsed.value("--correlation");
  const options: ListEventOptions = {
    after:
      parsed.value("--after") === undefined ? 0 : natural(parsed.value("--after") ?? "", "--after"),
    limit:
      parsed.value("--limit") === undefined
        ? 100
        : positive(parsed.value("--limit") ?? "", "--limit"),
    ...(itemId ? { itemId } : {}),
    ...(contract ? { contract } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
  const replay = await client.listEvents(options);
  if (!parsed.flag("--follow")) {
    commandOutput(context, replay);
    return;
  }
  for (const event of replay.events) console.log(JSON.stringify(event));
  let cursor = replay.nextCursor;
  while (true) {
    for await (const event of client.streamEvents({ ...options, after: cursor })) {
      cursor = event.cursor;
      console.log(JSON.stringify(event));
    }
  }
}

async function claimCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = parseArgs(args, ["--lease"], []);
  exactPositionals(parsed, 1, "claim requires one attention item id");
  const lease = parsed.value("--lease");
  commandOutput(
    context,
    await commandClient(context).claimItem(
      parsed.positionals[0] ?? "",
      lease === undefined ? 300 : positive(lease, "--lease"),
    ),
  );
}

async function releaseCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = parseArgs(args, ["--claim"], []);
  exactPositionals(parsed, 1, "release requires one attention item id");
  commandOutput(
    context,
    await commandClient(context).releaseClaim(
      parsed.positionals[0] ?? "",
      required(parsed, "--claim"),
    ),
  );
}

async function resolveCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = parseArgs(args, ["--file", "--claim", "--idempotency-key"], []);
  exactPositionals(parsed, 1, "resolve requires one attention item id");
  const resolution = (await readJsonSource(required(parsed, "--file"))) as JsonValue;
  commandOutput(
    context,
    await commandClient(context).resolveItem(parsed.positionals[0] ?? "", resolution, {
      claimId: parsed.value("--claim") ?? null,
      ...(parsed.value("--idempotency-key")
        ? { idempotencyKey: parsed.value("--idempotency-key") as string }
        : {}),
    }),
  );
}

async function returnCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = parseArgs(
    args,
    ["--reason", "--comment", "--comment-file", "--claim", "--idempotency-key"],
    [],
  );
  exactPositionals(parsed, 1, "return requires one attention item id");
  const comment = await optionalText(parsed, "--comment", "--comment-file");
  commandOutput(
    context,
    await commandClient(context).returnItem(
      parsed.positionals[0] ?? "",
      required(parsed, "--reason"),
      {
        claimId: parsed.value("--claim") ?? null,
        comment,
        ...(parsed.value("--idempotency-key")
          ? { idempotencyKey: parsed.value("--idempotency-key") as string }
          : {}),
      },
    ),
  );
}

async function cancelCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = parseArgs(args, ["--reason", "--idempotency-key"], []);
  exactPositionals(parsed, 1, "cancel requires one attention item id");
  commandOutput(
    context,
    await commandClient(context).cancelItem(
      parsed.positionals[0] ?? "",
      required(parsed, "--reason"),
      parsed.value("--idempotency-key")
        ? { idempotencyKey: parsed.value("--idempotency-key") as string }
        : {},
    ),
  );
}

async function pruneCommand(context: ClientCommandContext, args: string[]): Promise<void> {
  const parsed = filterArgs(args, ["--reason"], ["--apply"]);
  exactPositionals(parsed, 0, "prune accepts filters only");
  if (
    !parsed.value("--contract") &&
    !parsed.value("--correlation") &&
    parsed.values("--label").length === 0
  ) {
    throw new ClientUsageError("prune requires --contract, --correlation, or at least one --label");
  }
  const client = commandClient(context);
  const items = await collectItems(client, { ...listOptions(parsed), status: "open" });
  if (!parsed.flag("--apply")) {
    commandOutput(context, { preview: true, count: items.length, items });
    return;
  }
  const reason = required(parsed, "--reason");
  const cancelled: AttentionItem[] = [];
  const failures: Array<{ id: string; error: string }> = [];
  for (const item of items) {
    try {
      cancelled.push(await client.cancelItem(item.id, reason));
    } catch (error) {
      failures.push({ id: item.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  commandOutput(context, { preview: false, matched: items.length, cancelled, failures });
  if (failures.length > 0) process.exitCode = 1;
}

function filterArgs(args: string[], extraValues: string[], extraFlags: string[]): ParsedArgs {
  return parseArgs(
    args,
    ["--status", "--contract", "--correlation", "--claimed", "--limit", ...extraValues],
    extraFlags,
    ["--label"],
  );
}

function listOptions(parsed: ParsedArgs): ListItemOptions {
  const status = parsed.value("--status") as AttentionStatus | undefined;
  if (status && !new Set(["open", "resolved", "returned", "cancelled", "expired"]).has(status)) {
    throw new ClientUsageError(`Unknown status: ${status}`);
  }
  const claimed = parsed.value("--claimed") as ListItemOptions["claimed"];
  if (claimed && !new Set(["any", "claimed", "unclaimed", "mine"]).has(claimed)) {
    throw new ClientUsageError("--claimed must be any, claimed, unclaimed, or mine");
  }
  const contract = parsed.value("--contract");
  const correlationId = parsed.value("--correlation");
  const cursor = parsed.value("--cursor");
  const limit = parsed.value("--limit");
  return {
    ...(status ? { status } : {}),
    ...(contract ? { contract } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(claimed ? { claimed } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit: positive(limit, "--limit") } : {}),
    labels: labels(parsed.values("--label")),
  };
}

async function collectItems(
  client: AttentionClient,
  options: ListItemOptions,
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listItems({
      ...options,
      ...(cursor ? { cursor } : {}),
      limit: 500,
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

function commandClient(context: ClientCommandContext): AttentionClient {
  return new AttentionClient(loadClientConfig(context.clientConfigPath));
}

function commandOutput(context: ClientCommandContext, data: unknown): void {
  console.log(context.json ? JSON.stringify({ ok: true, data }) : JSON.stringify(data, null, 2));
}

function printItems(items: readonly AttentionItem[], nextCursor: string | null): void {
  if (items.length === 0) {
    console.log("No attention items.");
    return;
  }
  for (const item of items) {
    const claim = item.claim ? ` claimed:${item.claim.holder}` : "";
    console.log(`${item.id}  ${item.status.padEnd(9)}  p${item.priority}  ${item.title}${claim}`);
    console.log(
      `  ${item.contract}${item.correlationId ? `  correlation:${item.correlationId}` : ""}`,
    );
  }
  if (nextCursor) console.log(`\nMore items are available; continue with --cursor ${nextCursor}`);
}

interface ParseSpec {
  values: Set<string>;
  flags: Set<string>;
  repeat: Set<string>;
}

class ParsedArgs {
  readonly positionals: string[] = [];
  readonly options = new Map<string, string[]>();
  readonly flags = new Set<string>();

  value(name: string): string | undefined {
    return this.options.get(name)?.at(-1);
  }

  values(name: string): string[] {
    return [...(this.options.get(name) ?? [])];
  }

  flag(name: string): boolean {
    return this.flags.has(name);
  }
}

function parseArgs(
  args: string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[],
  repeatOptions: readonly string[] = [],
): ParsedArgs {
  const spec: ParseSpec = {
    values: new Set(valueOptions),
    flags: new Set(flagOptions),
    repeat: new Set(repeatOptions),
  };
  const parsed = new ParsedArgs();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) {
      parsed.positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals > 0 ? argument.slice(0, equals) : argument;
    if (spec.flags.has(name)) {
      if (equals > 0) throw new ClientUsageError(`${name} does not take a value`);
      parsed.flags.add(name);
      continue;
    }
    if (!spec.values.has(name) && !spec.repeat.has(name)) {
      throw new ClientUsageError(`Unknown option: ${name}`);
    }
    const value = equals > 0 ? argument.slice(equals + 1) : args[++index];
    if (value === undefined || value === "") throw new ClientUsageError(`${name} requires a value`);
    const existing = parsed.options.get(name) ?? [];
    if (!spec.repeat.has(name) && existing.length > 0) {
      throw new ClientUsageError(`${name} may be supplied only once`);
    }
    existing.push(value);
    parsed.options.set(name, existing);
  }
  return parsed;
}

function exactPositionals(parsed: ParsedArgs, count: number, message: string): void {
  if (parsed.positionals.length !== count) throw new ClientUsageError(message);
}

function required(parsed: ParsedArgs, name: string): string {
  const value = parsed.value(name);
  if (!value) throw new ClientUsageError(`${name} is required`);
  return value;
}

function labels(values: readonly string[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const entry of values) {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new ClientUsageError("--label values use key=value");
    output[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return output;
}

async function optionalText(
  parsed: ParsedArgs,
  directName: string,
  fileName: string,
): Promise<string | null> {
  const direct = parsed.value(directName);
  const file = parsed.value(fileName);
  if (direct && file)
    throw new ClientUsageError(`${directName} and ${fileName} cannot be combined`);
  if (file) return await readTextSource(file);
  return direct ?? null;
}

async function readTextSource(path: string): Promise<string> {
  if (path === "-") return await Bun.stdin.text();
  try {
    return readFileSync(resolve(path), "utf8");
  } catch (error) {
    throw badRequest(
      "input_unreadable",
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readJsonSource(path: string): Promise<unknown> {
  const source = await readTextSource(path);
  try {
    return JSON.parse(source);
  } catch {
    throw badRequest("invalid_json", `${path} does not contain valid JSON`);
  }
}

function integer(value: string, name: string): number {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ClientUsageError(`${name} must be an integer`);
  }
  return Number(value);
}

function natural(value: string, name: string): number {
  const parsed = integer(value, name);
  if (parsed < 0) throw new ClientUsageError(`${name} must not be negative`);
  return parsed;
}

function positive(value: string, name: string): number {
  const parsed = natural(value, name);
  if (parsed < 1) throw new ClientUsageError(`${name} must be at least 1`);
  return parsed;
}

export function durationMilliseconds(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match)
    throw new ClientUsageError("--timeout must be a duration such as 500ms, 30s, 5m, or 1h");
  const amount = Number(match[1]);
  const multiplier =
    match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result > 2_147_483_647) {
    throw new ClientUsageError("--timeout is too large");
  }
  return result;
}
