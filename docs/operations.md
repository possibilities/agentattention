# Operating the daemon

## Files and defaults

- Configuration: `~/.config/agentattention/config.json`, mode 0600
- Database: `~/.local/state/agentattention/agentattention.sqlite3`
- HTTP listener: `127.0.0.1:7331`
- LaunchAgent: `~/Library/LaunchAgents/com.arthack.agentattention.plist`
- Logs: beside the database as `daemon.log` and `daemon.error.log`

Override the config path with `--config PATH` or `AGENTATTENTION_CONFIG`.
Version 1 refuses non-loopback listener addresses and does not implement TLS or
multi-user tenancy.

## Bootstrap and credentials

`agentattention init` refuses to overwrite an existing configuration and
prints the initial administrator token once. Configuration stores only token
hashes. Create scoped credentials with `credential create`; list and revoke
them with the corresponding commands. Restart after any credential change
because the daemon loads credentials at startup.

Scopes are:

- `items:create`, `items:read`, `items:claim`, `items:resolve`, `items:cancel`
- `events:read`
- `admin`, which must appear alone and grants all operations

## Process lifecycle

```bash
agentattention daemon install
agentattention daemon status
agentattention daemon stop
agentattention daemon start
agentattention daemon uninstall
```

`install` writes and loads a per-user LaunchAgent with `RunAtLoad` and
`KeepAlive`. `uninstall` removes only that LaunchAgent; it does not remove the
configuration, database, or logs.

Use `/healthz` for process liveness and `/readyz` for database readiness. These
two loopback endpoints do not require authentication.

## Storage behavior

SQLite uses WAL mode, foreign keys, and automatic numbered migrations. Item
mutations and events share a transaction. Item and claim deadlines are swept
once per second and opportunistically before relevant API operations, so a
restart cannot leave expired state permanently live.

Version 1 intentionally has no automatic retention. Back up the database and
its WAL consistently, preferably by stopping the daemon first or using
SQLite's online backup facility. Payloads, resolutions, and events are
plaintext; store opaque references instead of reusable secrets.

The daemon sends no outbound traffic. Notifications, webhooks, routing,
contract registries, queue policies, browser ownership, and inference belong
to clients built against this API.
