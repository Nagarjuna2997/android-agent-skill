# Security

Report vulnerabilities through the repository's private GitHub vulnerability reporting feature when available. Otherwise contact the maintainer through the GitHub profile to arrange private disclosure; do not open a public issue containing secrets or exploit details against a live service.

## Local-first defaults

No telemetry. External provider transmission requires `externalEnabled: true` in the explicitly selected project config. API keys come from environment variables only. Fallback providers must be explicitly listed. Model output never executes automatically.

`.androidagentignore` and `.gitignore` filter scans. Defaults omit `.env*`, keystores, local SDK properties, build directories, node_modules and internal state. Ignored files cannot be audited: a clean report is not proof that no secrets exist. Scanning service-account JSON reports locations without printing credential values.

Logs, screenshots, app data and hierarchy labels may contain personal information. Redaction detects common patterns and configured environment secrets but is not comprehensive. Local evidence is sensitive and must be reviewed before sharing. Add `.android-agent/` and captures to your own ignore rules.

## Execution boundary

Only run Gradle wrappers from trusted projects. Gradle itself executes arbitrary build/plugin code and can access network, files and credentials. ADB commands act on an authorized device; use disposable test devices/accounts for UI automation. The package does not sandbox project execution.

Destructive actions require exact short-lived single-use grants. MCP cannot issue grants and defaults to denying mutations. Confirmation state is not a security boundary against an agent or user with arbitrary filesystem write access. Avoid concurrent confirmation consumption; adversarial filesystem mutation/races are outside the current threat model.

No cloud deployments, Firebase rules writes, signing changes or store publishing are implemented. Avoid giving runtime sessions production credentials.

## Dependencies

Lockfile is committed. Run `npm audit --omit=dev --audit-level=high` and review upgrades. Native screenshot rendering uses sharp/libvips; enforce input size limits and keep patched dependencies current.
