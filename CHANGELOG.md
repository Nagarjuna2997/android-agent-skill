# Changelog

## 0.3.0 — 2026-10-30

Distilled six official Google Android samples (Now in Android, architecture-samples, compose-samples, Sunflower, ndk-samples, UAMP; all Apache-2.0) into the skill as original re-implementations, with a reference study per sample in `references/` recording what was adopted, what was deliberately not copied, and how far each sample's toolchain sits from `data/versions.json`.

- Ten new capabilities (47 total): `datastore-proto`, `offline-first-sync`, `design-system-module`, `rich-text-and-markdown`, `compose-drawing-and-graphics`, `tv-and-large-screen-app`, `ndk-native-code`, `oboe-low-latency-audio`, `vulkan-and-gles-rendering`, `media-session-service`. Native, Oboe, Vulkan/GLES and TV recipes are marked runtime-unverified.
- New `checklists/code-quality.md` (Spotless, ktlint, detekt, custom lint module, Dependency Guard, API surface checks) and `docs/android/native-code.md`.
- New `templates/native-module/` (CMake, JNI bridge, 16 KB page alignment, instrumented test) and a CI workflow with configuration cache, Spotless and Dependency Guard steps, lint SARIF upload and a manual baseline-profile job.
- Extended patterns: Clean Architecture gains the feature api/impl split, a `:core:*` module taxonomy and a complete `build-logic` convention-plugin example; MVVM gains a comparison with architecture-samples; adaptive layouts, animation, theming, Compose state and accessibility gain sections drawn from Reply, JetNews, Jetsnack, Jetchat and JetLagged; repository and Room gain asset seeding and relations; testing gains test-double modules, Roborazzi screenshots, shared fakes and navigation tests through the real graph.
- `scripts/check-links.mjs` now walks `references/`.

## 0.2.0 — 2026-10-28

Added the engineering skill half of the project alongside the existing tooling:

- `SKILL.md` rewritten as an Android/Kotlin engineering skill with implementation rules, a verification contract and a load-by-task table; `CLAUDE.md` and `GEMINI.md` generated from it by `scripts/sync-client-files.mjs`; `skill.json` manifest; `install.sh` for Claude Code, Codex, Cursor and Gemini CLI.
- `patterns/`: MVVM, unidirectional data flow, Clean Architecture, repository, dependency injection (Hilt, Koin, manual), navigation (Navigation Compose and Navigation 3), error handling, Compose state, Material 3 theming, adaptive layouts, accessibility, animation, unit/Compose UI/screenshot testing.
- `capabilities/`: catalog (`CATALOG.md`, `catalog.json`) and 37 feature recipes, each with dependencies, manifest entries, implementation, verification and pitfalls.
- `checklists/`: Play Store submission, release, security, performance, testing, accessibility.
- `docs/`: agent engineering guide, coroutines and Flow, Kotlin style, Compose side effects and performance, app architecture, versions and compatibility, permissions, edge-to-edge and insets, migrating from Views.
- `templates/`: single-module Compose app template, GitHub Actions workflow, MCP client configuration snippets, `check-android-style.sh` hook.
- `scripts/check-links.mjs` and the `content:check` script, run by `npm run check` and a new CI job.
- Documentation site deployed to GitHub Pages at https://nagarjuna2997.github.io/android-agent-skill/ by `.github/workflows/pages.yml`; the site gains a skill section and a searchable recipe catalog rendered from `capabilities/catalog.json` by `scripts/render-site-catalog.mjs`.

All content is written against `data/versions.json` (verified 2026-09-29). Versions outside that catalog are left as `<version>` placeholders with the official release page. No Android SDK build of the template was run in the authoring environment; nothing in this release claims a verified device or build result.

## 0.1.0 — 2026-09-29

Initial developer preview: local Android project inspection, CLI/MCP operation registry, ADB and emulator adapters, Gradle execution, heuristic audits, screenshots, optional model adapters, official-source index, evidence and deterministic run persistence. Includes automated tests, fixture benchmarks, package smoke testing, documentation and CI definitions.

No npm publication, device certification, agent-comparison score or production-readiness claim accompanies this source release.
