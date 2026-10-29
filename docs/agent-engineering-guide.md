# Agent engineering guide for Android projects

How an AI coding agent should take an Android task from first look to an honest report: inspect the project, fix the SDK and toolchain decisions, pick an architecture and capabilities, implement, build, lint, test, run on a device, and separate what was verified from what was not.

## Context budget

Every file in this repository costs context. Load in this order and stop when you have what you need.

1. `SKILL.md` (entry point, always).
2. `patterns/README.md` and `capabilities/CATALOG.md` (one-page indexes).
3. `data/versions.json` only when you need to write a version number.
4. The single pattern or capability file the current step needs. Do not load `docs/` wholesale; the table below maps triggers to files.

| Trigger | Load |
|---|---|
| Any ViewModel, state or event | `patterns/unidirectional-data-flow.md`, `patterns/mvvm.md` |
| Suspend functions, Flow, collection in UI | `docs/kotlin/coroutines-and-flow.md` |
| Kotlin idioms, naming, package layout | `docs/kotlin/kotlin-style.md` |
| `LaunchedEffect`, `DisposableEffect`, `snapshotFlow` | `docs/compose/state-and-side-effects.md` |
| Jank, recomposition, lazy lists, images | `docs/compose/performance.md` |
| Layers, modules, where a class belongs | `docs/android/app-architecture.md` |
| Which SDK, AGP, Gradle, Kotlin, BOM to write | `docs/android/versions-and-compatibility.md` |
| Camera, location, notifications, any permission | `docs/android/permissions.md` |
| Status bar, nav bar, keyboard, cutouts | `docs/android/edge-to-edge-and-insets.md` |
| Existing XML, Fragments, ViewBinding | `docs/android/migrating-from-views.md` |
| Repository, DI, navigation, errors | the matching `patterns/*.md` |
| Theming, adaptive layouts, accessibility, animation | `patterns/ui/*.md` |
| Unit, Compose UI, screenshot tests | `patterns/testing/*.md` |
| New project from nothing | `templates/README.md`, then `templates/compose-app/` |
| Shipping | `checklists/release.md`, `checklists/play-store-submission.md` |

## 1. Inspect before you write

Never assume the project shape. Inspect it.

With this repository's CLI installed:

```sh
android-agent inspect --project /absolute/path/to/project --json
```

The JSON names the Gradle modules, plugins, SDK levels, Kotlin and AGP versions, the version catalog, declared permissions and application id. Read the whole output once; do not re-run it per step.

Without the CLI, read these files in this order:

