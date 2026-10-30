# Reference study: Now in Android (android/nowinandroid)

What the official Now in Android sample does well, what it does for its own reasons, and where each adopted technique now lives in this repository. The code in this repository is an original re-implementation; nothing here is copied from the sample.

## What the sample is

Now in Android (NiA) is Google's flagship "production-shaped" Android app: a news and topics reader with offline-first data, a design system module, Hilt, Room, Proto DataStore, WorkManager sync, Navigation 3, Roborazzi screenshot tests, a custom lint module, Jacoco coverage, baseline profiles, Firebase in a `prod` flavor and a `demo` flavor backed by local JSON. It is a multi-module project of roughly 35 Gradle modules whose main purpose is to demonstrate modularization, build logic and testing at scale.

Checkout studied: shallow clone at `/tmp/samples/nowinandroid`, last commit dated 2026-10-20.

## Toolchain it is on right now

From `gradle/libs.versions.toml` in the checkout, compared with `data/versions.json` (verified 2026-09-29):

| Component | NiA | This repo | Note |
|---|---|---|---|
| AGP | 9.3.2 | 9.4.0 | lags by one minor |
| Kotlin | 2.3.0 | 2.4.20 | lags |
| Compose BOM | 2025.09.01 (`compose-bom-alpha`) | 2026.09.00 | NiA pins the alpha BOM to get Material 3 adaptive and Navigation 3 integrations early |
| Lifecycle | 2.10.0 | 2.11.0 | lags |
| Navigation 3 | 1.2.0 | 1.2.0 | same; NiA has fully moved to Navigation 3 (`NavKey`, `EntryProviderScope`) |
| Room | 2.8.3 | 2.8.5 | lags |
| WorkManager | 2.10.0 | 2.12.0 | lags |
| DataStore | 1.2.0 | 1.2.1 | lags |
| Hilt | 2.59 | not pinned | resolve from the Dagger release page |
| KSP | 2.3.4 | not pinned | KSP2 versioning (no Kotlin prefix) |
| Robolectric | 4.16 | not pinned | |
| Roborazzi | 1.56.0 | not pinned | |
| Protobuf / plugin | 4.29.2 / 0.9.6 | not pinned | |
| Spotless / ktlint | 8.3.0 / 1.4.0 | not pinned | |
| dependency-guard | 0.5.0 | not pinned | |
| compileSdk / targetSdk / minSdk | 37 / 36 / 24 | 37 / 36 / product decision | matches the policy row in `data/versions.json` |
| JDK for build | 17 (settings check), CI uses 21 | 17 | |

Summary: NiA lags this repository on every pinned AndroidX version by a few weeks to months, and leads on build-system practice (isolated projects, configuration cache enforced as `problems=fail`, KSP project isolation). Use its structure, not its numbers.

`gradle.properties` is worth reading in full: `org.gradle.configuration-cache=true`, `org.gradle.configuration-cache.problems=fail`, `org.gradle.isolated-projects=true`, `org.gradle.caching=true`, `ksp.project.isolation.enabled=true`, `android.defaults.buildfeatures.resvalues=false`, `roborazzi.test.verify=true`.

## Techniques worth adopting

### 1. Convention plugins in an included build, with shared helpers

Every module's `build.gradle.kts` is five to fifteen lines because `build-logic/convention` holds one `Plugin<Project>` per concern and a handful of `internal fun Project.configureX(...)` helpers (`configureKotlinAndroid`, `configureAndroidCompose`, `configureJacoco`, `configureGradleManagedDevices`, `configureSpotless...`). A `RootPlugin` applied only to `:` sets up repository-wide tasks. The plugin ids are declared once in the version catalog under `[plugins]` and referenced from `build-logic/convention/build.gradle.kts` with `libs.plugins.<alias>.get().pluginId`, so renaming an id touches one file. `validatePlugins { enableStricterValidation = true; failOnWarning = true }` is turned on for the build-logic project itself and CI runs `:build-logic:convention:check`.

