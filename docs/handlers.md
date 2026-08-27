# Building handlers

A handler may be a human inbox, an agent that can answer a contract directly,
an agent walking a human through a response, or a tool that redirects the
human to another live application. The daemon treats them identically.

## Select outside the service

Find candidates with `GET /v1/items?status=open`. Filters include exact
`contract`, `correlationId`, repeated `label=key=value`, and claim state.
Results sort by priority descending and then creation time. The cursor preserves
that ordering.

The list API supplies storage primitives, not a dequeue policy. A handler may
choose FIFO, batch by contract, present a manual lane, or feed selected items
to another agent.

## Claim before a long interaction

```http
POST /v1/items/attn_…/claim
Authorization: Bearer …
Content-Type: application/json

{"leaseSeconds":300}
```

Claims are optional but recommended whenever selection and resolution are not
one immediate operation. The returned item contains the claim id. A second claimant receives
`409 already_claimed`. Repeating the claim as the same principal is
idempotent but does not extend the lease.

Renew with `PATCH /v1/items/:id/claim` and release with
`DELETE /v1/items/:id/claim`. Both require the claim id. If a lease expires,
the daemon emits `item.claim.expired` and another handler may claim the item.
Use a lease long enough for the human interaction and renew it while the
handler is demonstrably alive.

## Interpret the negotiated contract

Dispatch on the exact `contract` identifier. The handler—not the daemon—must:

- reject an unsupported contract version;
- validate the payload before presenting or acting on it;
- validate the resolution it is about to submit;
- understand live references and fallback recovery instructions;
- decide whether an agent may answer directly or must involve a human.

A malformed item remains open until a producer cancels it or it expires. A
handler should release its claim and surface a clear diagnostic rather than
inventing a resolution.

## Resolve atomically

```http
POST /v1/items/attn_…/resolution
Authorization: Bearer …
Idempotency-Key: review-session-42-submit
Content-Type: application/json

{
  "claimId":"clm_…",
  "resolution":{"decision":"comment","comment":"Make the opening concrete."}
}
```

If an item is claimed, only the active claim holder can resolve it and must
provide `claimId`. An immediate handler may resolve an unclaimed item without
a claim id; concurrent attempts are serialized and only one terminal
transition wins. The terminal transition, opaque resolution, claim removal,
event, and idempotency record commit together.
Retry the identical request after a lost response; do not mint a new key until
you know the first attempt did not commit.
