# Contributing

Use Node 22 or newer. Run `npm ci`, then `npm run check`, `npm run benchmark` and `npm run package:test`. Keep changes focused and include evidence for changed behavior. New operations need parameter validation, a mutation classification, failure tests and documented boundaries.

Never label mocked transport tests as device execution. Do not include credentials, private project paths, customer data or personal screenshots in commits. Avoid fabricated benchmark scores and claims of legal/store compliance.

Version-sensitive facts belong in `data/versions.json` with official source URL, verification date and review deadline. Do not automatically update a user's dependencies.

Read ARCHITECTURE.md and SECURITY.md before changing execution, provider, confirmation, filesystem or MCP boundaries. Add regression tests for security fixes. Run SDK tests only against explicitly selected disposable emulators/devices. Keep source changes and public publication within the user's authorization.
