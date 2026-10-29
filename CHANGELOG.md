# Changelog

## 0.2.0 — 2026-10-28

Added the engineering skill half of the project alongside the existing tooling:

- `SKILL.md` rewritten as an Android/Kotlin engineering skill with implementation rules, a verification contract and a load-by-task table; `CLAUDE.md` and `GEMINI.md` generated from it by `scripts/sync-client-files.mjs`; `skill.json` manifest; `install.sh` for Claude Code, Codex, Cursor and Gemini CLI.
- `patterns/`: MVVM, unidirectional data flow, Clean Architecture, repository, dependency injection (Hilt, Koin, manual), navigation (Navigation Compose and Navigation 3), error handling, Compose state, Material 3 theming, adaptive layouts, accessibility, animation, unit/Compose UI/screenshot testing.
- `capabilities/`: catalog (`CATALOG.md`, `catalog.json`) and 37 feature recipes, each with dependencies, manifest entries, implementation, verification and pitfalls.
- `checklists/`: Play Store submission, release, security, performance, testing, accessibility.
- `docs/`: agent engineering guide, coroutines and Flow, Kotlin style, Compose side effects and performance, app architecture, versions and compatibility, permissions, edge-to-edge and insets, migrating from Views.
- `templates/`: single-module Compose app template, GitHub Actions workflow, MCP client configuration snippets, `check-android-style.sh` hook.
- `scripts/check-links.mjs` and the `content:check` script, run by `npm run check` and a new CI job.

All content is written against `data/versions.json` (verified 2026-09-29). Versions outside that catalog are left as `<version>` placeholders with the official release page. No Android SDK build of the template was run in the authoring environment; nothing in this release claims a verified device or build result.

## 0.1.0 — 2026-09-29

Initial developer preview: local Android project inspection, CLI/MCP operation registry, ADB and emulator adapters, Gradle execution, heuristic audits, screenshots, optional model adapters, official-source index, evidence and deterministic run persistence. Includes automated tests, fixture benchmarks, package smoke testing, documentation and CI definitions.

No npm publication, device certification, agent-comparison score or production-readiness claim accompanies this source release.
