# CI/CD templates

## github-actions-android.yml

A GitHub Actions workflow for a Gradle Android project.

Jobs:

- `check` (always): validates the Gradle wrapper, checks `build-logic/` if present, runs the style hook, `spotlessCheck` and `dependencyGuard` when those plugins are applied (see [../../checklists/code-quality.md](../../checklists/code-quality.md)), then `lintDebug`, `testDebugUnitTest`, `assembleDebug`, and uploads the lint report (HTML and SARIF to code scanning), unit test reports and the debug APK.
- `connected` (optional): boots an emulator with `reactivecircus/android-emulator-runner` at API 26 and API 36 and runs `connectedDebugAndroidTest`. It runs on pushes to `main` and on manual dispatch with `run_connected_tests` set. Emulator jobs are slow and need KVM; keep them off PRs until the suite is stable, then remove the `if`.

Install:

```sh
mkdir -p .github/workflows
cp templates/ci-cd/github-actions-android.yml .github/workflows/android.yml
```

- `baseline_profile` (manual): generates a baseline profile on a Gradle-managed device and uploads it as an artifact. Needs a `:baselineprofile` module; see `capabilities/app-startup-and-baseline-profiles/README.md`. Move it to a nightly `schedule` once it runs green.

Then edit:

- `MODULE` if the application module is not `app`.
- `JAVA_VERSION` only if the project's AGP needs something other than 17 (AGP 9.4.0 runs on 17; see `data/versions.json`).
- The `api-level` matrix to match the project's `minSdk` and `targetSdk`.
- Branch names in `on:` to match the repository.

The workflow uses the project's Gradle wrapper, so the Gradle version is whatever `gradle/wrapper/gradle-wrapper.properties` says. `gradle/actions/setup-gradle` caches dependencies and the configuration cache between runs; the cache is read-only on branches other than `main` so pull requests from forks cannot write to it. Add a `GRADLE_ENCRYPTION_KEY` repository secret (`openssl rand -base64 16`) so the configuration cache can be stored; without it only the dependency cache is kept. Every Gradle call uses `GRADLE_FLAGS` (`--no-daemon --stacktrace --configuration-cache`); if a plugin is not configuration-cache compatible, remove that flag from the variable rather than ignoring the failure.

Not included, by design:

- Release signing and Play upload. Store the keystore and Play service account as encrypted secrets, decode them in a separate `release` job that runs on tags only, and use `r0adkll/upload-google-play` or the Play Developer API. Keep that job out of PR runs.
- Screenshot tests. Add `./gradlew :app:validateDebugScreenshotTest` to `check` once Compose Preview Screenshot Testing is enabled in the project.
- Dependency update bots. Renovate or Dependabot config lives outside the workflow.

## Running the same checks locally

```sh
hooks/check-android-style.sh app/src/main
./gradlew :app:lintDebug :app:testDebugUnitTest :app:assembleDebug
```

CI must never be the first place a build fails.
