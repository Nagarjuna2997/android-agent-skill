# Reference study: Architecture Samples (android/architecture-samples)

What the official "Android Architecture Blueprints" to-do app teaches about ViewModel state and testing, what has aged, and where each adopted technique now lives in this repository. The code in this repository is an original re-implementation; nothing here is copied from the sample.

## What the sample is

Architecture Samples is a single-module to-do app (tasks list, task detail, add/edit, statistics) written to show the recommended app architecture at small scale: Hilt, Room as the single source of truth, a fake in-memory "network", one `UiState` per screen built by combining flows in the ViewModel, Navigation Compose with string routes, and a `shared-test` module whose fakes serve both JVM unit tests and instrumented tests. The main branch is Compose + Hilt; older branches show the same app with Views, Dagger, RxJava and other stacks.

Checkout studied: shallow clone at `/tmp/samples/architecture-samples`, last commit dated 2025-07-17.

## Toolchain it is on right now

From `gradle/libs.versions.toml`, compared with `data/versions.json` (verified 2026-09-29):

| Component | Sample | This repo | Note |
|---|---|---|---|
| AGP | 8.7.3 | 9.4.0 | lags by a major version |
| Kotlin | 2.1.10 | 2.4.20 | lags |
| Compose BOM | 2024.12.01 | 2026.09.00 | lags by almost two years |
| Lifecycle | 2.8.7 | 2.11.0 | lags |
| Navigation | 2.8.5 (string routes, `navArgument`) | 2.10.2 type-safe routes | lags, and uses the pre-serialization route style |
| Room | 2.6.1 | 2.8.5 | lags |
| Hilt | 2.53.1 | not pinned | |
| Turbine | 0.12.1 | not pinned | lags; the sample does not actually use Turbine in its ViewModel tests |
| Accompanist | 0.36.0 (`SwipeRefresh`) | not used | deprecated in favor of `PullToRefreshBox` in Material 3 |
| compileSdk / targetSdk / minSdk | 35 / 35 / 21 | 37 / 36 / product decision | lags the Play policy row in `data/versions.json` (36 for new apps and updates since 2026-08-31) |
| JDK | 17 | 17 | |

Summary: the sample is a year or more behind on every library and is not actively tracking releases (renovate is configured but the lockstep is loose). Its value is the shape of the ViewModel and the test setup, not its dependency list or its navigation code.

## Techniques worth adopting

### 1. One `UiState` built by `combine` in the ViewModel, with an `Async` wrapper for the slow source

`TasksViewModel` keeps four private flows (`savedStateHandle.getStateFlow` for the filter, `MutableStateFlow` for `isLoading` and `userMessage`, and the repository stream mapped through `Async.Success`/`Async.Error` with `.catch`) and combines them into one `StateFlow<TasksUiState>` with `stateIn`. The `Async<T>` sealed class (`Loading`, `Error(messageRes)`, `Success(data)`) is applied only to the source that can fail or be slow; UI-local flags stay plain. This matches this repository's rule of a single immutable state exposed through `StateFlow`, and the comparison with our nested `Content` sealed interface is written up in `patterns/mvvm.md`.

```kotlin
// Original illustration; the sample's equivalent is TasksViewModel.uiState
val uiState: StateFlow<OrdersUiState> = combine(ordersAsync, filter, isRefreshing, userMessage) { async, f, refreshing, msg ->
    when (async) {
        Async.Loading -> OrdersUiState(isLoading = true, filter = f)
        is Async.Error -> OrdersUiState(filter = f, userMessage = async.message)
        is Async.Success -> OrdersUiState(orders = async.data, filter = f, isRefreshing = refreshing, userMessage = msg)
    }
}.stateIn(viewModelScope, WhileUiSubscribed, OrdersUiState(isLoading = true))
```

### 2. `WhileUiSubscribed` as a named `SharingStarted`

A single top-level `val WhileUiSubscribed: SharingStarted = SharingStarted.WhileSubscribed(5_000)` with a doc comment explaining the five-second grace period for configuration changes. Every ViewModel uses the constant, so the policy is reviewable in one place. Adopted in `patterns/mvvm.md`.

### 3. One-off messages as nullable state consumed by the screen

`userMessage: Int?` (a string resource id) lives in `UiState`; the screen shows it in a `LaunchedEffect(snackbarHostState, viewModel, message, snackbarText)` and then calls `viewModel.snackbarMessageShown()` to clear it. The same mechanism carries results across navigation: a destination's `userMessage` navigation argument is read on the tasks screen, handed to the ViewModel through `showEditResultMessage`, and the argument is zeroed with `entry.arguments?.putInt(USER_MESSAGE_ARG, 0)` so rotation does not replay it. This repository already teaches the state-based approach with an id-stamped `UserMessage`; the comparison in `patterns/mvvm.md` explains why the id matters when the same message can occur twice.

### 4. A `shared-test` module used by both `test` and `androidTest`

`:shared-test` is a regular Android library whose `main` source set holds `FakeTaskRepository`, `FakeTaskDao`, `FakeNetworkDataSource`, `MainCoroutineRule`, a `CustomTestRunner` that installs `HiltTestApplication`, and `@TestInstallIn` modules (`RepositoryTestModule` replaces `RepositoryModule`, `DatabaseTestModule` provides an in-memory Room). `app` depends on it with both `testImplementation` and `androidTestImplementation`. The fake repository exposes `addTasks(vararg)` and `setShouldThrowError(Boolean)` as test-only controls. Adopted in `patterns/testing/compose-ui-testing.md`; the module layout matches the `:core:testing` advice in `patterns/testing/unit-testing.md`.