Original illustration (the full version with two plugins and the helper is in `patterns/clean-architecture.md`):

```kotlin
// build-logic/convention/src/main/kotlin/com/example/app/buildlogic/KotlinAndroid.kt
internal fun Project.configureKotlinAndroid(extension: CommonExtension) {
    extension.compileSdk = 37
    extension.defaultConfig.minSdk = 26
    extension.compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    configure<KotlinAndroidProjectExtension> {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
            allWarningsAsErrors.set(providers.gradleProperty("warningsAsErrors").map(String::toBoolean).orElse(false))
        }
    }
}
```

### 2. Feature modules split into `:feature:x:api` and `:feature:x:impl`

The `api` module contains only the `@Serializable` navigation key (a Navigation 3 `NavKey`) and depends on `:core:navigation`; the `impl` module holds the screen, ViewModel and the `EntryProviderScope<NavKey>.xEntry(navigator)` function. Features depend on each other's `api` only, so `:feature:bookmarks:impl` can navigate to a topic through `:feature:topic:api` without compiling against the topic screen. Two convention plugins (`AndroidFeatureApiConventionPlugin`, `AndroidFeatureImplConventionPlugin`) encode the dependencies each side is allowed to have.

```kotlin
// feature/orders/api: the only public surface of the feature
@Serializable data class OrderDetailKey(val orderId: String) : NavKey

// feature/orders/impl: registered by :app into the entry provider
fun EntryProviderScope<NavKey>.orderDetailEntry(onBack: () -> Unit) {
    entry<OrderDetailKey> { key -> OrderDetailRoute(orderId = key.orderId, onBack = onBack) }
}
```

### 3. A `:core:*` taxonomy with one responsibility per module

`common` (dispatchers, result helpers), `model` (pure Kotlin domain types), `data` (repository interfaces and offline-first implementations), `database` (Room), `datastore-proto` (only `.proto` files and generated classes), `datastore` (the `DataStore<UserPreferences>` wrapper), `network` (Retrofit, `demo` flavor JSON), `domain` (use cases that combine repositories), `designsystem` (theme and component wrappers, no app knowledge), `ui` (app-aware composables and preview parameter providers), `analytics`, `notifications`, `navigation`, `testing`, `data-test`, `datastore-test`, `screenshot-testing`. The split between `designsystem` (depends on nothing in the app) and `ui` (depends on `model` and `designsystem`) is the one most projects get wrong.

### 4. Offline-first sync with `Synchronizer` / `Syncable` and change-list versions

Each repository that mirrors a remote implements `Syncable.syncWith(synchronizer)`; a generic `changeListSync` helper reads the last-seen version from DataStore, fetches `/changelist?after=version`, partitions deletes from updates, applies both to Room, then stores the newest version. A `SyncWorker` (`@HiltWorker` `CoroutineWorker`) is the `Synchronizer`, runs repositories in parallel with `async`/`awaitAll`, and returns `Result.retry()` when any fails. `SyncManager.isSyncing` is a `Flow<Boolean>` derived from `WorkManager.getWorkInfosForUniqueWorkFlow`. Re-implemented as `capabilities/offline-first-sync/README.md`.

### 5. Proto DataStore in its own JVM module

`:core:datastore-proto` applies only `jvm.library` and the protobuf plugin, generating lite Java and Kotlin classes; `:core:datastore` is the Android module that owns the `Serializer`, the `DataMigration`s (`IntToStringIdsMigration`, `ListToMapMigration`, each guarded by a `has_done_x_migration` bool in the proto) and a data source exposing `Flow<UserData>`. `map<string, bool>` is used as a set because proto3 has no set type. Re-implemented as `capabilities/datastore-proto/README.md`.

### 6. Design system module plus a catalog app

