# Creating attention items

This guide is for an agent or tool that discovers it needs a human.

## Prefer the bounded first-party contracts

Use the CLI helpers for the interactions Agentattention's TUI understands:

```bash
agentattention create question --title "Choose an account" \
  --context "The next application requires a Workday account." \
  --question "Which email address should this application use?"

agentattention create approval --title "Approve this plan" --document ./plan.md

browser_target="$(agentbrowse resolve jobsearch --json | jq -er '.data.target.name')"
agentattention create browser --title "Complete Workday sign-in" \
  --target "$browser_target" --action "Sign in and leave the application form open."
```

The helpers validate these exact first-party contracts before sending them:

- `dev.agentattention/question/v1`
- `dev.agentattention/document-approval/v1`
- `dev.agentattention/browser-interaction/v1`

For several questions, repeat `--question` or pass a complete validated payload
with `--payload-file`. A single question can have repeatable
`--choice value=Human label` options. Document input and long context can come
from a file. The browser payload contains only an Agentbrowse Browser target
name and requested action—never cookies, CDP URLs, Live View credentials, or a
reusable secret. Resolve a provider-managed agent-browser session with
`agentbrowse resolve SESSION --json`; a stable session or Browser profile name
is not the exact target incarnation.

## Keep the envelope useful to both humans and agents

Every item requires a concise `title`. Add optional, potentially long `context`
that explains why the human is needed, relevant constraints, and what state the
agent will expect afterward. The item processor displays both before asking for
the answer or handing over the browser.

Shared envelope fields are:

| Field | Purpose |
|---|---|
| `contract` | Opaque, versioned agreement between producer and processor |
| `title` | Short queue label a human can scan |
| `context` | Optional long explanation shown inside the processor |
| `payload` | Contract-specific JSON |
| `priority` | Higher values sort first; it is not scheduling policy |
| `labels` | Exact-match routing and cleanup hints, at most 32 string pairs |
| `correlationId` | Groups the items from one round or durable workflow |
| `parentId` | Links a follow-up to an existing attention item |
| `useBefore` | Optional timestamp after which the service expires an open item |

The daemon stores `contract` and JSON without interpreting them. Generic clients
may still create an externally negotiated contract with
`agentattention create file ITEM.json`; retain a version in the identifier
and validate both sides outside the daemon.

## Create once

The HTTP `POST /v1/items` operation requires `items:create` and an
`Idempotency-Key`. Repeating identical content with the same principal and key
returns the item in its current state. Reusing the key for different content
returns `409 idempotency_conflict`.

Keep the returned item id and correlation id with the producing workflow. An
agent can create several independent items, continue everything else it can do,
and then wait on all of them with one command.

## React to terminal outcomes

- `resolved`: validate and consume the contract-specific resolution.
- `returned`: inspect `returnOutcome.reason` and optional comment. For `stale`,
  rebuild the interaction state and create a fresh item rather than reopening
  the old one.
- `cancelled`: the producer or operator withdrew the work.
- `expired`: `useBefore` passed while the item was still open.

Cancel obsolete open items with `agentattention cancel ID --reason TEXT`, or
preview a narrowly filtered batch with `agentattention prune FILTERS` before
adding `--apply --reason TEXT`. Terminal items never reopen.
