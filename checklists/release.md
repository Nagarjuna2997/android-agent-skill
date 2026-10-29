# Release Checklist

From a green main branch to a production rollout. Play-specific listing and policy items are in [play-store-submission.md](play-store-submission.md); this file is the engineering side: versions, variants, signing, CI gates, rollout and monitoring.

## Versioning

- [ ] `versionCode` increases monotonically on every upload and is derived from one source (CI build number, a git tag, or a counter in `gradle.properties`), because Play rejects a reused or lower code and a human-edited number eventually collides.
- [ ] `versionName` follows semantic versioning (`1.4.0`) and is visible in the app's About or Settings screen so support can ask for it.
- [ ] One place computes both; feature modules do not set versions.

```kotlin
// app/build.gradle.kts
val buildNumber = (System.getenv("CI_BUILD_NUMBER") ?: "1").toInt()
android.defaultConfig {
    versionCode = 10_000 + buildNumber          // leaves room below for hotfixes from an older branch
    versionName = "1.4.0" + if (System.getenv("CI") == null) "-local" else ""
}
```

- [ ] A git tag `v1.4.0` is created from the exact commit that produced the production bundle, so a crash report can be mapped back to source.

## Changelog

- [ ] `CHANGELOG.md` or the release notes file updated with user-facing changes under the version heading before the bundle is built; the Play release notes are copied from it, not written from memory on release day.
- [ ] Internal changes (refactors, dependency bumps) listed separately from user-facing ones, so the store text stays short.
- [ ] Breaking changes to persisted data (Room schema, DataStore keys) called out with the migration that handles them.

## Build variants and configuration

- [ ] `debug` and `release` build types only, plus product flavors if there are real distribution differences (`dev` / `prod` backend). Avoid a `staging` build type; use a flavor dimension for the environment so the release build type is always the one you ship.
- [ ] Backend URLs, feature flags and keys per flavor come from `buildConfigField` populated from CI environment or a non-committed properties file, never from hardcoded strings in source.
- [ ] `applicationIdSuffix = ".debug"` on the debug build type so debug and release install side by side.
- [ ] Release: `isMinifyEnabled = true`, `isShrinkResources = true`, `isDebuggable = false`, `proguard-android-optimize.txt` plus the app's own rules; the R8 mapping file archived with the build.
- [ ] The release build is installed and smoke-tested locally at least once per release, because R8 and resource shrinking only run there.
- [ ] `BuildConfig` generation (`buildFeatures.buildConfig = true`) only in modules that need it; AGP 9 defaults it off.

## Signing

- [ ] Upload keystore and its passwords exist only in the CI secret store and a password manager; the file is in `.gitignore` and has never been committed (check with `git log --all -- '*.jks' '*.keystore'`).
- [ ] CI writes the keystore from a base64 secret to a temp path, builds, then deletes it.

```yaml
# GitHub Actions excerpt
- name: Decode keystore
  run: echo "$UPLOAD_KEYSTORE_B64" | base64 -d > ${{ runner.temp }}/upload.jks
  env: { UPLOAD_KEYSTORE_B64: ${{ secrets.UPLOAD_KEYSTORE_B64 }} }
- name: Build bundle
  run: ./gradlew :app:bundleRelease
  env:
    UPLOAD_KEYSTORE_PATH: ${{ runner.temp }}/upload.jks
    UPLOAD_KEYSTORE_PASSWORD: ${{ secrets.UPLOAD_KEYSTORE_PASSWORD }}
    UPLOAD_KEY_ALIAS: ${{ secrets.UPLOAD_KEY_ALIAS }}
    UPLOAD_KEY_PASSWORD: ${{ secrets.UPLOAD_KEY_PASSWORD }}
    CI_BUILD_NUMBER: ${{ github.run_number }}
```

- [ ] Play App Signing enrolled; the upload key can be reset through the Console if lost, the app signing key is Google's responsibility.
- [ ] Debug builds use the default debug keystore; a shared debug keystore committed for Firebase or Maps SHA-1 registration is acceptable because it signs nothing shippable.

## CI gates (must pass before a release build is produced)

