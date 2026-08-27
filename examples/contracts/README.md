# Example external contracts

These files demonstrate agreements that producers and handlers could share.
`agentattention` never loads, registers, dereferences, or validates them.

- `question-v1.json` — answer a bounded question
- `plan-approval-v1.json` — approve, reject, or comment on a plan
- `browser-captcha-v1.json` — prefer a live browser handoff, retain fallback breadcrumbs
- `cover-letter-review-v1.json` — batch-friendly approval or comment
- `permission-v1.json` — approve or deny an agent action

Each example contains a request schema and a resolution schema for client-side
validation. Its `contract` value is the only part copied into the attention
item envelope.
