# Waiting and resuming

Producers can poll one attention item or consume the durable event feed. Both
read the same transactional state.

## Poll one item

`GET /v1/items/:id` returns an `ETag` based on the item revision. Send it as
`If-None-Match` on the next request; unchanged state returns `304`.

Terminal states are `resolved`, `cancelled`, and `expired`. For a resolved
item, validate `resolution.payload` against the contract negotiated outside
the daemon before using it.

## Replay events

`GET /v1/events?after=123` returns events with cursors greater than 123 and a
`nextCursor`. Filters for item, contract, and correlation id apply equally to
replay and streaming.

Persist a cursor only after your own effects for that event commit. Delivery
is at-least-once: a crash between your effect and cursor persistence can cause
the event to be seen again, so downstream work needs its own idempotency key.

## Stream updates

`GET /v1/events/stream?after=123` is Server-Sent Events. Each frame uses the
durable cursor as its SSE id, the event kind as its SSE event name, and the
complete event object as JSON data.

Reconnect with either `after=<persisted cursor>` or `Last-Event-ID`. The query
parameter takes precedence. Heartbeats are SSE comments and do not advance the
cursor. A disconnect never means the underlying attention item changed; replay
from the last committed cursor.

Common events are:

- `item.created`
- `item.claimed`
- `item.claim.renewed`
- `item.claim.released`
- `item.claim.expired`
- `item.resolved`
- `item.cancelled`
- `item.expired`

The feed includes opaque payloads and resolutions. Protect an `events:read`
credential as carefully as an `items:read` credential.
