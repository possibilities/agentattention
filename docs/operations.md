# Operating the service

## Fleet ownership

Agentattention ships its command and hardened installer. AgentStart decides
that the tool is present and exclusively owns the resident
`agentattention.server` LaunchAgent. There are intentionally no
`agentattention daemon install|start|stop` commands and no second plist owner.

Use `scripts/install.sh --install` to install the editable command and
bootstrap configuration on a new machine. In the fleet, rerun AgentStart's
installer to converge the service. For development, run `agentattention serve`
in the foreground.

## Files and defaults

- Server configuration: `~/.config/agentattention/config.json`, mode 0600
- Local client credential: `~/.config/agentattention/client.json`, mode 0600
- Database: `~/.local/state/agentattention/agentattention.sqlite3`
- HTTP listener: `127.0.0.1:7331`
- Fleet LaunchAgent: `~/Library/LaunchAgents/agentattention.server.plist`
- Fleet log: `~/.local/state/agentattention/server.log`

Override configuration for foreground tools with `--config`,
`--client-config`, `AGENTATTENTION_CONFIG`, or
`AGENTATTENTION_CLIENT_CONFIG`. The fleet service intentionally uses the
defaults. Version 1 refuses non-loopback listeners and implements neither TLS
nor multi-user tenancy.

## Credentials

`agentattention init` atomically creates a server config, a broad non-admin
local client credential, and a separate administrator credential. It refuses
to overwrite either config and prints the administrator token once. The local
client token is retained only in its mode-0600 client file.

Credential management reads and updates the server config directly:

```bash
agentattention credential create --name producer \
  --scopes items:create,items:read,items:cancel,events:read
agentattention credential list
agentattention credential revoke ID_OR_EXACT_NAME
```

Restart the AgentStart-owned service after credential changes. Scopes are
`items:create`, `items:read`, `items:claim`, `items:resolve`, `items:return`,
`items:cancel`, and `events:read`. `admin` appears alone and grants every HTTP
operation.

## Health and storage

Use unauthenticated loopback `/healthz` for liveness and `/readyz` for database
readiness plus the current event cursor.

SQLite uses WAL mode, foreign keys, and automatic numbered migrations. Schema
v2 migrates v1 `expiresAt` data into `useBefore`, adds optional context and the
returned terminal outcome, and preserves related claims, events,
idempotency records, and resolutions. Every mutation and its event share one
transaction.

Use-before times and claim leases are swept once per second and
opportunistically before relevant API operations. Version 1 has no automatic
retention. Back up the database and WAL consistently. Payloads, resolutions,
return comments, and events are plaintext; store bounded context and opaque
references rather than passwords, cookies, bearer tokens, or Live View
credentials.

The daemon sends no outbound traffic and performs no inference. Notifications,
queue policy, first-party validation, browser control, and stale-state recovery
belong to clients and producing agents.