`:core:designsystem` exposes `NiaTheme(darkTheme, androidTheme, disableDynamicTheming)` with explicit light/dark schemes and dynamic color on API 31+, `NiaIcons` as a single object over Material icons, thin wrappers (`NiaButton`, `NiaOutlinedButton`, `NiaFilterChip`, `NiaTopAppBar`, `NiaNavigationBar`) that pin colors and paddings, and `ThemePreviews` / `DevicePreviews` multipreview annotations. `:app-nia-catalog` is a second application module that renders every component in a `LazyColumn` with `FlowRow`s for manual review. Re-implemented as `capabilities/design-system-module/README.md`.

### 7. A custom lint module that enforces the design system

`:lint` is a plain JVM module with `com.android.tools.lint:lint-api` as `compileOnly`, an `IssueRegistry` registered through `META-INF/services`, a `DesignSystemDetector` mapping Material call names to the wrapper names (`Button` -> `NiaButton`), a `TestMethodNameDetector` (no `test` prefix, `given_when_then` for instrumented tests) and `TestLintTask`-based unit tests. The design system module publishes it with `lintPublish(projects.lint)` so every consumer gets the checks. Written up in `checklists/code-quality.md`.

### 8. Test doubles as modules and `@TestInstallIn`

`:core:testing` ships `Test*Repository` classes backed by `MutableSharedFlow(replay = 1)` with `send*` methods, a `MainDispatcherRule`, a `TestDispatcherModule`, and a custom `AndroidJUnitRunner` that swaps in `HiltTestApplication`. `:core:data-test` ships a `TestDataModule` annotated `@TestInstallIn(replaces = [DataModule::class])` binding fakes, so instrumented tests get a fully fake data layer without per-test modules. Written up in `patterns/testing/unit-testing.md`.

### 9. Roborazzi screenshot tests with accessibility checks

A `:core:screenshot-testing` module wraps Roborazzi in `captureMultiDevice(name) { }` and `captureForDevice(...)` helpers that set Robolectric qualifiers per device spec, provide `LocalInspectionMode`, wrap content in `DeviceConfigurationOverride.DarkMode`, run the Accessibility Test Framework checks and only then capture. Tests are plain `@RunWith(RobolectricTestRunner::class) @GraphicsMode(NATIVE) @LooperMode(PAUSED)` classes. CI runs `verifyRoborazziDemoDebug` and, on failure in a PR, re-records and commits. Written up in `patterns/testing/unit-testing.md`.

### 10. Compose compiler configuration

`compose_compiler_config.conf` at the root lists `com.google.samples.apps.nowinandroid.core.model.data.*`, `java.time.ZoneId` and `java.time.ZoneOffset` as stable so the model module does not need the Compose plugin; `configureAndroidCompose` wires `stabilityConfigurationFiles`, and `metricsDestination` / `reportsDestination` only when `-PenableComposeCompilerMetrics=true` / `-PenableComposeCompilerReports=true` are passed. Written up in `docs/compose/performance.md`.

### 11. CI techniques

`Build.yaml` copies a CI-specific `gradle.properties` (daemon off, 3 workers, configuration cache on, incremental compilation off), uses `gradle/actions/setup-gradle@v4` with an encrypted cache key, runs `:build-logic:convention:check`, `spotlessCheck`, `dependencyGuard`, Roborazzi verify, unit tests, `:app:assemble`, lint with SARIF upload to code scanning, and `checkProdReleaseBadging`. A separate nightly workflow generates baseline profiles on a Gradle-managed device. Adopted conservatively in `templates/ci-cd/github-actions-android.yml`.

### 12. Jacoco combined coverage task

`configureJacoco` registers `create<Variant>CombinedCoverageReport` per variant, collecting `.exec` from unit tests and `.ec` from instrumented tests, excluding `R`, `BuildConfig`, `Manifest` and Hilt-generated classes, and only enabling coverage on the `debug` build type. Described in `patterns/clean-architecture.md`.

## Techniques not to copy

