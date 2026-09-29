# Validation — 2026-09-29

Environment: macOS arm64, Node v24.15.0, npm 11.12.1. These are local results; GitHub Actions matrix results must be checked independently.

| Check | Observed result |
|---|---|
| TypeScript build | Passed |
| ESLint | Passed |
| Strict typecheck, including unused declarations | Passed |
| Unit and integration tests | 42 passed, 0 failed, 0 skipped |
| MCP | Real stdio initialization, listing, inspection call and mutation denial passed |
| Providers | Mock HTTP contract tests, schema rejection, fallback and streaming parsing passed; no live API calls |
| Screenshot renderer | Generated an opaque PNG, validated dimensions, preserved source, refused overwrite |
| Fixture benchmarks | 5/5 broken/repaired pairs validated; not an agent comparison |
| npm pack + clean temporary install | Passed; CLI help and packaged catalog worked |
| Packed archive | 56,654 bytes, 48 entries, version 0.1.0 |
| Production dependency audit | 0 vulnerabilities reported at execution time |
| Local website | Rendered in browser; command search filtered Firebase operations correctly |

Actual check output is retained under `validation/`. Fixture timings and hashes are in `../benchmarks/results.json`. Final suite execution after dependencies loaded took about 0.76 seconds; first-load filesystem stalls during this session are not represented as agent performance.

## Requested command smoke tests

- `android-agent --help`: exit 0.
- `android-agent inspect --json`: exit 0 on this repository; Android fixture graph behavior is tested separately.
- `android-agent doctor --json`: exit 1 with missing Java/adb prerequisites and other tooling warnings.
- `android-agent devices --json` and `emulator list --json`: explicit executable-unavailable errors.
- `android-agent build --json` and `test --json`: explicit missing-wrapper errors in this non-Android repository.

Machine-readable observations are in `smoke-results.json`. No Android build, boot, install, real screenshot capture or instrumentation test was executed. Device command construction is mock-tested. No real device or emulator was available, and no SDK license was accepted or toolchain silently installed.

## Release interpretation

Source and npm packaging are ready for a developer-preview review. This is not a stable/production release sign-off. Runtime Android acceptance, broader analyzers and client-specific integration checks remain in ROADMAP.md. npm has not been published, and source publication does not create a tagged GitHub Release or deploy the website.
