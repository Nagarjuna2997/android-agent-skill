# Android Agent Skill

[![CI](https://github.com/Nagarjuna2997/android-agent-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/Nagarjuna2997/android-agent-skill/actions/workflows/ci.yml)
![Stage: developer preview](https://img.shields.io/badge/stage-developer_preview-3ddc84)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
[![Site](https://img.shields.io/badge/site-nagarjuna2997.github.io%2Fandroid--agent--skill-3ddc84)](https://nagarjuna2997.github.io/android-agent-skill/)

Website: [nagarjuna2997.github.io/android-agent-skill](https://nagarjuna2997.github.io/android-agent-skill/) (install commands, searchable recipe catalog and CLI reference).

Android Agent Skill teaches AI coding agents (Claude Code, Codex, Gemini CLI, Cursor and other MCP or skill-aware clients) to build modern Android apps the way an experienced Kotlin developer would, and gives them local-first tooling to inspect projects, run Gradle builds and tests, drive emulators and devices, capture screenshots and report results with evidence.

It has two halves that work together:

1. **The skill**: `SKILL.md` plus `patterns/`, `capabilities/`, `checklists/`, `docs/` and `templates/`. Dense, version-pinned Kotlin and Jetpack Compose guidance an agent loads by task: architecture patterns, 47 feature recipes, release and security checklists, a buildable app template and CI workflow. No API key, no build step; install it as a skill or point the agent at the checkout.
2. **The tooling**: the `android-agent` CLI and stdio MCP server. Project analysis, Gradle builds, lint and tests, ADB and emulator control, UI hierarchy interaction, heuristic audits (Compose, Firebase, permissions, privacy, Play, accessibility, security), screenshots and deterministic resumable runs.

**Developer preview, v0.3.0.** The skill content is written against Android 17 / API 37, AGP 9.4.0, Kotlin 2.4.20 and Compose BOM 2026.09.00 (see `data/versions.json`, verified 2026-09-29). The CLI and MCP server work locally; static findings are bounded heuristics, and device operations require your Android SDK and a real authorized device or running emulator. Read [validation](docs/VALIDATION.md) and [limitations](ROADMAP.md) before relying on a capability.

## Install the skill

```sh
# Claude Code (project-local .claude/skills/android-agent-skill)
curl -fsSL https://raw.githubusercontent.com/Nagarjuna2997/android-agent-skill/main/install.sh | bash -s -- --client claude

# Codex (~/.codex/skills/android-agent-skill)
curl -fsSL https://raw.githubusercontent.com/Nagarjuna2997/android-agent-skill/main/install.sh | bash -s -- --client codex

# Cursor (.cursor/skills/android-agent-skill)
curl -fsSL https://raw.githubusercontent.com/Nagarjuna2997/android-agent-skill/main/install.sh | bash -s -- --client cursor

# Gemini CLI: prints how to use GEMINI.md
curl -fsSL https://raw.githubusercontent.com/Nagarjuna2997/android-agent-skill/main/install.sh | bash -s -- --client gemini
```

The installer clones this repository into the client's skills directory (or fast-forwards an existing checkout). `CLAUDE.md` and `GEMINI.md` are generated copies of the `SKILL.md` body for clients that read those files from a project root. Agents should start at `patterns/README.md` and `capabilities/CATALOG.md` and open only the files a task needs; `SKILL.md` has the load-by-task table.

## What the skill covers

| Area | Where | Highlights |
|---|---|---|
| Architecture | `patterns/` | MVVM with `StateFlow` UiState, unidirectional data flow, Clean Architecture modules and convention plugins, offline-first repositories, Hilt and Koin, Navigation Compose and Navigation 3, error handling |
| UI | `patterns/ui/` | Compose state and stability, Material 3 theming and dynamic color, adaptive layouts with `WindowSizeClass` and pane scaffolds, accessibility, animation |
| Testing | `patterns/testing/` | ViewModel and repository tests with Turbine and a dispatcher rule, Compose UI tests, Compose Preview screenshot tests |
| Feature recipes | `capabilities/` | 47 step-by-step recipes with dependencies, manifest entries, Kotlin implementation, verification commands and pitfalls: Room, DataStore, Retrofit and Ktor, WorkManager, notifications, deep links, biometrics, Credential Manager sign-in, Firebase Auth/Firestore/FCM/Crashlytics, Play Billing, CameraX, photo picker, Coil, Paging, Maps, location, Glance widgets, Media3, on-device AI, baseline profiles and more |
| Platform guides | `docs/` | Agent engineering workflow, coroutines and Flow, Kotlin style, Compose side effects and performance, recommended app architecture, version compatibility and behavior changes, permissions, edge-to-edge and insets, migrating from Views |
| Checklists | `checklists/` | Play Store submission, release, security, performance, testing, accessibility, code quality |
| Reference studies | `references/` | What this repository adopted from Google's official samples (Now in Android, architecture-samples, compose-samples, Sunflower, ndk-samples, UAMP), which toolchain each sample is on, and what not to copy from them |
| Templates | `templates/` | Single-module Compose app (Hilt, type-safe navigation, tests), native library module with CMake and JNI, GitHub Actions workflow with optional emulator and baseline-profile jobs, MCP client config snippets, a style-check hook |

Every guide cites versions from `data/versions.json` or says a version must be resolved from the official release page, ends with a `Verify` section naming the commands or tests that prove the work, and marks anti-patterns explicitly. Generated apps belong to their users: the skill forbids inserting maintainer branding or package identifiers into generated code.

## Install the tooling from source

Requires Node.js 22 or newer. Android execution additionally needs a configured JDK/SDK and trusted project Gradle wrapper.

```sh
git clone https://github.com/Nagarjuna2997/android-agent-skill.git
cd android-agent-skill
npm ci
npm run build
npm link
android-agent --help
android-agent doctor --project /path/to/android/project --json
```

The npm name was unregistered when checked on 2026-09-29. This repository does **not** claim the npm package is published. Once a reviewed release is published, the intended install is `npm install -g android-agent-skill`. Until then use source or the locally packed tarball.

## Quick start

```sh
android-agent inspect --project /path/to/app --json
android-agent build --project /path/to/app --variant Debug
android-agent test unit --project /path/to/app
android-agent devices list --json
android-agent ui inspect --project /path/to/app --device emulator-5554
android-agent ui tap --project /path/to/app --device emulator-5554 --text Settings
android-agent screenshot --project /path/to/app --device emulator-5554 --output settings.png
android-agent firebase audit --project /path/to/app --json
android-agent play validate --project /path/to/app --platform phone --json
```

Commands report errors with a nonzero exit status. `--json` emits an `{ok,result}` or `{ok:false,error}` envelope. An audit report can contain findings while its command succeeds; consumers must inspect severities. Doctor returns nonzero for failed prerequisites. Common flags: `--project`, `--device`, `--json`, `--dry-run`, `--timeout` (milliseconds), `--quiet`, `--verbose`, `--confirm`. Provider/model options belong to `agent analyze` and `models set`.

## Capabilities

- Static project graph: Gradle files, version catalogs, literal SDK settings, Kotlin/Java counts, manifest components and permissions, dependencies and integration signals.
- Gradle build, bundle API, lint, unit and connected instrumentation/Compose tasks; fresh artifacts and JUnit reports receive hashes and evidence.
- ADB device selection, install/uninstall, app launch/stop, tap/swipe/type, navigation, rotation, PNG capture, bounded recording and logs.
- AVD listing, profile listing, creation from installed images, launch requests, boot verification, stop and snapshots.
- UI hierarchy inspection and unique text/resource-ID selection. Password fields are masked in parsed hierarchy output.
- Heuristic Compose, Firebase, permissions, privacy, Play, accessibility and security reviews. Raw runtime frame/memory capture and crash log extraction.
- Local screenshot templates: stack, split and minimal layouts, supplied localization, validation and export manifests.
- Optional Gemini, OpenAI, Claude and loopback model adapters. External context transmission defaults off; fallback is explicit.
- Scoped MCP, deterministic resumable plans, single-use destructive confirmations, local evidence and an official-source documentation index.

Run `android-agent capabilities --json` for the authoritative operation inventory, or read [CLI and MCP reference](docs/COMMANDS.md). Unimplemented commands are not advertised as successful integrations.

## MCP setup

Build/install first, then configure your MCP client to launch:

```json
{
  "mcpServers": {
    "android-agent": {
      "command": "android-agent",
      "args": ["--project", "/absolute/path/to/android/app", "mcp"]
    }
  }
}
```

The server binds to one project root and communicates over stdio. Mutation tools are present but blocked by default. Add `--allow-mutations` after `mcp` when the host/user permits Gradle and device actions. Destructive operations still require an exact confirmation grant issued separately through the CLI. The confirmation-issuing tool is not exposed through MCP.

Protocol handshake, tool listing, read calls and mutation denial are tested with the official MCP SDK client. Client-specific setup in Codex, Claude Code, Gemini CLI, Gemini Code Assist, Cursor, Windsurf and VS Code is **not yet individually tested**; their configuration formats may differ. See [integrations](docs/INTEGRATIONS.md).

## Execution with evidence

Understand → execute → observe → verify → propose a fix → retest → provide evidence.

```sh
android-agent runs create --project /path/to/app --file review-plan.json
android-agent runs resume --project /path/to/app --id RUN_UUID
android-agent runs show --project /path/to/app --id RUN_UUID
```

Copy `examples/inspect-plan.json` into your project. Run state stores source fingerprints, timestamps and hashed step results. Changed source or corrupted evidence invalidates resume. An interrupted running step needs manual review rather than blind replay. This release does not autonomously edit source or execute model-proposed tool calls.

## Screenshots

Copy `examples/screenshot-template.json` into the project, capture a PNG, then:

```sh
android-agent screenshots generate --project /path/to/app --file capture.png --template template.json --output listing.png
android-agent screenshots validate --project /path/to/app --file listing.png
android-agent screenshots export --project /path/to/app --files listing.png --output play-assets
```

Use translated captions and locale-specific app captures for localization. No machine translation, branded hardware frames, or Play approval claims. Review resulting text and layout visually.

## Security and privacy

No telemetry. No provider uploads by default. `.gitignore` and `.androidagentignore` exclude files from project scanning. Generated evidence lives under `.android-agent/`; add it to your project's ignore file. Captures and device logs can contain personal data. Redaction is best effort, not a guarantee. Review before sharing.

Gradle wrappers/build scripts execute arbitrary project code. Only build trusted repositories. This tool is not a sandbox. External model responses and retrieved documents are untrusted and never execute automatically. Read [SECURITY.md](SECURITY.md).

## Development

```sh
npm run check
npm run benchmark
npm run package:test
```

`npm run check` also runs `npm run content:check`, which verifies that `CLAUDE.md`/`GEMINI.md` match `SKILL.md` and that every relative link in the skill content resolves. After editing `SKILL.md`, run `node scripts/sync-client-files.mjs`.

[Skill entry](SKILL.md) · [Agent engineering guide](docs/agent-engineering-guide.md) · [Patterns](patterns/README.md) · [Capabilities](capabilities/CATALOG.md) · [Architecture](ARCHITECTURE.md) · [Current technology sources](docs/RESEARCH.md) · [Benchmarks](benchmarks/README.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Website

The documentation site at [nagarjuna2997.github.io/android-agent-skill](https://nagarjuna2997.github.io/android-agent-skill/) is built from `site/` (static HTML, CSS and JavaScript, no trackers, no backend) and deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main` that touches the site or the capability catalog. The recipe list on the site is rendered from `capabilities/catalog.json`; after editing the catalog run `node scripts/render-site-catalog.mjs` (CI fails if `site/capabilities.js` is stale). The CLI reference comes from `node scripts/inventory.mjs`.
