# Android Agent Skill maintenance

This is a standalone Android project. Keep public documentation focused on Android Agent Skill.

Use Node 22+. Run npm run check, npm run benchmark and npm run package:test before release. Keep registry schemas, mutation metadata, CLI/MCP behavior and the generated command inventory consistent. Run node scripts/inventory.mjs after registry changes.

Never fabricate device, provider, benchmark or deployment results. Static analysis is heuristic unless backed by compiler/runtime evidence. Read SECURITY.md before changing execution, confirmation, filesystem or provider boundaries. External source transmission is opt-in, and model output never executes automatically.

Publish only within the user's authorized repository/release scope. Do not include local credentials, logs or private paths in public changes.
