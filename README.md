# agentattention

`agentattention` is the durable handoff between agents and a human. Agents can
queue a question, a document review, or an interaction with a live Agentbrowse
Browser target; the human drains one queue in a full-screen TUI; and agents wait
for any set of items with one race-free command.

The HTTP service remains schema-agnostic. It stores opaque contract identifiers,
payloads, and resolutions while providing lifecycle, claims, authentication,
expiry, and a transactional event feed. First-party payload validation and all
human interaction live in the client/TUI modules, outside the daemon.

## Install and run

Requires Bun 1.3.14 or newer and the sibling Agentbrowse checkout for browser
interaction.

```bash
scripts/install.sh --install
```

The installer runs a frozen dependency install, links `agentattention` into
`~/.local/bin`, and bootstraps the server and local-client configurations when
the server configuration does not yet exist. In the fleet, AgentStart invokes
that installer and owns the resident `agentattention.server` LaunchAgent.

For foreground development:

```bash
bun install
bun run src/cli.ts init
bun run src/cli.ts serve
```

`init` writes mode-0600 files at
`~/.config/agentattention/{config,client}.json`. The server config stores token
hashes; the local client file stores a broad non-admin credential used by the
CLI and TUI. The administrator token is printed once.

If the server configuration predates that paired bootstrap, or the local client
file is lost, recover it explicitly and then restart the AgentStart-owned
service:

```bash
agentattention client init
../agentstart/scripts/install-launchagents --install
```

`client init` creates the standard local-client principal when absent and
rotates it when its file was lost. It writes the replacement token directly to
the mode-0600 client file and never prints it.

## Create and drain attention

The bounded first-party contracts are:

| Contract | Producer asks for | Human processor returns |
|---|---|---|
| `dev.agentattention/question/v1` | One or more free-text or single-choice answers | Ordered answers |
| `dev.agentattention/document-approval/v1` | Approval of a Markdown or plain-text document | Approved, or changes requested with a comment |
| `dev.agentattention/browser-interaction/v1` | Work in one exact Agentbrowse Browser target | Completed |

```bash
agentattention create question \
  --title "Choose the next search lane" \
  --context "The current round exhausted remote-first roles." \
  --question "Which lane should the agent search next?" \
  --choice startup="Early-stage startups" \
  --choice broad="Broaden the current search"

agentattention create approval \
  --title "Approve the application plan" \
  --document ./plan.md

browser_target="$(agentbrowse resolve jobsearch --json | jq -er '.data.target.name')"

agentattention create browser \
  --title "Sign in to LinkedIn" \
  --context "Use the job-search account; do not change account settings." \
  --target "$browser_target" \
  --action "Complete sign-in and leave the jobs page ready for automation."
```

Run `agentattention` to browse open items; `agentattention tui` is the explicit
equivalent. Selecting an item suspends the
queue renderer and foregrounds its standalone processor, just as a terminal
tool foregrounds `$EDITOR`. Background refresh is silent: an empty queue holds
`NO ITEMS` at the center of the viewport, while a nonempty queue renders its
attention items without a freshness banner. The browser processor opens the
exact named target through Agentbrowse's OpenTUI surface; it never
exposes browser credentials in the attention item, resolves a stable session to
a replacement, or offers a target picker.

Every TUI action is available from `ctrl+k`. A human can resolve an item, return
it as stale, or go back without resolving it. No sound or desktop notification
is emitted.

## Wait from an agent

```bash
agentattention wait attn_one attn_two
agentattention wait attn_one attn_two --all
agentattention wait --correlation jobsearch-round-42 --all --timeout 30m --json
```

`wait` captures an event cursor before its first state snapshot, then replays
and follows from that cursor. A transition cannot fall into the usual gap
between polling and subscribing. By default it returns when any watched item is
terminal; `--all` waits for every item. Its structured result includes the
terminal reason, final cursor, and current item snapshots.

If a human returns a stale browser interaction, the producing agent can rebuild
the breadcrumb trail and create a fresh handoff. `useBefore` is the only
service-owned freshness mechanism: after that producer-supplied timestamp the
service mechanically expires an open item without trying to infer staleness.

## Lifecycle

An attention item is `open` until one terminal transition wins:

```text
                         resolve
open + optional claim  -----------> resolved
          |               return
          +------------------------> returned
          |               cancel
          +------------------------> cancelled
          |             useBefore
          +------------------------> expired
```

A claim is a renewable exclusive lease, not a durable assignment. Processors
claim before presenting an item, renew while active, and release when the human
goes back or the processor fails. Terminal state, claim removal, outcome,
idempotency record, and event commit in one SQLite transaction.

## CLI and API

The CLI also provides generic creation, filtering, inspection, event replay,
claim/resolve/return/cancel operations, and guarded bulk pruning. Run
`agentattention --help` for the complete surface. `--json` returns stable
agent-friendly envelopes.

Task-oriented references:

- [Creating attention items](docs/producers.md)
- [Building and running processors](docs/handlers.md)
- [Waiting and resuming reliably](docs/waiting.md)
- [Operating the service](docs/operations.md)
- [OpenAPI 3.1 contract](openapi.json)
- [First-party and externally negotiated examples](examples/contracts/README.md)

## Development

```bash
bun run check
```

SQLite migrations are applied automatically. Events and idempotency records
are retained indefinitely in version 1.
