# Templates

Ready-to-copy starting points for an Android project, a CI pipeline, MCP client configuration and a style check hook. Every template uses `com.example.app` placeholders and the toolchain recorded in `data/versions.json`; nothing here carries a maintainer name or branding.

| Template | What it is | Apply when |
|---|---|---|
| `compose-app/` | Complete single-module Compose app: Hilt, type-safe Navigation Compose, one screen with all four states, unit and UI tests | Starting a new app from nothing |
| `ci-cd/github-actions-android.yml` | GitHub Actions workflow: lint, unit tests, debug build, report upload, optional emulator job | Adding CI to any Gradle Android project |
| `clients/` | MCP configuration snippets for Claude Code, Codex, Gemini CLI, Cursor and VS Code pointing at `android-agent mcp` | Wiring this repository's MCP server into a coding agent |
| `hooks/check-android-style.sh` | Bash check that fails on `GlobalScope`, `LiveData`, `EncryptedSharedPreferences`, `Thread.sleep` and missing `android:exported` | Pre-commit, CI, or an agent's post-edit hook |

## How an agent applies a template

1. Copy, do not symlink. `cp -r templates/compose-app /path/to/NewApp` or copy a single file into the target project. The target project owns the copy from then on.
2. Rename the package. Replace `com.example.app` everywhere (`namespace`, `applicationId`, package declarations, imports, test runner, ProGuard rules) and move source directories to match. The `compose-app/README.md` has the `sed` command.
3. Resolve versions from `data/versions.json`. Versions already present in the catalog (AGP, Kotlin, Compose BOM, AndroidX libraries) are filled in. Every `<version>` placeholder names a library that `data/versions.json` deliberately does not track; open the release page in the comment above it and write the current stable version. Never leave `<version>` in a file you hand to a build, and never guess.
4. Generate the Gradle wrapper. The wrapper jar is not in the repository. Run `gradle wrapper --gradle-version 9.6.0` or copy a wrapper from another project at that version.
5. Build and test before claiming it works: `./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest`. Report which commands ran.
6. Delete what the project does not need. Unused catalog aliases, the detail placeholder route, the sample repository. A template is a starting point, not a dependency.

For the CI workflow: copy to `.github/workflows/android.yml`, set the Java and Gradle versions to match the project, and enable the connected-tests job only once the project has instrumentation tests worth the emulator minutes.

For client configs: see `clients/README.md` for where each file goes and the `--project` path convention.

For the hook: `chmod +x` it, run it from the project root, and wire it into `.git/hooks/pre-commit`, CI, or an agent's post-edit hook as `hooks/check-android-style.sh app/src/main`.

## Keeping templates current

When `data/versions.json` changes, update `compose-app/gradle/libs.versions.toml`, the `compileSdk`/`targetSdk`/`minSdk` values, and the Gradle version in `compose-app/README.md` and `ci-cd/`. Then build the template once to confirm.
