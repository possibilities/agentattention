/**
 * Renders of the contract in src/contract.ts: `--help`, `help COMMAND`,
 * `--agent-help`, and `--agent-teaser`. Every line below reads that document;
 * none of it restates it.
 */

import {
  type ContractArgument,
  type ContractCommand,
  type ContractConstraint,
  commandNodes,
  contract,
  isLeaf,
} from "./contract.ts";

const WIDTH = 88;

type Node = { path: string; command: ContractCommand };

const nodes = commandNodes;

function wrap(text: string, indent: number, hanging = indent, width = WIDTH): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let line = " ".repeat(indent);
    for (const word of paragraph.trim().split(/\s+/)) {
      if (line.trim() !== "" && `${line} ${word}`.length > width) {
        lines.push(line);
        line = " ".repeat(hanging) + word;
      } else {
        line = line.trim() === "" ? line + word : `${line} ${word}`;
      }
    }
    lines.push(line);
  }
  return lines;
}

function placeholder(argument: ContractArgument): string {
  if (argument.type === "boolean") return "";
  if (argument.choices) return argument.choices.join("|");
  const base = argument.name.replace(/^--/, "").replace(/-/g, "_").toUpperCase();
  if (argument.positional) return base;
  if (argument.format === "path") return "PATH";
  if (argument.format === "duration") return "DURATION";
  return base;
}

function spelling(argument: ContractArgument): string {
  const value = placeholder(argument);
  if (argument.positional) return argument.repeatable ? `${value}...` : value;
  const flag = value === "" ? argument.name : `${argument.name} ${value}`;
  return argument.repeatable ? `${flag}...` : flag;
}

function usageLine(node: Node): string {
  const args = node.command.arguments ?? [];
  const shown = args
    .filter((argument) => argument.positional || argument.required)
    .map((argument) => (argument.required ? spelling(argument) : `[${spelling(argument)}]`));
  const rest = args.some((argument) => !argument.positional && !argument.required);
  return ["agentattention [GLOBAL]", node.path, ...shown, rest ? "[OPTIONS]" : ""]
    .filter(Boolean)
    .join(" ");
}

function argumentLines(command: ContractCommand): string[] {
  const args = command.arguments ?? [];
  if (args.length === 0) return [];
  const left = args.map((argument) => `  ${spelling(argument)}`);
  const column = Math.min(34, Math.max(...left.map((entry) => entry.length)) + 2);
  const lines: string[] = ["Arguments:"];
  for (const [index, argument] of args.entries()) {
    const notes: string[] = [];
    if (argument.required) notes.push("required");
    if (argument.repeatable) notes.push("repeatable");
    if (argument.csv) notes.push("comma-joined");
    if (argument.aliases && argument.aliases.length > 0) {
      notes.push(`also ${argument.aliases.join(", ")}`);
    }
    if (argument.minimum !== undefined && argument.maximum !== undefined) {
      notes.push(`${argument.minimum} to ${argument.maximum}`);
    } else if (argument.minimum !== undefined) {
      notes.push(`at least ${argument.minimum}`);
    } else if (argument.maximum !== undefined) {
      notes.push(`at most ${argument.maximum}`);
    }
    if (argument.default !== undefined) notes.push(`default ${String(argument.default)}`);
    if (argument.direction === "out") notes.push("written by this command");
    const description = argument.description + (notes.length > 0 ? ` (${notes.join(", ")})` : "");
    const head = left[index] ?? "";
    const body = wrap(description, column);
    const first = body.shift() ?? "";
    lines.push(
      head.length + 2 <= column ? head.padEnd(column) + first.trimStart() : `${head}\n${first}`,
      ...body,
    );
  }
  return lines;
}

function constraintLine(constraint: ContractConstraint): string {
  const args = constraint.arguments;
  const body =
    constraint.kind === "conflicts"
      ? `${args.join(" and ")} cannot be combined`
      : constraint.kind === "requires"
        ? `${args[0]} requires ${args.slice(1).join(" and ")}`
        : constraint.kind === "at_least_one"
          ? `at least one of ${args.join(", ")}`
          : `${constraint.required ? "exactly one" : "at most one"} of ${args.join(", ")}`;
  return wrap(`${body}${constraint.description ? ` — ${constraint.description}` : ""}`, 2).join(
    "\n",
  );
}

