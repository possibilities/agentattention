# Waiting and resuming

An agent normally does as much autonomous work as possible, creates every
attention item it needs, and then waits for whichever terminal condition lets
it continue.

## Use the agent-friendly wait command

```bash
agentattention wait attn_one attn_two --json
agentattention wait attn_one attn_two --all --timeout 30m --json
agentattention wait --correlation jobsearch-round-42 --all --json
```

The default returns when any watched item becomes terminal; `--all` waits for
all. `--timeout` accepts milliseconds, seconds, minutes, or hours. The command
returns a structured reason (`terminal` or `timeout`), event cursor, every
current item snapshot, and the terminal subset.

Waiting is race-free: the client captures the latest durable event cursor
before its first item snapshot. If no terminal condition is already true, it
streams from that earlier cursor, so a transition between the snapshot and
subscription is replayed rather than lost. A disconnected stream reconnects
from the last observed cursor.

Terminal states are `resolved`, `returned`, `cancelled`, and `expired`.
Validate a resolved payload against its client-side contract. Treat a returned
item as producer-owned recovery, not as a failed resolution; a stale browser
handoff commonly means recreating the breadcrumb trail and submitting a new
attention item.

## Poll or consume events directly

`GET /v1/items/:id` returns an item-revision `ETag`; send it as
`If-None-Match` and unchanged state returns `304`.

`GET /v1/events?after=123` replays cursors greater than 123.
`GET /v1/events/stream?after=123` is Server-Sent Events using the durable
cursor as frame id. Persist a cursor only after your own effect commits;
delivery is at-least-once and downstream work needs its own idempotency.

Lifecycle events include:

- `item.created`
- `item.claimed`
- `item.claim.renewed`
- `item.claim.released`
- `item.claim.expired`
- `item.resolved`
- `item.returned`
- `item.cancelled`
- `item.expired`

Event data includes opaque payloads and outcomes. Protect `events:read` as
carefully as `items:read`.
