# Android Agent Skill maintenance

This is a standalone Android project. Keep public documentation focused on Android Agent Skill. The Android engineering guidance that coding agents follow lives in `SKILL.md` (mirrored to `CLAUDE.md` and `GEMINI.md` by `node scripts/sync-client-files.mjs`); this file covers repository maintenance.

Use Node 22+. Run npm run check, npm run benchmark and npm run package:test before release. Keep registry schemas, mutation metadata, CLI/MCP behavior and the generated command inventory consistent. Run node scripts/inventory.mjs after registry changes and node scripts/sync-client-files.mjs after editing SKILL.md.

Knowledge content (patterns/, capabilities/, checklists/, docs/, templates/) must cite versions from data/versions.json or say that a version must be resolved from the official release page. Never fabricate a version, API, device, provider, benchmark or deployment result. Static analysis is heuristic unless backed by compiler/runtime evidence. Read SECURITY.md before changing execution, confirmation, filesystem or provider boundaries. External source transmission is opt-in, and model output never executes automatically.

Publish only within the user's authorized repository/release scope. Do not include local credentials, logs or private paths in public changes.
