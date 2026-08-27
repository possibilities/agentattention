# Creating attention items

This guide is for an agent or tool that discovers it needs a human.

## Negotiate the contract elsewhere

Choose a stable, namespaced `contract` such as
`com.example.plan-approval/v1`. Its producer and handler must separately agree
on the request payload and expected resolution. That agreement can live in a
skill, package, repository document, or JSON Schema file.

The daemon stores the identifier and JSON values without resolving the
identifier or validating either value. Include a version in the identifier;
never change an existing contract's meaning in place.

## Create once

`POST /v1/items` requires `items:create` and an `Idempotency-Key`. Repeating
the same request with the same principal and key returns the same item in its
current state.
Reusing the key for different content returns `409 idempotency_conflict`.

```json
{
  "contract": "com.example.plan-approval/v1",
  "title": "Approve the database migration plan",
  "payload": {
    "summary": "Add an index concurrently, then remove the old index",
    "planUrl": "file:///workspace/docs/migration-plan.md"
  },
  "priority": 20,
  "labels": {
    "project": "billing",
    "lane": "blocking"
  },
  "correlationId": "billing-migration-2026-08",
  "parentId": null,
  "expiresAt": "2026-08-28T18:00:00.000Z"
}
```

Envelope fields are deliberately small:

| Field | Purpose |
|---|---|
| `contract` | Opaque negotiated contract identifier, normally versioned |
| `title` | Human-readable inbox text |
| `payload` | Any JSON value; semantics belong to the contract |
| `priority` | Higher values sort first; it is not scheduling policy |
| `labels` | Exact-match routing/filter hints, at most 32 string pairs |
| `correlationId` | Groups related items and events for one progenitor/workflow |
| `parentId` | Links a follow-up to an existing attention item |
| `expiresAt` | Optional terminal deadline, distinct from a claim lease |

Put browser references, fallback breadcrumbs, artifact pointers, or display
hints inside the opaque payload. Avoid putting passwords, cookies, bearer
tokens, or other reusable secrets in it: version 1 stores SQLite content in
plaintext.

## Continue other work

Keep the returned item id and the latest event cursor with your own durable
work state. A producer can create several independent items under one
`correlationId`, continue autonomous work, and later consume matching events.
The daemon does not decide whether the producer should block.

## Cancel obsolete work

`POST /v1/items/:id/cancellation` requires `items:cancel`, an
`Idempotency-Key`, and a specific reason. Cancellation wins only while the item
is open, clears any claim, and emits `item.cancelled`. A terminal item never
reopens; create a follow-up item instead.
