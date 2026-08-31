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

`src/contract.ts` is the CLI's single authority: the fleet agent contract that
`guide --json` publishes. `--help`, `help COMMAND`, `--agent-help`, and
`--agent-teaser` are renders of it (`src/guide.ts`), and every command's argv
grammar is derived from it (`commandSpec`, consumed by `parseArgs`). A new
command or argument is added there and nowhere else — never write a second list
of accepted flags beside the parser.

Every persisted mutation must append its event in the same SQLite transaction.
New public behavior must be reflected in `openapi.json` and the task-oriented
documents under `docs/`.
