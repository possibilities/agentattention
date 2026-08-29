---
name: attention
description: Hand work to the human through the agentattention queue, then wait for durable outcomes. Use when an agent needs answers to one or more questions, approval of a document or plan, or human interaction with an exact Agentbrowse Browser target such as sign-in, MFA, or a captcha; also use to inspect, cancel, or recover outstanding attention items. Do not build a project-local human queue around these cases.
---

# Attention — durable human handoff

`agentattention` is the shared lifecycle for work an agent cannot finish alone.
Create bounded attention items, continue everything else you can do, and wait
for their durable terminal outcomes. The human drains the same queue through
`agentattention tui`; producers do not need Herdr messaging, harness-specific
monitors, sounds, or desktop notifications.

## Non-negotiables

- Prefer the three first-party contracts below. Use generic `create --file`
  only when a separately implemented producer and processor already share an
  external contract; the server deliberately does not route or validate one.
- Every item gets a concise `--title`. Use `--context` or `--context-file` for
  the full explanation, constraints, and state the agent expects afterward.
- Never put passwords, cookies, bearer tokens, CDP URLs, Live View credentials,
  or other reusable secrets in an attention item. A browser item contains the
  exact Agentbrowse Browser target name, not its connection details.
- Use `--json` whenever the next step depends on command output. Branch on the
  structured item state or error code, not human-formatted lines.
- Terminal items never reopen. A stale or expired interaction is rebuilt and
  submitted as a new item, optionally linked with `--parent`.
- Do not claim producer-created items. Claims belong to the human processor and
  are managed automatically by the first-party TUI.

If the CLI reports `client_config_unreadable`, ordinary handoff work stops and
reports the local installation fault. When the user has authorized toolchain
repair, recover without exposing a bearer token, then restart the managed
service:

```bash
agentattention --json client init
"$HOME/code/agentstart/scripts/install-launchagents" --install
```

`client init` refuses an existing client file and writes its new or rotated
credential directly at mode 0600. Never reconstruct client JSON from printed
credential output or from the server's token hashes.

## One work round

1. Do all autonomous work that can be done now.
2. Create every independent human handoff you discovered. Give the round one
   stable `--correlation` value and useful `--label key=value` filters.
3. Continue work that does not depend on those items.
4. Wait once for the relevant set. Use `--all` only when all items are required
   before anything can continue; otherwise the default wakes on the first
   terminal item.
5. Consume terminal outcomes, do the newly unblocked work, and wait again only
   if open items remain. When the queue is empty, stop. A human request such as
   “start another round” begins fresh discovery and work.

This is the normal long-lived-agent shape: work, queue what remains, wait,
resume. Do not recreate `find-jobs`/`drain-queues`-style split lifecycle state in
the consuming project.

## Create bounded items

### Questions and answers

```bash
agentattention --json create question \
  --title "Choose the next search lane" \
  --context "Remote-first results are exhausted for this round." \
  --correlation jobsearch-round-42 \
  --label project=jobsearch \
  --question "Which lane should I search next?" \
  --choice startup="Early-stage startups" \
  --choice broad="Broaden the current search" \
  --idempotency-key jobsearch-round-42-lane
```

Repeat `--question` for several related free-text questions. Choices are
available when creating one question and use `value=Human label`. For a fully
specified mixed questionnaire, pass `--payload-file` and read
[references/contracts.md](references/contracts.md).

### Document approval

```bash
agentattention --json create approval \
  --title "Approve the application plan" \
  --context-file ./attention-context.md \
  --document ./plan.md \
  --correlation jobsearch-round-42 \
  --label project=jobsearch \
  --idempotency-key jobsearch-round-42-plan
```

Markdown is inferred from `.md`; use `--format markdown|plain` to override.
The human either approves or requests changes with a required comment.

### Browser interaction

Use this after automation has prepared a named agent-browser session through
Agentbrowse. Resolve the stable session to its current exact Browser target
incarnation before creating the item:

```bash
browser_target="$(agentbrowse resolve jobsearch --json | jq -er '.data.target.name')"

agentattention --json create browser \
  --title "Sign in to Workday" \
  --context "Use the job-search account. Leave the application form open." \
  --target "$browser_target" \
  --action "Complete sign-in, MFA, or any challenge blocking the prepared form." \
  --correlation jobsearch-round-42 \
  --label project=jobsearch \
  --idempotency-key jobsearch-round-42-workday-signin
```

Sign-in is an ordinary browser-interaction item; it does not require a profile
to be captured in a separate preliminary workflow. The human processor opens
the exact target through Agentbrowse's shared live surface. It will not resolve
the stable session again, pick a different target, or reconstruct missing
navigation.

Use `--use-before RFC3339` only when the prepared state has a real mechanical
validity window. The service compares the clock and does no harder staleness
inference.

## Capture ids and wait

The successful `--json` envelope is `{ "ok": true, "data": <item> }`. Keep
`.data.id` in the producing workflow. Prefer one wait command for all relevant
ids:

```bash
agentattention --json wait attn_one attn_two
agentattention --json wait attn_one attn_two --all
agentattention --json wait --correlation jobsearch-round-42 --all --timeout 30m
```

The command captures a durable event cursor before its first snapshots, then
replays and follows from that cursor; no transition can fall between polling
and subscription. Timeout is a structured result, not proof that an item
changed. Harnesses may choose their own mechanism for supervising a blocking
command, but the command and response contract stays the same in Claude,
Codex, and Pi.

## Consume outcomes

- **`resolved`** — validate `resolution.payload` against the first-party
  contract, then continue the workflow.
- **`returned`** — read `returnOutcome.reason` and `comment`. On `stale`, inspect
  current state, replay the breadcrumb trail, and create a fresh browser item.
  Do not reinterpret the return as a resolution.
- **`cancelled`** — the producer or operator withdrew it; decide whether the
  broader workflow still makes sense.
- **`expired`** — its `useBefore` time passed. Rebuild only if the underlying
  goal is still current.

For exact payload and resolution shapes, read
[references/contracts.md](references/contracts.md).

## Inspect and maintain the queue

```bash
agentattention --json show ATTENTION_ID
agentattention --json list --status open --correlation ROUND_ID
agentattention --json status --label project=jobsearch
agentattention --json events --item ATTENTION_ID
agentattention --json cancel ATTENTION_ID --reason "No longer needed"
```

Bulk cleanup is preview-first and requires a narrow contract, correlation, or
label filter:

```bash
agentattention --json prune --correlation jobsearch-round-42
agentattention --json prune --correlation jobsearch-round-42 \
  --apply --reason "Round superseded"
```

`agentattention --help` is the complete installed command surface and wins if
this runbook ever drifts.
