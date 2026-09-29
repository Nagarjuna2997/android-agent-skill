# Android Agent Skill

[![CI](https://github.com/Nagarjuna2997/android-agent-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/Nagarjuna2997/android-agent-skill/actions/workflows/ci.yml)
![Stage: developer preview](https://img.shields.io/badge/stage-developer_preview-3ddc84)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Android Agent Skill gives AI coding agents real Android development capabilities — project analysis, Gradle builds, emulator control, UI interaction, testing, Firebase analysis, Play Store validation, screenshots, diagnostics, and more.

**Developer preview, v0.1.0.** Working CLI and stdio MCP server with local-first execution. Static findings are bounded heuristics. Device operations require your Android SDK and a real authorized device or running emulator. Read [validation](docs/VALIDATION.md) and [limitations](ROADMAP.md) before relying on a capability.

## Install from source

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

[Architecture](ARCHITECTURE.md) · [Current technology sources](docs/RESEARCH.md) · [Benchmarks](benchmarks/README.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

Documentation website source is in `site/`. It uses static HTML, CSS and JavaScript, without external trackers or a runtime backend.