- [ ] `./gradlew assembleDebug lintRelease testDebugUnitTest validateDebugScreenshotTest` on the release commit.
- [ ] Instrumented flow tests on a Gradle-managed device for the release branch.
- [ ] Lint `warningsAsErrors = true` for the release variant, with a baseline file for pre-existing warnings so new ones fail the build.
- [ ] Dependency and secret scanning (see [security.md](security.md)).
- [ ] Bundle size compared with the previous release; an unexplained jump over 10 percent blocks until explained.
- [ ] Baseline profile regenerated if startup code changed (see [performance.md](performance.md)).
- [ ] 16 KB page alignment check on native libraries (see [play-store-submission.md](play-store-submission.md)).
- [ ] The bundle is built once by CI and that same artifact is promoted through tracks; no rebuilding for production.

## Pre-release verification

- [ ] Internal testing track: install from Play on two physical devices (oldest supported API and newest), sign in, run the main flows, check the About screen shows the expected version.
- [ ] Upgrade path tested: install the previous production version, use it, then install the new build over it; Room migrations and DataStore changes must not lose data or crash.
- [ ] Fresh install path tested: clear data, first launch, onboarding, permissions.
- [ ] Offline behavior tested: airplane mode on the main screens.
- [ ] Pre-launch report reviewed for crashes, ANRs and security warnings.
- [ ] Release notes and listing updates staged in the Console.

## Rollout

- [ ] Production release starts as a staged rollout at 5 to 10 percent for apps with a large user base, 20 to 50 percent for small ones, so a crash hits a fraction of users.
- [ ] Expansion rule written down: for example, expand to 25 percent after 24 hours if the crash-free rate is at or above the previous release, 100 percent after 72 hours.
- [ ] Halt rule written down: halt immediately on a new crash cluster affecting over 0.5 percent of sessions, on a spike in ANRs, or on a login or payment failure report; a halted rollout stops new users from receiving the build while existing ones keep it.
- [ ] Hotfix process ready: a branch from the release tag, `versionCode` above the halted build, same checks, straight to a fresh staged rollout.
- [ ] In-app updates (`com.google.android.play:app-update`) configured for flexible updates on routine releases and immediate updates reserved for security or compatibility fixes.
- [ ] Managed publishing used when the release must coincide with a marketing date or a backend deploy; otherwise it goes live on approval.

## Crash and quality monitoring

- [ ] Crash reporter (Firebase Crashlytics via Firebase BoM 34.18.0, or an equivalent) initialized in release with the R8 mapping uploaded, so stack traces are readable.
- [ ] Non-fatal reporting for `AppError.Unknown` and for caught exceptions that indicate a bug (see [../patterns/error-handling.md](../patterns/error-handling.md)), with identifiers scrubbed.
- [ ] Android vitals checked daily during the rollout: crash rate, ANR rate, excessive wakeups, slow cold starts, and the per-device breakdown for a device-specific regression.
- [ ] Alerts set on crash-free users dropping below the previous release's value and on any new issue with more than a handful of users in the first hour.
- [ ] Custom keys attached to crash reports: screen name, build flavor, feature flag state; never user content.
- [ ] A named owner watches the rollout for the first 48 hours and has the Console permission to halt it.

## After the release

- [ ] Rollout expanded to 100 percent and the release marked complete in the Console.
- [ ] Release tag pushed, changelog heading finalized with the date, `versionName` on main bumped to the next development version.
- [ ] Mapping file, bundle and build logs archived for the retention period the team agreed on.
- [ ] Retrospective note on anything that blocked or delayed the release, with a checklist item added here if it should be caught earlier.

## Verify

```sh
git log --all --diff-filter=A -- '*.jks' '*.keystore'           # must print nothing
./gradlew :app:bundleRelease -PversionCheck                      # whatever task validates versionCode monotonicity
unzip -p app/build/outputs/bundle/release/app-release.aab base/manifest/AndroidManifest.xml | head -c 0  # bundle exists
bundletool dump manifest --bundle=app/build/outputs/bundle/release/app-release.aab | grep -E "versionCode|versionName|debuggable"
ls app/build/outputs/mapping/release/mapping.txt                 # R8 mapping present
```

State which device and build (`versionCode`) you verified on when reporting a release as ready.

## Sources

- https://developer.android.com/studio/publish
- https://developer.android.com/studio/publish/versioning
- https://developer.android.com/studio/publish/app-signing
- https://developer.android.com/build/build-variants
- https://developer.android.com/build/shrink-code
- https://support.google.com/googleplay/android-developer/answer/9859348 (Staged rollouts)
- https://support.google.com/googleplay/android-developer/answer/9844486 (Android vitals)
- https://developer.android.com/guide/playcore/in-app-updates
- https://firebase.google.com/docs/crashlytics/get-started?platform=android
- https://developer.android.com/build/releases/agp-9-4-0-release-notes