function exampleLines(command: ContractCommand, indent = 2): string[] {
  if (!command.examples || command.examples.length === 0) return [];
  const lines: string[] = ["", "Examples:"];
  for (const [position, example] of command.examples.entries()) {
    if (position > 0) lines.push("");
    lines.push(
      ...wrap(example.description, indent + 2).map(
        (line) => `${" ".repeat(indent)}# ${line.trimStart()}`,
      ),
    );
    for (const line of example.invocation.split("\n")) {
      lines.push(`${" ".repeat(indent)}${line}`);
    }
  }
  return lines;
}

function commandDetail(node: Node): string[] {
  const { command } = node;
  const lines: string[] = [];
  if (isLeaf(command)) {
    lines.push(usageLine(node), "", ...wrap(command.summary, 2));
  } else {
    lines.push(
      `agentattention [GLOBAL] ${node.path} <SUBCOMMAND>`,
      "",
      ...wrap(command.summary, 2),
    );
  }
  if (command.deprecated) {
    lines.push("", ...wrap(`Deprecated: ${command.deprecated}`, 2));
  }
  if (command.aliases && command.aliases.length > 0) {
    const parent = node.path.split(" ").slice(0, -1);
    const spellings = command.aliases.map((alias) => [...parent, alias].join(" "));
    lines.push("", ...wrap(`Also spelled: ${spellings.join(", ")}.`, 2));
  }
  if (command.audience !== "agent") {
    lines.push("", ...wrap(`Audience: ${command.audience}.`, 2));
  }
  if (command.blocking) {
    lines.push(
      "",
      ...wrap("Blocks: it waits on something outside itself and may not return promptly.", 2),
    );
  }
  if (command.guidance) lines.push("", ...wrap(command.guidance, 2));
  if (isLeaf(command) && command.mutates === false) {
    lines.push("", ...wrap("Reads only; it never changes durable state.", 2));
  }
  if (command.subcommands) {
    lines.push("", "Subcommands:");
    const width = Math.max(...command.subcommands.map((entry) => entry.name.length)) + 4;
    for (const sub of command.subcommands) {
      lines.push(`  ${sub.name.padEnd(width)}${sub.summary}`);
    }
  }
  const args = argumentLines(command);
  if (args.length > 0) lines.push("", ...args);
  if (command.constraints && command.constraints.length > 0) {
    lines.push("", "Constraints:", ...command.constraints.map(constraintLine));
  }
  if (command.stdin) {
    lines.push(
      "",
      "Standard input:",
      ...wrap(
        `${command.stdin.accepts} — ${command.stdin.description}${
          command.stdin.required ? " Required." : ""
        }`,
        2,
      ),
    );
  }
  lines.push(...exampleLines(command));
  return lines;
}

function globalLines(): string[] {
  const document = contract();
  const left = document.global_arguments.map((argument) => `  ${spelling(argument)}`);
  const column = Math.max(...left.map((entry) => entry.length)) + 2;
  const lines: string[] = ["Global options:"];
  for (const [index, argument] of document.global_arguments.entries()) {
    const suffix = argument.default === undefined ? "" : ` (default: ${String(argument.default)})`;
    const body = wrap(argument.description + suffix, column);
    lines.push((left[index] ?? "").padEnd(column) + (body.shift() ?? "").trimStart(), ...body);
  }
  return lines;
}

function summaryTable(list: readonly Node[]): string[] {
  const column = Math.max(...list.map((node) => node.path.length)) + 4;
  return list.map((node) => `  ${node.path.padEnd(column)}${node.command.summary}`);
}

