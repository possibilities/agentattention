# agentattention

`agentattention` is a durable local control plane for work that needs a human.
Agents create attention items, human-facing tools claim and resolve them, and
producers either poll an item or resume from an event cursor.

The daemon does not understand the work. `contract` is an opaque namespaced
identifier; `payload` and `resolution` are arbitrary JSON negotiated by the
producer and handler. The service provides storage, lifecycle, concurrency,
authentication, expiry, and event delivery—not schema registration, routing,
inference, notifications, browser control, or a UI.

## Start it

Requires Bun 1.3.14 or newer.

```bash
bun install
bun run src/cli.ts init
bun run src/cli.ts daemon install
bun run src/cli.ts daemon status
```

`init` writes a mode-0600 configuration to
`~/.config/agentattention/config.json` and prints the administrator token once.
`daemon install` installs and starts a per-user macOS LaunchAgent. For
foreground development, use `bun run src/cli.ts serve` instead.

Create narrower credentials for actual clients:

```bash
agentattention credential create \
  --name cover-letter-producer \
  --scopes items:create,items:read,items:cancel,events:read

agentattention credential create \
  --name review-tool \
  --scopes items:read,items:claim,items:resolve,events:read
```

Restart the daemon after changing credentials.

## Create and observe an item

```bash
curl --fail-with-body http://127.0.0.1:7331/v1/items \
  -H "Authorization: Bearer $AGENTATTENTION_PRODUCER_TOKEN" \
  -H "Idempotency-Key: application-acme-cover-letter-v1" \
  -H 'Content-Type: application/json' \
  --data '{
    "contract": "com.example.cover-letter-review/v1",
    "title": "Review the Acme cover letter",
    "correlationId": "application-acme",
    "payload": {"draft": "Dear Acme…"}
  }'
```

Poll `GET /v1/items/:id` (using its `ETag`) or consume
`GET /v1/events/stream?after=<cursor>`. See the task-oriented guides:

- [Creating attention items](docs/producers.md)
- [Building human and agent handlers](docs/handlers.md)
- [Waiting and resuming reliably](docs/waiting.md)
- [Operating the daemon](docs/operations.md)
- [OpenAPI 3.1 contract](openapi.json)
- [Example externally negotiated contracts](examples/contracts/README.md)

## Lifecycle

An attention item is `open` until one terminal transition wins:

```text
                   resolve
open + claim  -----------------> resolved
     |              cancel
     +--------------------------> cancelled
     |              deadline
     +--------------------------> expired
```

A claim is an optional, expiring exclusive lease, not a durable assignment.
Only its holder can renew, release, or resolve a claimed item. An unclaimed
item may be resolved atomically without first claiming it. Cancellation
belongs to producers or operators and invalidates any active claim.

## Development

```bash
bun run check
```

SQLite migrations are applied automatically. Events and idempotency records
are retained indefinitely in version 1.