### 5. Navigation tests through a debug-only `@AndroidEntryPoint` Activity

`app/src/debug/.../HiltTestActivity.kt` is an empty `@AndroidEntryPoint class HiltTestActivity : ComponentActivity()`. Instrumented tests use `createAndroidComposeRule<HiltTestActivity>()`, call `composeTestRule.setContent { AppTheme { AppNavGraph() } }`, drive the real graph by clicking visible text, press back with `Espresso.pressBack()` and assert on visible content rather than on `NavController` state. Repository state is seeded through an `@Inject lateinit var taskRepository` after `hiltRule.inject()`. Adopted in `patterns/testing/compose-ui-testing.md`, next to the `TestNavHostController` approach the file already had.

### 6. `MainCoroutineRule` with a per-test override

`MainCoroutineRule` defaults to `UnconfinedTestDispatcher`, and the one test that needs to observe an intermediate `isLoading = true` calls `Dispatchers.setMain(StandardTestDispatcher())` at its start, then `advanceUntilIdle()`. This repository defaults the other way (`StandardTestDispatcher`, see `patterns/testing/unit-testing.md`), but the "override the rule for one test" trick is worth knowing and is noted in `patterns/testing/compose-ui-testing.md`.

### 7. `@ApplicationScope` for fire-and-forget repository work

`DefaultTaskRepository` takes `@ApplicationScope CoroutineScope` (a `SupervisorJob` on `Dispatchers.Default`, provided as a `@Singleton`) and uses it for `saveTasksToNetwork()`, so a write to the network outlives the ViewModel that triggered it without `GlobalScope`. The same qualifier is used in `capabilities/offline-first-sync/README.md` and matches the "never `GlobalScope`" rule in `patterns/mvvm.md`.

### 8. Read-only `StateFlow` of the fake's internals for assertions

`FakeTaskRepository.savedTasks: StateFlow<LinkedHashMap<String, Task>>` lets a test assert on repository contents (`repository.savedTasks.value["1"]?.isCompleted`) instead of re-querying through the interface. Cheap, and avoids mocks entirely.

## Techniques not to copy

- String routes with `navArgument`, `NavType` and `"$TASK_DETAIL_SCREEN/{$TASK_ID_ARG}"` templates, plus the `TodoNavigationActions` wrapper. Navigation 2.8 introduced `@Serializable` routes and `composable<Route>`; this repository teaches those (`patterns/navigation.md`). The `userMessage` integer passed as a route argument with `Activity.RESULT_FIRST_USER + n` constants is a Views-era idiom; carry results in the state of a shared ViewModel or a `SavedStateHandle` entry on the previous back stack entry.
- Accompanist `SwipeRefresh` in `LoadingContent`. Deprecated; Material 3 1.4.0 has `PullToRefreshBox`.
- `InstantTaskExecutorRule` in Compose tests. It is for `LiveData`; the sample keeps it for historical reasons. Remove it in Compose-only code.
- `UnconfinedTestDispatcher` as the rule default (see technique 6).
- `userMessage: Int?` (resource id) in `UiState`. It forces the ViewModel to know `R.string`, which stops `:domain`-style modules from being pure Kotlin and makes messages untestable without resources. Prefer a sealed `UserMessage` or a plain `String` resolved by the UI layer; `patterns/mvvm.md` shows the trade-off.
- `FakeTaskDao.observeAll()` throwing `TODO()`. A fake that throws for part of its interface is a partial fake; a `MutableStateFlow`-backed implementation costs five more lines.
- `Exception("Task list is null")` and `throw Exception(...)` for domain failures. This repository's error handling uses typed errors (`patterns/error-handling.md`).
- `isLoading` driven manually (`_isLoading.value = true` ... `false` around `refresh()`). Works, but a `MutableStateFlow<Boolean>` toggled by hand drifts when `refresh()` throws; wrap the refresh in a `Result` and derive loading from it, or use `PullToRefreshState`.
- `savedStateHandle[TASK_ID_ARG]!!` for a navigation argument. Use `savedStateHandle.toRoute<TaskDetailRoute>()` with a serializable route.
- `minSdk 21`, `targetSdk 35`. Below the Play policy in `data/versions.json` for new apps.
- The `statistics` utilities with `ArrayList` and manual loops where `partition` and `count` express intent; style only, but do not copy the loop style.

## Technique to repository file map

| Technique | File in this repository |
|---|---|
| `UiState` via `combine`, `Async` wrapper, `WhileUiSubscribed`, one-off `userMessage` | `patterns/mvvm.md` (section "Comparison with Architecture Samples") |
| `shared-test` fakes used by `test` and `androidTest`, `MainCoroutineRule` override | `patterns/testing/compose-ui-testing.md` (section "Architecture Samples style: a fake repository shared with instrumented tests") |
| Navigation tests through a debug-only Hilt Activity and the real graph | `patterns/testing/compose-ui-testing.md` (same section, "Navigation tests through the real graph") |
| `@TestInstallIn` replacing repository and database modules | `patterns/testing/unit-testing.md` (section "Test doubles as Gradle modules") |
| `@ApplicationScope` coroutine scope | `capabilities/offline-first-sync/README.md`, `patterns/mvvm.md` |

## Attribution

Sample: Android Architecture Samples (Android Architecture Blueprints), https://github.com/android/architecture-samples, Copyright The Android Open Source Project, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). This document describes techniques observed in that sample. All Kotlin in this repository that teaches those techniques is an original re-implementation written for the `com.example.app` placeholder project; where a short idiom is reproduced it is marked inline with a comment naming the sample and the license.
