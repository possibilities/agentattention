# Building and running processors

A processor presents one attention item and produces one terminal decision.
Agentattention ships standalone processors for its three first-party contracts
and a queue TUI that foregrounds them one at a time.

## Drain the human queue

Run:

```bash
agentattention tui
```

The queue lists open items in service order and marks unsupported external
contracts. It refreshes silently in the background: an empty queue holds
`NO ITEMS` at the center of the viewport, while a nonempty queue renders only
its attention items. Selecting a supported item suspends the queue renderer,
launches `agentattention process ID` with inherited terminal I/O, then resumes
and refreshes the queue when that child exits. Each standalone processor can
also be run directly.

The question processor supports one or several required free-text or
single-choice answers. The document processor approves or requests changes
with a required comment. The browser processor first shows the item's title,
context, requested action, and exact target, then connects Agentbrowse's live
surface and requests human control. It does not select or create a different
Browser target.

All actions are discoverable through `ctrl+k`, including completion, returning
stale, and leaving without resolving. Pointer actions mirror command rows. The
TUIs do not emit sound or notifications.

## Claim around a long interaction

The first-party dispatcher validates the payload before claiming. It then:

1. claims for five minutes;
2. renews every two minutes while the processor is active;
3. resolves or returns using that exact claim id; and
4. releases the claim if the human goes back, rendering fails, or submission
   does not commit.

Other processors should follow the same pattern. A claim is optional for an
immediate atomic handler but recommended whenever selection and completion are
separate. A second principal receives `409 already_claimed`. An expired lease
emits `item.claim.expired` and lets another processor claim the item.

## Resolve or return

Resolution is an opaque contract value:

```http
POST /v1/items/attn_…/resolution
Authorization: Bearer …
Idempotency-Key: processor-submit-42
Content-Type: application/json

{"claimId":"clm_…","resolution":{"decision":"approved"}}
```

When the request cannot be completed, use the distinct terminal return
outcome:

```http
POST /v1/items/attn_…/return
Authorization: Bearer …
Idempotency-Key: processor-return-42
Content-Type: application/json

{"claimId":"clm_…","reason":"stale","comment":"The form navigated away."}
```

The daemon records a mechanical reason and never decides what it means. The
producer owns recovery. Both operations may act atomically on an unclaimed item
when `claimId` is null; if a claim exists, only its holder may finish it.

## External contracts remain possible

The service does not register or route contracts. An external processor must
dispatch on an exact versioned identifier, validate payload and resolution,
and decide whether it can involve a human safely. If malformed input cannot be
processed, release the claim and surface a diagnostic; do not invent a
resolution.