- `DelegatingWorker` plus `HiltWorkerFactoryEntryPoint`. NiA routes every WorkManager request through a generic worker that looks up a `HiltWorkerFactory` from an entry point, so a library module can define workers without the app module configuring `WorkManager`. In an app you own, configuring `Configuration.Provider` once in `Application` (as `capabilities/work-manager/README.md` does) is simpler and debuggable from `adb shell dumpsys jobscheduler`. Use the delegating pattern only when the worker lives in a library you cannot make the app configure.
- `Log.e` and swallow in `NiaPreferencesDataSource.set*`. The data source catches `IOException` from `updateData` and logs it. This repository's rule is to surface failures (`Result`-style or rethrow); copying the swallow hides a full disk from the user.
- Flavors (`demo`/`prod`) with a JSON-backed `demo` network. It exists so the sample runs without a backend. Real apps use a staging server or MockWebServer in tests; a permanent fake flavor doubles the test matrix.
- `compose-bom-alpha` and alpha/rc versions of lifecycle, test, tracing and Material 3 adaptive artifacts. NiA is a showcase and tracks previews; pick stable versions from `data/versions.json`.
- `-Xconsistent-data-class-copy-visibility` and `-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi` as global compiler arguments. The first is a temporary migration flag; the second hides where experimental APIs are used. Opt in per file.
- `MutableSharedFlow(replay = 1, onBufferOverflow = DROP_OLDEST)` as the backing store for test repositories. It works, but a `MutableStateFlow` with `update {}` (as in `patterns/mvvm.md`) is simpler and gives `value` for assertions.
- The `LocalSnackbarHostState` composition local defined inside a feature's entry file (the sample itself marks it with a TODO). Pass `onShowSnackbar` as a lambda from `:app`.
- `UnconfinedTestDispatcher` as the default in `MainDispatcherRule`. This repository defaults to `StandardTestDispatcher` so ordering bugs show up; see `patterns/testing/unit-testing.md`.
- Resource prefix derived from the module path in `AndroidLibraryConventionPlugin` and the graph-generating `RootPlugin` tasks. Nice for a 35-module sample; noise for most apps.
- Firebase Performance and Crashlytics convention plugins. Only when the product uses Firebase; `capabilities/crash-reporting/README.md` covers the choice.
- Kokoro and `build_android_release.sh`. Google-internal CI; irrelevant.

## Technique to repository file map

| Technique | File in this repository |
|---|---|
| Convention plugins, `configureKotlinAndroid`, `RootPlugin`, Jacoco and lint conventions | `patterns/clean-architecture.md` (section "Build logic the Now in Android way") |
| `:feature:x:api` / `:feature:x:impl` split | `patterns/clean-architecture.md` (section "Feature api and impl modules") |
| `:core:*` module taxonomy | `patterns/clean-architecture.md` (section "A core module taxonomy") |
| Proto DataStore, serializer, migrations | `capabilities/datastore-proto/README.md` |
| `Synchronizer` / `Syncable`, change-list sync, `SyncWorker`, `SyncManager` | `capabilities/offline-first-sync/README.md` |
| Design system module, theme, icons, wrappers, catalog app, multipreviews | `capabilities/design-system-module/README.md` |
| Compose compiler stability file, strong skipping, metrics task | `docs/compose/performance.md` (section "Stability configuration and compiler reports in a multi-module project") |
| `:core:testing`, `:core:data-test`, `@TestInstallIn`, Roborazzi via Robolectric | `patterns/testing/unit-testing.md` (sections "Test doubles as Gradle modules" and "Screenshot tests with Roborazzi under Robolectric") |
| CI: Gradle cache, spotless, config cache flags, baseline profile job | `templates/ci-cd/github-actions-android.yml` |
| Spotless/ktlint, custom lint module, dependency-guard, API surface | `checklists/code-quality.md` |

## Attribution

Sample: Now in Android, https://github.com/android/nowinandroid, Copyright The Android Open Source Project, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). This document describes techniques observed in that sample. All Kotlin, Gradle, proto and YAML in this repository that teaches those techniques is an original re-implementation written for the `com.example.app` placeholder project; where a short idiom is reproduced it is marked inline with a comment naming the sample and the license.