/** `--help` and `help [COMMAND]`. */
export function renderHelp(commandPath: readonly string[] = []): string {
  const document = contract();
  const all = nodes();
  if (commandPath.length > 0) {
    const wanted = commandPath.join(" ");
    const node = all.find((entry) => entry.path === wanted);
    if (!node) {
      const near = all.filter((entry) => entry.path.startsWith(`${commandPath[0]} `));
      return [
        `Unknown command: ${wanted}`,
        ...(near.length > 0 ? ["", "Did you mean:", ...summaryTable(near)] : []),
      ].join("\n");
    }
    return [...commandDetail(node), "", ...globalLines()].join("\n");
  }
  const invocable = all.filter((entry) => isLeaf(entry.command) || entry.command.subcommands);
  const agent = invocable.filter((entry) => entry.command.audience === "agent");
  const operator = invocable.filter((entry) => entry.command.audience === "operator");
  const internal = invocable.filter((entry) => entry.command.audience === "internal");
  return [
    ...wrap(`agentattention — ${document.meta.purpose}`, 0),
    "",
    "Usage:",
    "  agentattention [GLOBAL] <COMMAND> [ARGUMENTS]",
    "  agentattention help <COMMAND>        every argument of one command",
    "",
    "Agent commands:",
    ...summaryTable(agent),
    "",
    "Operator commands:",
    ...summaryTable(operator),
    ...(internal.length > 0 ? ["", "Internal commands:", ...summaryTable(internal)] : []),
    "",
    ...globalLines(),
    "",
    "Agent runbook: agentattention --agent-help",
    "Machine-readable contract: agentattention guide --json",
  ].join("\n");
}

/** `--agent-help`: the runbook, rendered from the same document. */
export function renderAgentHelp(): string {
  const document = contract();
  const all = nodes();
  const lines: string[] = [
    ...wrap(`agentattention ${document.meta.version} — ${document.meta.purpose}`, 0),
    "",
    ...wrap(document.guidance, 0),
    "",
    "Opening moves:",
    ...document.concepts.agent_defaults.flatMap((entry) => wrap(`- ${entry}`, 2, 4)),
    "",
    "Model:",
  ];
  for (const [key, value] of Object.entries(document.concepts.model)) {
    lines.push(`  ${key}:`);
    if (Array.isArray(value)) lines.push(...value.flatMap((entry) => wrap(`- ${entry}`, 4, 6)));
    else lines.push(...wrap(value, 4));
  }
  lines.push(
    "",
    "Output:",
    ...Object.entries(document.concepts.output_contract.envelope).map(
      ([field, shape]) => `  ${field}: ${shape}`,
    ),
    ...Object.entries(document.concepts.output_contract.exit_codes).map(
      ([code, meaning]) => `  exit ${code}: ${meaning}`,
    ),
    "",
    "Error codes:",
  );
  for (const entry of document.concepts.error_codes) {
    lines.push(...wrap(`${entry.code} — ${entry.meaning}`, 2, 4));
    if (entry.recovery) lines.push(...wrap(entry.recovery, 6, 6));
  }
  for (const audience of ["agent", "operator", "internal"] as const) {
    const list = all.filter((node) => node.command.audience === audience);
    if (list.length === 0) continue;
    lines.push(
      "",
      `${audience === "agent" ? "Agent" : audience === "operator" ? "Operator" : "Internal"} commands:`,
    );
    for (const node of list) {
      lines.push(
        `  ${isLeaf(node.command) ? usageLine(node).replace("agentattention [GLOBAL] ", "") : `${node.path} <SUBCOMMAND>`}`,
      );
      lines.push(
        ...wrap(
          node.command.blocking ? `${node.command.summary} (blocks)` : node.command.summary,
          6,
        ),
      );
      for (const example of node.command.examples ?? []) {
        for (const [position, line] of example.invocation.split("\n").entries()) {
          lines.push(`      ${position === 0 ? "$" : " "} ${line}`);
        }
      }
    }
  }
  lines.push(
    "",
    ...wrap(
      "Every argument of one command: `agentattention help COMMAND`. The same document as JSON: `agentattention guide --json`.",
      0,
    ),
  );
  return lines.join("\n");
}

/** `--agent-teaser`: the shortest honest advertisement. */
export function renderTeaser(): string {
  const document = contract();
  const [first = ""] = document.guidance.split("\n\n");
  return [
    ...wrap(`agentattention — ${document.meta.purpose}`, 0),
    "",
    ...wrap(first, 0),
    "",
    "Runbook: agentattention --agent-help",
  ].join("\n");
}
