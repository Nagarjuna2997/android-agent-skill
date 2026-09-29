# Architecture

One TypeScript package ships modular runtime boundaries. CLI and MCP share the operation registry, Zod parameter schemas and execution functions. Android tools run as argument arrays without a shell. This keeps transport behavior consistent and lets tests inject a process runner.

```text
CLI / MCP
  └─ core/registry → validated operation
       ├─ android/inspect → bounded local scanner → graph
       ├─ gradle → project wrapper → reports/artifact hashes
       ├─ adb / emulator → selected device → observation
       ├─ analysis → findings with location/confidence/limits
       ├─ screenshots → local raster composition
       ├─ providers → explicit routing → normalized response
       └─ docs → approved official-source index/cache
core/runs → fingerprint + atomic state + evidence integrity
core/confirmation → exact action hash + expiry + single use
```

## Modules

- `packages/core`: context, process execution, safe paths, scanning, errors, evidence, doctor, operation registry and runs.
- `packages/android`: static Gradle/catalog/manifest graph.
- `packages/adb`, `emulator`, `gradle`: SDK and project tool adapters.
- `packages/analysis`: independent category rules with shared finding contracts.
- `packages/providers`: provider abstraction, routing, opt-in fallback, text streaming and multimodal/function requests where implemented.
- `packages/screenshots`: template validation, compositing, asset validation and export.
- `packages/mcp`, `cli`: transport adapters; no duplicated platform logic.
- `data`: dated versions/policy and official documentation index.

The scanner does not execute Gradle for inspection. Computed values remain unknown. A version catalog is a declaration inventory, not a dependency-resolution result. Report limitations are part of the result contract.

## Trust boundaries

The project is trusted for execution but untrusted for parsing. No DTDs or XML entities. Scanner skips symlinks and bounded/generated paths. Managed paths reject traversal and symlink ancestors. This prevents common mistakes, not adversarial filesystem races: concurrent hostile writers and privileged users are outside the threat model.

MCP is project-scoped with mutations disabled at startup by default. No HTTP listener, remote auth service or arbitrary shell tool is exposed. Destructive grants are short-lived and action-bound. A host capable of writing arbitrary project files can bypass local state controls; the host must enforce user authorization.

Provider output is advice/data. Tool calls are returned for host review, never executed. External providers require explicit configuration. No provider credentials are stored in project files. Local model URLs must use loopback.

## Evidence and resume

Process results include argv, exit status, timestamp, duration, timeout and truncation flags. Text is redacted before persistence. Captures/artifacts have SHA-256 hashes. Run state uses atomic replacement and an exclusive lock. Resume checks source fingerprints and completed result hashes. Hashes detect accidental changes; they do not authenticate against a malicious writer replacing all state.

## Extension approach

Add a module operation with a Zod schema, mutation/destructive classification and runner-injected tests. Register it once. Add platform-specific evidence requirements before claiming form-factor support. Prefer verified Gradle/Android Lint or compiler data for semantic findings over additional regex rules.
