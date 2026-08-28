# Contract examples

The `first-party-*.json` files document the bounded contracts validated by
Agentattention's CLI and TUI:

- `first-party-question-v1.json`
- `first-party-document-approval-v1.json`
- `first-party-browser-interaction-v1.json`

The remaining `com.example.*` files demonstrate the service's retained generic
capability. They are agreements an external producer and processor could
share; the daemon never loads, registers, dereferences, or validates them.

An attention envelope copies only the versioned `contract` identifier and a
matching payload. Never put reusable browser credentials, cookies, passwords,
or bearer tokens in one of these files or in an item.
