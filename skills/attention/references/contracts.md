# First-party attention contracts

Read this reference when constructing a payload file, consuming a resolution,
or using the HTTP/client API instead of the CLI helpers. These validators live
in Agentattention's client/TUI modules; the server stores the values opaquely.

## Question

Contract: `dev.agentattention/question/v1`

Payload:

```json
{
  "questions": [
    { "id": "account", "prompt": "Which account should I use?" },
    {
      "id": "continue",
      "prompt": "Continue afterward?",
      "choices": [
        { "value": "yes", "label": "Yes, continue" },
        { "value": "no", "label": "No, stop" }
      ]
    }
  ]
}
```

There are 1–20 questions. Each id is a short identifier and unique within the
payload. A choices array has 2–20 unique values; no choices means required
free text.

Resolution preserves question order:

```json
{
  "answers": [
    { "questionId": "account", "answer": "person@example.com" },
    { "questionId": "continue", "answer": "yes" }
  ]
}
```

## Document approval

Contract: `dev.agentattention/document-approval/v1`

Payload:

```json
{
  "format": "markdown",
  "document": "# Plan\n\n1. Prepare state.\n2. Continue."
}
```

`format` is `markdown` or `plain`. Resolution is one of:

```json
{ "decision": "approved" }
```

```json
{
  "decision": "changes_requested",
  "comment": "Explain the recovery path."
}
```

The comment is required only for `changes_requested`.

## Browser interaction

Contract: `dev.agentattention/browser-interaction/v1`

Payload:

```json
{
  "targetName": "jobsearch",
  "requestedAction": "Sign in and leave the prepared form open."
}
```

`targetName` is an exact Agentbrowse Browser target name matching
`^[a-z][a-z0-9-]{0,31}$`. The bounded payload carries no connection descriptor
or secret. Successful resolution is:

```json
{ "outcome": "completed" }
```

It may also include a human note. An interaction the human cannot safely
finish is not encoded as a fake completed resolution; the processor returns
the attention item with a mechanical reason such as `stale`.

## Shared item outcomes

An attention item is terminal in `resolved`, `returned`, `cancelled`, or
`expired`. A returned item carries:

```json
{
  "reason": "stale",
  "comment": "The prepared form navigated away.",
  "returnedBy": "cred_…",
  "returnedAt": "2026-08-28T18:00:00.000Z"
}
```

The server records the reason and never infers recovery. `useBefore` is the
only service-owned freshness rule and mechanically yields `expired`.
