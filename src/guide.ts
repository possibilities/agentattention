/**
 * The single authored description of this CLI.
 *
 * `guide --json` publishes the fleet agent contract (version 1); `--help`,
 * `help COMMAND`, `--agent-help`, and `--agent-teaser` are renders of the same
 * document. Nothing here may be restated in prose elsewhere: a second
 * authorship of a command's summary, of an argument's meaning, or of an error
 * code is exactly the drift this contract exists to remove.
 *
 * The contract's shape is normative in
 * ~/code/agentstart/config/agent-contract/schema.json.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultClientConfigPath, defaultConfigPath } from "./config.ts";
import {
  BROWSER_INTERACTION_CONTRACT,
  DOCUMENT_APPROVAL_CONTRACT,
  QUESTION_CONTRACT,
} from "./contracts/index.ts";
import { SCHEMA_VERSION } from "./envelope.ts";

export const CONTRACT_VERSION = 1;

export type Audience = "agent" | "operator" | "internal";

export interface ContractArgument {
  name: string;
  type: "string" | "boolean" | "integer" | "number";
  description: string;
  format?: "path" | "url" | "duration" | "ref" | "json";
  direction?: "in" | "out";
  required?: boolean;
  positional?: boolean;
  repeatable?: boolean;
  choices?: string[];
  default?: string | number | boolean | null;
  aliases?: string[];
}

export interface ContractConstraint {
  kind: "one_of" | "conflicts" | "requires";
  arguments: string[];
  required?: boolean;
  description?: string;
}

export interface ContractStdin {
  accepts: "text" | "json";
  required?: boolean;
  description: string;
}

export interface ContractCommand {
  name: string;
  summary: string;
  audience: Audience;
  mutates?: boolean;
  guidance?: string;
  arguments?: ContractArgument[];
  subcommands?: ContractCommand[];
  stdin?: ContractStdin;
  constraints?: ContractConstraint[];
}

export interface Contract {
  contract_version: number;
  meta: { name: string; version: string; purpose: string; audience: "agent" | "operator" };
  guidance: string;
  concepts: {
    model: Record<string, string | string[]>;
    output_contract: {
      envelope: Record<string, string>;
      exit_codes: Record<string, string>;
    };
    error_codes: Array<{ code: string; meaning: string; recovery?: string }>;
    read_only_commands: string[];
    agent_defaults: string[];
  };
  global_arguments: ContractArgument[];
  commands: ContractCommand[];
}

export function version(): string {
  const parsed = JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as {
    version?: string;
  };
  return parsed.version ?? "0.0.0";
}

const CREATE_METADATA: ContractArgument[] = [
  {
    name: "--context",
    type: "string",
    description:
      "The full explanation the human needs: why this is being asked, the constraints, and what happens after. The title is the line in the queue; this is the briefing.",
  },
  {
    name: "--context-file",
    type: "string",
    description: "Read the context from a file, or from standard input when the path is `-`.",
    format: "path",
    direction: "in",
  },
  {
    name: "--priority",
    type: "integer",
    description: "Queue priority; higher sorts first.",
  },
  {
    name: "--label",
    type: "string",
    description:
      "key=value tag, repeatable. Labels are how a later list, status, or prune narrows to this workflow.",
    repeatable: true,
  },
  {
    name: "--correlation",
    type: "string",
    description:
      "Producer-chosen id shared by every item of one work round, so a single `wait --correlation` covers the whole round.",
  },
  {
    name: "--parent",
    type: "string",
    description:
      "Id of the item this one replaces or descends from. Terminal items never reopen; a rebuilt interaction links back through this.",
  },
  {
    name: "--use-before",
    type: "string",
    description:
      "RFC3339 instant after which the service mechanically expires the item. Only for prepared state with a real validity window; the service compares the clock and infers nothing.",
  },
  {
    name: "--idempotency-key",
    type: "string",
    description:
      "Caller-chosen key that makes a retried create return the first item instead of a second one. A random key is generated when omitted, so supply one for any retryable step.",
  },
];

const CONTEXT_CONFLICT: ContractConstraint = {
  kind: "conflicts",
  arguments: ["--context", "--context-file"],
  description: "Context comes from one channel or the other.",
};

const FILTERS: ContractArgument[] = [
  {
    name: "--status",
    type: "string",
    description: "Keep only items in this state.",
    choices: ["open", "resolved", "returned", "cancelled", "expired"],
  },
  {
    name: "--contract",
    type: "string",
    description: "Keep only items of one contract id.",
  },
  {
    name: "--correlation",
    type: "string",
    description: "Keep only items of one work round.",
  },
  {
    name: "--label",
    type: "string",
    description: "key=value tag the item must carry, repeatable; all given labels must match.",
    repeatable: true,
  },
  {
    name: "--claimed",
    type: "string",
    description:
      "Keep only items by claim state; `mine` means held by this credential's principal.",
    choices: ["any", "claimed", "unclaimed", "mine"],
  },
  {
    name: "--limit",
    type: "integer",
    description: "Maximum items in one page.",
  },
];

function filters(extra: ContractArgument[] = []): ContractArgument[] {
  return [...FILTERS, ...extra];
}

const ITEM_ID: ContractArgument = {
  name: "id",
  type: "string",
  description: "Attention item id, as returned by create.",
  positional: true,
  required: true,
};

const IDEMPOTENCY: ContractArgument = {
  name: "--idempotency-key",
  type: "string",
  description: "Caller-chosen key that makes a retried call return the first outcome.",
};

const CLAIM_ID: ContractArgument = {
  name: "--claim",
  type: "string",
  description: "Claim id proving this principal holds the item's lease.",
};

export function contract(): Contract {
  return {
    contract_version: CONTRACT_VERSION,
    meta: {
      name: "agentattention",
      version: version(),
      purpose:
        "Durable local control plane for human attention: an agent creates bounded attention items, keeps working, and waits for their one terminal outcome.",
      audience: "agent",
    },
    guidance: [
      "Reach for agentattention whenever work cannot proceed without a human: questions only they can answer, a document or plan that needs approval, or hands-on browser interaction such as sign-in, MFA, or a captcha. Do not build a project-local human queue around these cases, and do not fall back to Herdr messages, harness monitors, sounds, or desktop notifications — the human drains one queue, `agentattention tui`.",
      "The shape of a work round is: do everything autonomous first; create every independent handoff you discovered, giving the round one `--correlation` value and useful `--label key=value` filters; continue whatever does not depend on them; then `wait` once for the set. `--all` only when everything is required before anything can continue — otherwise the default wakes on the first terminal item. Consume the outcomes, do the newly unblocked work, and wait again only if open items remain.",
      "Prefer the three first-party contracts (`create question`, `create approval`, `create browser`). Generic `create file` is for a producer and a processor that already share an external contract; the service deliberately does not route, fetch, or validate one. Every item gets a concise `--title` and a real `--context`.",
      "Never put a password, cookie, bearer token, CDP URL, or Live View credential into an item. A browser item carries the exact Agentbrowse Browser target name, never its connection details.",
      "Pass `--json` whenever the next step depends on the output, and branch on the item status or the error code rather than on formatted lines. Terminal items never reopen: a stale or expired interaction is rebuilt as a new item, optionally linked with `--parent`. Do not claim producer-created items — claims belong to the human processor and the TUI manages them.",
    ].join("\n\n"),
    concepts: {
      model: {
        attention_item:
          "A durable request for human attention, from creation to exactly one terminal outcome. Its contract, payload, and resolution are opaque to the service.",
        statuses:
          "open, then one terminal state: resolved (the human answered — read `resolution.payload`), returned (handed back with a mechanical `returnOutcome.reason` such as `stale`, plus an optional comment; never reinterpret a return as a resolution), cancelled (withdrawn by producer or operator), expired (its `useBefore` passed).",
        first_party_contracts: [
          `${QUESTION_CONTRACT} — one or more prompts, optionally with choices; created by \`create question\`.`,
          `${DOCUMENT_APPROVAL_CONTRACT} — a markdown or plain document the human approves or returns with a required comment; created by \`create approval\`.`,
          `${BROWSER_INTERACTION_CONTRACT} — an exact Agentbrowse Browser target name plus the action the human should complete; created by \`create browser\`.`,
        ],
        claim:
          "A renewable exclusive lease one principal holds while handling an open item. Producer-side agents do not claim; claim, release, resolve, return, and process are the human client's verbs.",
        correlation_and_labels:
          "`--correlation` groups one work round so a single wait covers it; `--label key=value` is the filter dimension list, status, and prune all read.",
        events:
          "An append-only feed with a monotonic cursor. `wait` captures a cursor before its first snapshot and replays from it, so no transition can fall between polling and subscription.",
        credentials:
          "The local client credential lives in a mode-0600 client file and is never printed. `client init` creates or rotates it; never reconstruct that file from credential output or from the server's token hashes.",
      },
      output_contract: {
        envelope: {
          schema_version: `number — this envelope's version, currently ${SCHEMA_VERSION}`,
          ok: "boolean",
          error: "{code, message} | null",
          data: "payload | null",
        },
        exit_codes: {
          "0": "success",
          "1": "domain failure; with --json the envelope carries error.code",
          "2": "usage fault, printed with the help text",
        },
      },
      error_codes: [
        {
          code: "client_config_unreadable",
          meaning: "This machine has no readable local client credential.",
          recovery:
            "Handoff work stops and reports an installation fault. When toolchain repair is authorized: `agentattention --json client init`, then `~/code/agentstart/scripts/install-launchagents --install`.",
        },
        {
          code: "not_found",
          meaning: "No attention item, credential, or route matches.",
        },
        {
          code: "unauthorized",
          meaning: "The bearer credential is missing or invalid.",
          recovery: "Repair the local client credential; do not hand-edit the client file.",
        },
        {
          code: "forbidden",
          meaning: "The credential lacks the scope this call needs.",
        },
        {
          code: "item_not_open",
          meaning: "The item already reached a terminal outcome.",
          recovery:
            "Read its outcome with `show`; terminal items never reopen. Create a fresh item if the goal still stands.",
        },
        {
          code: "already_claimed",
          meaning: "Another principal holds the item's claim.",
        },
        {
          code: "claim_required",
          meaning: "The item is claimed and this call must present that claim id.",
          recovery: "Pass `--claim CLAIM_ID`.",
        },
        {
          code: "claim_mismatch",
          meaning: "The presented claim id is not the claim the item holds.",
        },
        {
          code: "claim_missing",
          meaning: "The item has no claim to release.",
        },
        {
          code: "idempotency_conflict",
          meaning: "The idempotency key was reused with a different request body.",
          recovery: "Use a fresh key, or resend the identical request.",
        },
        {
          code: "missing_idempotency_key",
          meaning: "This call requires an idempotency key.",
        },
        {
          code: "invalid_contract_payload",
          meaning: "The payload does not satisfy the first-party contract it names.",
          recovery: "Read the contract's payload shape before rebuilding the item.",
        },
        {
          code: "unsupported_contract",
          meaning: "A first-party operation was attempted against an unknown contract id.",
        },
        {
          code: "invalid_item",
          meaning: "The item envelope given to `create file` is not valid.",
        },
        {
          code: "invalid_resolution",
          meaning: "The resolution document is not valid for the item's contract.",
        },
        {
          code: "invalid_return_reason",
          meaning: "A return reason must be a short mechanical identifier such as `stale`.",
        },
        {
          code: "comment_required",
          meaning: "This outcome requires a comment.",
        },
        {
          code: "invalid_json",
          meaning: "A file given to a `--file`-style argument does not contain JSON.",
        },
        {
          code: "input_unreadable",
          meaning: "A file argument could not be read.",
          recovery: "Paths resolve against the caller's working directory; pass an absolute path.",
        },
        {
          code: "invalid_field",
          meaning: "A field of the request is malformed.",
        },
        {
          code: "unknown_fields",
          meaning: "The request carries fields this service does not accept.",
        },
        {
          code: "invalid_filter",
          meaning: "A filter value is outside its closed set.",
        },
        {
          code: "invalid_labels",
          meaning: "Labels must be a flat map of key=value strings.",
        },
        {
          code: "invalid_cursor",
          meaning: "The pagination cursor is not one this service issued.",
        },
        {
          code: "invalid_timestamp",
          meaning: "A timestamp is not RFC3339.",
        },
        {
          code: "invalid_use_before",
          meaning: "`--use-before` is not a usable future instant.",
        },
        {
          code: "parent_not_found",
          meaning: "`--parent` names an item that does not exist.",
        },
        {
          code: "config_exists",
          meaning: "`init` refuses to overwrite an existing server configuration.",
        },
        {
          code: "client_config_exists",
          meaning: "`client init` refuses to overwrite an existing client credential file.",
          recovery: "Remove the file deliberately, or rotate through the server configuration.",
        },
        {
          code: "config_unreadable",
          meaning: "The server configuration is missing or unreadable.",
        },
        {
          code: "invalid_config",
          meaning: "The server configuration is malformed.",
        },
        {
          code: "invalid_client_config",
          meaning: "The client credential file is malformed.",
        },
        {
          code: "ambiguous_local_client",
          meaning: "More than one credential claims to be this machine's local client.",
        },
        {
          code: "local_client_scope_mismatch",
          meaning: "The stored local client credential no longer carries the scopes it needs.",
        },
        {
          code: "invalid_credential_name",
          meaning: "A credential name is empty or too long.",
        },
        {
          code: "invalid_scopes",
          meaning: "A requested scope is not one this service defines.",
        },
        {
          code: "ambiguous_credential",
          meaning: "A credential name matched more than one credential.",
          recovery: "Address it by id.",
        },
        {
          code: "last_admin",
          meaning: "The last administrator credential may not be revoked.",
        },
        {
          code: "non_loopback_host",
          meaning: "The service refuses to bind a non-loopback address.",
        },
        {
          code: "invalid_path",
          meaning: "A configured path is not usable.",
        },
        {
          code: "invalid_body",
          meaning: "The HTTP request body is not JSON.",
        },
        {
          code: "body_too_large",
          meaning: "The request body exceeds the service's limit.",
        },
        {
          code: "http_error",
          meaning: "The service answered with an error carrying no structured code.",
        },
        {
          code: "empty_event_stream",
          meaning: "The event stream response carried no body.",
        },
        {
          code: "invalid_event_stream",
          meaning: "The event stream produced a line that is not JSON.",
        },
        {
          code: "internal_error",
          meaning: "An unexpected fault; the message carries the detail.",
        },
      ],
      read_only_commands: [
        "guide",
        "help",
        "list",
        "show",
        "status",
        "wait",
        "events",
        "credential list",
      ],
      agent_defaults: [
        "Do the autonomous work first; create handoffs only for what genuinely needs a human.",
        "Give one work round a single --correlation and useful --label key=value filters.",
        "Create every independent item, then wait once for the set rather than serially.",
        "Always pass --json when the next step branches on the result.",
        "On client_config_unreadable, stop handoff work and report the installation fault.",
      ],
    },
    global_arguments: [
      {
        name: "--json",
        type: "boolean",
        description:
          "Emit the {schema_version, ok, error, data} envelope. Use it whenever the next step depends on the output.",
      },
      {
        name: "--config",
        type: "string",
        description: "Server configuration file. Env: AGENTATTENTION_CONFIG.",
        format: "path",
        direction: "in",
        default: defaultConfigPath(),
      },
      {
        name: "--client-config",
        type: "string",
        description:
          "Local client credential file, mode 0600 and never printed. Env: AGENTATTENTION_CLIENT_CONFIG.",
        format: "path",
        direction: "in",
        default: defaultClientConfigPath(),
      },
    ],
    commands: [
      {
        name: "create",
        summary: "Create one attention item for the human queue",
        audience: "agent",
        guidance:
          "Pick the subcommand for the shape of the handoff. `create --file ITEM.json` is an accepted legacy spelling of `create file`.",
        subcommands: [
          {
            name: "question",
            summary: "Ask the human one or more questions",
            audience: "agent",
            mutates: true,
            guidance:
              "Repeat --question for several related free-text prompts. Choices are available only when creating exactly one question. For a fully specified mixed questionnaire, build the payload and pass --payload-file.",
            arguments: [
              {
                name: "--title",
                type: "string",
                description: "Concise line shown in the human's queue.",
                required: true,
              },
              {
                name: "--question",
                type: "string",
                description: "A free-text prompt, repeatable for several related questions.",
                repeatable: true,
              },
              {
                name: "--choice",
                type: "string",
                description:
                  "`value=Human label` answer choice, repeatable. Available only when exactly one --question is given.",
                repeatable: true,
              },
              {
                name: "--payload-file",
                type: "string",
                description:
                  "A fully specified question payload as JSON, or `-` for standard input, instead of the --question/--choice shorthand.",
                format: "path",
                direction: "in",
              },
              ...CREATE_METADATA,
            ],
            constraints: [
              CONTEXT_CONFLICT,
              {
                kind: "conflicts",
                arguments: ["--payload-file", "--question"],
                description: "The payload is authored one way or the other.",
              },
              {
                kind: "conflicts",
                arguments: ["--payload-file", "--choice"],
              },
              {
                kind: "requires",
                arguments: ["--choice", "--question"],
                description: "Choices belong to a question, and to exactly one of them.",
              },
            ],
          },
          {
            name: "approval",
            summary: "Ask the human to approve a document or plan",
            audience: "agent",
            mutates: true,
            guidance:
              "The human either approves or requests changes with a required comment. The document is handed over by path: write it to a file first — an out-of-process caller has no pipe for `--document -`.",
            arguments: [
              {
                name: "--title",
                type: "string",
                description: "Concise line shown in the human's queue.",
                required: true,
              },
              {
                name: "--document",
                type: "string",
                description:
                  "File holding the document to approve, or `-` for standard input. Its contents are copied into the item.",
                format: "path",
                direction: "in",
                required: true,
              },
              {
                name: "--format",
                type: "string",
                description: "How the document is rendered. Inferred as markdown for a `.md` path.",
                choices: ["markdown", "plain"],
              },
              ...CREATE_METADATA,
            ],
            stdin: {
              accepts: "text",
              description: "The document body, when --document is `-`.",
            },
            constraints: [CONTEXT_CONFLICT],
          },
          {
            name: "browser",
            summary: "Ask the human to act in a prepared Agentbrowse browser target",
            audience: "agent",
            mutates: true,
            guidance:
              "Prepare the session with agentbrowse first and resolve it to its current exact target name; the human processor opens that exact target and will not resolve, substitute, or rebuild it. Sign-in, MFA, and captchas are ordinary items of this kind.",
            arguments: [
              {
                name: "--title",
                type: "string",
                description: "Concise line shown in the human's queue.",
                required: true,
              },
              {
                name: "--target",
                type: "string",
                description:
                  "The exact Agentbrowse Browser target name, never its connection details.",
                required: true,
              },
              {
                name: "--action",
                type: "string",
                description:
                  "What the human should complete, and what state to leave behind for the agent.",
                required: true,
              },
              ...CREATE_METADATA,
            ],
            constraints: [CONTEXT_CONFLICT],
          },
          {
            name: "file",
            summary: "Create an item from a complete JSON envelope",
            audience: "agent",
            mutates: true,
            guidance:
              "For a producer and processor that already share an external contract. The service does not route, fetch, or validate contracts, so both halves must exist before this is worth using. Also spelled `create --file ITEM.json`.",
            arguments: [
              {
                name: "item",
                type: "string",
                description:
                  "JSON file holding the whole item envelope, or `-` for standard input.",
                positional: true,
                required: true,
                format: "path",
                direction: "in",
              },
            ],
            stdin: {
              accepts: "json",
              description: "The item envelope, when the path is `-`.",
            },
          },
        ],
      },
      {
        name: "list",
        summary: "List attention items, newest first, filtered and paged",
        audience: "agent",
        mutates: false,
        arguments: filters([
          {
            name: "--cursor",
            type: "string",
            description: "Continue from the previous page's nextCursor.",
          },
        ]),
      },
      {
        name: "show",
        summary: "Show one attention item with its outcome",
        audience: "agent",
        mutates: false,
        arguments: [ITEM_ID],
      },
      {
        name: "status",
        summary: "Count a filtered slice of the queue by state",
        audience: "agent",
        mutates: false,
        guidance:
          "Walks every page of the filter, so it answers 'where does this round stand' in one call.",
        arguments: filters(),
      },
      {
        name: "wait",
        summary: "Block until attention items reach terminal outcomes",
        audience: "agent",
        mutates: false,
        guidance:
          "The one blocking call of a work round. A timeout is a structured result, not evidence that anything changed — inspect the returned items. Name ids, or select a whole round with --correlation.",
        arguments: [
          {
            name: "id",
            type: "string",
            description: "Attention item ids to wait on.",
            positional: true,
            repeatable: true,
          },
          {
            name: "--correlation",
            type: "string",
            description: "Wait on every item of one work round instead of naming ids.",
          },
          {
            name: "--all",
            type: "boolean",
            description:
              "Wait for every selected item. Without it the call returns on the first terminal item.",
          },
          {
            name: "--timeout",
            type: "string",
            description: "Give up after a duration such as 500ms, 30s, 5m, or 1h.",
            format: "duration",
          },
        ],
        constraints: [
          {
            kind: "one_of",
            arguments: ["id", "--correlation"],
            required: true,
            description: "Wait on named ids or on a correlation, never both.",
          },
        ],
      },
      {
        name: "events",
        summary: "Read the durable event feed from a cursor",
        audience: "agent",
        mutates: false,
        guidance:
          "For reconstructing what happened, or for a consumer that persists its own cursor. Ordinary handoff work uses wait instead.",
        arguments: [
          {
            name: "--after",
            type: "integer",
            description: "Start after this cursor.",
            default: 0,
          },
          {
            name: "--limit",
            type: "integer",
            description: "Maximum events in the replayed page.",
            default: 100,
          },
          {
            name: "--item",
            type: "string",
            description: "Only events of one attention item.",
          },
          {
            name: "--contract",
            type: "string",
            description: "Only events of items of one contract id.",
          },
          {
            name: "--correlation",
            type: "string",
            description: "Only events of one work round.",
          },
          {
            name: "--follow",
            type: "boolean",
            description:
              "After the replay, stream one JSON event per line indefinitely. This never returns on its own.",
          },
        ],
      },
      {
        name: "cancel",
        summary: "Withdraw an open item you created",
        audience: "agent",
        mutates: true,
        arguments: [
          ITEM_ID,
          {
            name: "--reason",
            type: "string",
            description: "Why it is being withdrawn; shown to the human and kept in the event log.",
            required: true,
          },
          IDEMPOTENCY,
        ],
      },
      {
        name: "prune",
        summary: "Cancel a filtered set of open items, preview first",
        audience: "agent",
        mutates: true,
        guidance:
          "Without --apply this only previews the matched items. The filter must be narrow — a contract, a correlation, or a label — so a stray call cannot empty the queue.",
        arguments: filters([
          {
            name: "--apply",
            type: "boolean",
            description: "Actually cancel the matched items instead of previewing them.",
          },
          {
            name: "--reason",
            type: "string",
            description: "Cancellation reason recorded on every item.",
          },
        ]),
        constraints: [
          {
            kind: "one_of",
            arguments: ["--contract", "--correlation", "--label"],
            required: true,
            description: "At least one narrowing filter is mandatory.",
          },
          {
            kind: "requires",
            arguments: ["--apply", "--reason"],
          },
        ],
      },
      {
        name: "claim",
        summary: "Take an exclusive lease on an open item",
        audience: "operator",
        mutates: true,
        guidance:
          "A human-client verb. Producers do not claim their own items; the queue TUI manages claims for the person draining it.",
        arguments: [
          ITEM_ID,
          {
            name: "--lease",
            type: "integer",
            description: "Lease length in seconds.",
            default: 300,
          },
        ],
      },
      {
        name: "release",
        summary: "Give a claimed item back to the queue",
        audience: "operator",
        mutates: true,
        arguments: [ITEM_ID, { ...CLAIM_ID, required: true }],
      },
      {
        name: "resolve",
        summary: "Complete an item with its resolution document",
        audience: "operator",
        mutates: true,
        arguments: [
          ITEM_ID,
          {
            name: "--file",
            type: "string",
            description: "JSON file holding the resolution payload, or `-` for standard input.",
            format: "path",
            direction: "in",
            required: true,
          },
          CLAIM_ID,
          IDEMPOTENCY,
        ],
        stdin: {
          accepts: "json",
          description: "The resolution payload, when --file is `-`.",
        },
      },
      {
        name: "return",
        summary: "Hand an item back to its producer unfinished",
        audience: "operator",
        mutates: true,
        guidance:
          "The reason is a short mechanical identifier such as `stale`; the comment is the prose for the producing agent.",
        arguments: [
          ITEM_ID,
          {
            name: "--reason",
            type: "string",
            description: "Lowercase mechanical reason, letters digits . _ - only, such as `stale`.",
            required: true,
          },
          {
            name: "--comment",
            type: "string",
            description: "Explanation for the producing agent.",
          },
          {
            name: "--comment-file",
            type: "string",
            description: "Read the comment from a file, or `-` for standard input.",
            format: "path",
            direction: "in",
          },
          CLAIM_ID,
          IDEMPOTENCY,
        ],
        constraints: [
          {
            kind: "conflicts",
            arguments: ["--comment", "--comment-file"],
          },
        ],
      },
      {
        name: "tui",
        summary: "Open the human queue (also what bare `agentattention` runs)",
        audience: "operator",
        mutates: true,
        guidance:
          "The one surface the human drains. It claims, resolves, and returns on their behalf.",
        arguments: [],
      },
      {
        name: "process",
        summary: "Open one item's processor directly",
        audience: "operator",
        mutates: true,
        arguments: [ITEM_ID],
      },
      {
        name: "serve",
        summary: "Run the loopback attention service",
        audience: "operator",
        mutates: true,
        guidance: "Normally run by the managed launch agent, not by hand.",
        arguments: [],
      },
      {
        name: "init",
        summary: "Create this machine's server and client configuration",
        audience: "operator",
        mutates: true,
        guidance:
          "Prints the administrator token once and refuses to overwrite existing configuration. The local client token is written mode 0600 and never printed.",
        arguments: [],
      },
      {
        name: "credential",
        summary: "Manage the service's bearer credentials",
        audience: "operator",
        subcommands: [
          {
            name: "create",
            summary: "Mint a credential and print its token once",
            audience: "operator",
            mutates: true,
            arguments: [
              {
                name: "--name",
                type: "string",
                description: "Credential name.",
                required: true,
              },
              {
                name: "--scopes",
                type: "string",
                description: "Comma-joined scope list; not repeatable.",
                required: true,
              },
            ],
          },
          {
            name: "list",
            summary: "List credentials without their secrets",
            audience: "operator",
            mutates: false,
            arguments: [],
          },
          {
            name: "revoke",
            summary: "Remove one credential",
            audience: "operator",
            mutates: true,
            guidance:
              "The last administrator credential cannot be revoked. Restart the service afterwards.",
            arguments: [
              {
                name: "credential",
                type: "string",
                description: "Credential id, or its exact name when unambiguous.",
                positional: true,
                required: true,
              },
            ],
          },
        ],
      },
      {
        name: "client",
        summary: "Manage this machine's local client credential",
        audience: "operator",
        subcommands: [
          {
            name: "init",
            summary: "Create or rotate the local client credential",
            audience: "operator",
            mutates: true,
            guidance:
              "Writes the credential file at mode 0600 without printing the token, and refuses an existing file. Restart the managed service afterwards.",
            arguments: [],
          },
        ],
      },
      {
        name: "guide",
        summary: "Print the machine-readable agent contract",
        audience: "agent",
        mutates: false,
        guidance:
          "With --json this is the fleet agent contract, version 1; without it, the agent runbook. Every other help surface renders from this document.",
        arguments: [],
      },
      {
        name: "help",
        summary: "Print the command surface, or one command in full",
        audience: "operator",
        mutates: false,
        arguments: [
          {
            name: "command",
            type: "string",
            description: "Command path, such as `create question`.",
            positional: true,
            repeatable: true,
          },
        ],
      },
    ],
  };
}

/* Renders. Every line below reads the document above; none of it restates it. */

const WIDTH = 88;

interface Node {
  path: string;
  command: ContractCommand;
}

function walk(commands: readonly ContractCommand[], prefix: string[], into: Node[]): Node[] {
  for (const command of commands) {
    const path = [...prefix, command.name];
    into.push({ path: path.join(" "), command });
    if (command.subcommands) walk(command.subcommands, path, into);
  }
  return into;
}

function nodes(): Node[] {
  return walk(contract().commands, [], []);
}

function isLeaf(command: ContractCommand): boolean {
  return command.subcommands === undefined;
}

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
        : `${constraint.required ? "exactly one" : "at most one"} of ${args.join(", ")}`;
  return wrap(`${body}${constraint.description ? ` — ${constraint.description}` : ""}`, 2).join(
    "\n",
  );
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
  if (command.audience !== "agent") {
    lines.push("", ...wrap(`Audience: ${command.audience}.`, 2));
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
      lines.push(...wrap(node.command.summary, 6));
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