1. `settings.gradle.kts`: included modules, plugin management repositories, `dependencyResolutionManagement`.
2. `gradle/libs.versions.toml`: every version and alias in use. Reuse aliases that exist; add new ones in the same style.
3. `gradle/wrapper/gradle-wrapper.properties`: the Gradle version. Do not upgrade it as a side effect.
4. Root `build.gradle.kts`: plugin declarations with `apply false`.
5. `app/build.gradle.kts` (and each module's): `compileSdk`, `minSdk`, `targetSdk`, `namespace`, applied plugins (`kotlin.plugin.compose`, `ksp`, `hilt`), build types, `buildFeatures`.
6. `app/src/main/AndroidManifest.xml`: components, permissions, `android:exported`.
7. `gradle.properties`: `android.useAndroidX`, JVM args, `android.nonTransitiveRClass`.
8. The source tree under `src/main/kotlin` or `src/main/java` to find the existing architecture (look for `ViewModel`, `Repository`, `Module`, `NavHost`).

Record what you found in two or three lines before changing anything. If the project uses Views, Koin, Navigation3, or a multi-module layout, match it. Introducing a second DI framework or a second navigation library is a defect, not an improvement.

## 2. Decide SDK levels and toolchain

Read `docs/android/versions-and-compatibility.md` for the reasoning; the short rules are:

- `compileSdk`: the newest stable, currently 37 (Android 17). Compile against the newest so new APIs and lint checks are available.
- `targetSdk`: what Google Play requires for new apps and updates, currently 36 for phone, tablet and foldable. Raising `targetSdk` opts the app into behavior changes; read the behavior-change list before raising it.
- `minSdk`: a product decision. The AndroidX default is 24. The template uses 26 so notification channels and adaptive icons exist without compatibility branches. Do not lower an existing project's `minSdk` and do not raise it without saying so in the report.
- AGP 9.4.0 with Gradle 9.6.0 and JDK 17. Kotlin 2.4.20 with the Compose compiler Gradle plugin `org.jetbrains.kotlin.plugin.compose`. Compose BOM 2026.09.00.
- For libraries not listed in `data/versions.json` (Hilt, Retrofit, OkHttp, Coil, Koin, Ktor, kotlinx.serialization, Maps, ML Kit, Play services) look up the version on the official release page and cite it. Never guess a version number.

If an existing project is on older versions, keep them unless the task is an upgrade. A feature task that also upgrades AGP is two tasks and twice the risk.

## 3. Choose architecture

Read `patterns/README.md`. The default for a new app is:

- UI layer: Compose screens plus a `ViewModel` per screen exposing one immutable `UiState` through `StateFlow`, collected with `collectAsStateWithLifecycle()`. The UI sends events to the ViewModel; the ViewModel never references composables, `Context` or `Activity`.
- Domain layer (optional): use cases only when logic is shared by more than one ViewModel or is complex enough to test on its own.
- Data layer: repositories behind interfaces, backed by local (Room, DataStore) and remote (Retrofit or Ktor) sources. Repositories own the single source of truth and expose `Flow` for observable data and `suspend` functions for one-shot operations.
- DI: Hilt by default. Koin if the project already uses it.
- Navigation: Navigation Compose with type-safe `@Serializable` routes; Navigation3 only if the project is already on it.

Model every screen's state explicitly as loading, empty, success and error. A screen that cannot represent "empty" will show a blank list and no one will notice until a user does.

Write out, in one paragraph, the ViewModel, repository, data sources and routes you will add before writing code. This is the plan you will check the result against.

## 4. Pick capabilities

Open `capabilities/CATALOG.md`, find each platform feature the task needs (camera, notifications, background work, billing, maps, auth, storage), and load only that capability's `README.md`. Each one carries the dependency aliases, manifest entries, permission flow and verification steps. Do not bring in a capability the task did not ask for.

For each capability note:

- The permissions it needs and whether any are runtime or special permissions (`docs/android/permissions.md`).
- The manifest entries: components must declare `android:exported` explicitly; foreground services must declare `android:foregroundServiceType`.
- The behavior changes at the chosen `targetSdk` that affect it.

## 5. Implement

Order of work for a new feature:

1. Version catalog entries and module dependencies.
2. Data layer: models, data sources, repository interface, real implementation, fake implementation.
3. ViewModel with `UiState`, events and a unit test skeleton.
4. Screen composable: stateless content composable taking `UiState` and lambdas, plus a thin stateful wrapper that obtains the ViewModel. Add a `@Preview` using the fake repository or a hand-built `UiState`.
5. Navigation route and wiring.
6. Manifest and resources (strings, themes).

Rules that apply to every line:

- Kotlin, Compose, Material 3. No new XML layouts unless the project is Views-based and the task says so.
- `viewModelScope` for ViewModel work; inject `CoroutineDispatcher`s; never `GlobalScope`; never block the main thread with `runBlocking` or `Thread.sleep`.
- Errors as sealed results or `runCatching` with `CancellationException` rethrown. Never an empty `catch`.
- Strings in `res/values/strings.xml`, never inline in composables except in previews.
- `contentDescription` on every meaningful image and icon button; `null` on decorative ones. Touch targets of at least 48dp.
- `enableEdgeToEdge()` in the Activity and inset handling through `Scaffold` padding or `WindowInsets` modifiers.
- No secrets in source. No `EncryptedSharedPreferences` (deprecated); use Android Keystore with DataStore, or Tink.

Keep diffs minimal. Do not reformat files you did not need to change.

## 6. Build

```sh
./gradlew :app:assembleDebug
```

Run it from the project root with the project's own wrapper. If the wrapper is missing, say so and ask before generating one; do not switch to a system `gradle` silently because the version can differ.

Read the full error output. Kotlin compiler errors name the file and line; Gradle configuration errors usually sit in the first fifty lines, not the last. Fix the first error, rebuild, repeat. Do not disable a lint check, add `@Suppress`, or change `allWarningsAsErrors` to make a build pass.

For a multi-module project, build the module you changed first, then the app module.

## 7. Lint

```sh
./gradlew :app:lintDebug
```

Open `app/build/reports/lint-results-debug.html` or the `.xml` beside it. Treat errors as blocking. Treat warnings in files you touched as blocking too; warnings in files you did not touch are out of scope and should be reported, not fixed.

Lint checks that catch real defects in agent-written code: `MissingPermission`, `UnusedResources`, `ExportedService`, `NewApi`, `CoroutineCreationDuringComposition`, `FlowOperatorInvokedInComposition`, `StateFlowValueCalledInComposition`, `RememberReturnType`, `ComposableNaming`, `MutableCollectionMutableState`.

## 8. Unit tests

```sh
./gradlew :app:testDebugUnitTest
```

Write at least one test per ViewModel that drives it through loading, success and error using a fake repository, `MainDispatcherRule` and Turbine (`patterns/testing/unit-testing.md`). Run the whole unit test task, not one class, so you see regressions.

Reports: `app/build/reports/tests/testDebugUnitTest/index.html`. Read the failure stack trace, not just the summary line.

## 9. Connected tests

Connected tests need a running device or emulator.

```sh
adb devices
./gradlew :app:connectedDebugAndroidTest
```

Compose UI tests use `createAndroidComposeRule<MainActivity>()` or `createComposeRule()` and assert through semantics (`onNodeWithText`, `onNodeWithContentDescription`, `onNodeWithTag`). Reports: `app/build/reports/androidTests/connected/debug/index.html`.

With this repository's CLI:

```sh
android-agent test instrumented --project /absolute/path/to/project
android-agent test compose --project /absolute/path/to/project
```

If no device is available, say so. Do not report connected tests as passed because they compiled.

## 10. Run on an emulator

```sh
emulator -list-avds
emulator -avd Pixel_9_API_36 -no-snapshot-load &
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done'
./gradlew :app:installDebug
adb shell am start -n com.example.app/.MainActivity
adb logcat -v time *:E | head -n 100
adb exec-out screencap -p > /tmp/screen.png
```

Or with the CLI:

```sh
android-agent emulator launch --project PATH --name Pixel_9_API_36
android-agent emulator boot-wait --project PATH
android-agent run --project PATH --package com.example.app
android-agent device screenshot --project PATH --output screen.png
android-agent device logs --project PATH --lines 200
```

Exercise the feature you built: tap through it, rotate (`adb shell settings put system user_rotation 1`), background and foreground the app, revoke a permission (`adb shell pm revoke com.example.app android.permission.CAMERA`) and reopen. Look at the screenshot. Read logcat for `FATAL EXCEPTION`, `StrictMode`, `Choreographer: Skipped` and `ANR`.

## 11. Verify with evidence

Before claiming anything, ask what artifact proves it:

| Claim | Evidence |
|---|---|
| It compiles | `assembleDebug` output ending in `BUILD SUCCESSFUL`, with the task list |
| Lint is clean | Lint report with zero errors in touched files |
| Logic is correct | Unit test run with the test names and counts |
| The screen renders | Connected test result or a screenshot from a device |
| The feature works | A described manual run on a device with what was tapped and what appeared |
| Nothing else broke | Full unit test run, not only the new class |

A `@Preview` rendering in Android Studio is not evidence that the app runs. A green build is not evidence that a Flow emits. A test that mocks the thing under test proves nothing.

## 12. Report honestly

Structure the report in three labeled groups and never merge them:

- Inspected source: what you read and concluded without running anything.
- Built and tested: the exact commands run, their results, and the test counts. Quote the command, not a paraphrase.
- Unverified on device: anything that needs a device, a signed build, a Play Console, a real account or a physical sensor and was not exercised. Say what would verify it.

Also list: files added and changed with paths; version catalog changes; permissions added; behavior that changed for existing users; anything you chose that the task left open (for example `minSdk`). If something failed and you could not fix it, include the error text and what you tried. A report that hides a failure costs the user more than the failure did.

## Example end-to-end run

Task: "Add a screen that lists saved notes from Room and lets the user add one."

1. `android-agent inspect --project . --json`: single module `app`, Hilt, Navigation Compose, Room not yet present, `compileSdk 37`, `targetSdk 36`, `minSdk 26`.
2. Plan: add `room` aliases to the catalog; `NoteEntity`, `NoteDao`, `AppDatabase`; `NoteRepository` interface with `RoomNoteRepository` and `FakeNoteRepository`; `NotesViewModel` with `NotesUiState` (`Loading`, `Empty`, `Content(notes)`, `Error(message)`) and events `Add(text)`, `Retry`; `NotesScreen` plus `NotesContent`; route `Notes` in `AppNavigation`.
3. Capability: `capabilities/room/README.md` for KSP setup and migration rules.
4. Implement in the order from section 5.
5. `./gradlew :app:assembleDebug` succeeds after one fix (missing `ksp` dependency on `room-compiler`).
6. `./gradlew :app:lintDebug`: zero errors.
7. `./gradlew :app:testDebugUnitTest`: 14 tests, 14 passed, including `NotesViewModelTest` covering loading, empty, add, and DAO failure.
8. Emulator: installed, opened Notes, added "Buy milk", rotated, note persisted, killed the app with `adb shell am force-stop`, reopened, note present. Screenshot saved. No errors in logcat.
9. Report in three groups: inspected, built and tested, unverified (the database migration path from version 1 to 2 was not exercised because this is the first schema).

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:lintDebug
./gradlew :app:testDebugUnitTest
adb devices && ./gradlew :app:connectedDebugAndroidTest
```

All four must run, and the report must say which ones did.

## Sources

- https://developer.android.com/topic/architecture
- https://developer.android.com/build
- https://developer.android.com/studio/run/emulator-commandline
- https://developer.android.com/tools/adb
- https://developer.android.com/studio/write/lint
- https://developer.android.com/training/testing
- https://developer.android.com/google/play/requirements/target-sdk
