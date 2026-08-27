# Agentattention development

Read `CONTEXT.md` before changing domain language. The service is deliberately
schema-agnostic: never add contract registration, schema fetching, schema
validation, routing, inference, or handler behavior to the daemon.

Use Bun 1.3.14 or newer.

```bash
bun install
bun run check
bun run src/cli.ts --help
```

Every persisted mutation must append its event in the same SQLite transaction.
New public behavior must be reflected in `openapi.json` and the task-oriented
documents under `docs/`.
