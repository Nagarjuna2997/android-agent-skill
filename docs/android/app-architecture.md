# App architecture

The official recommended Android architecture in one page: a UI layer, an optional domain layer and a data layer, each with a fixed responsibility, plus the module conventions that keep a growing app buildable and the mapping from this repository's `patterns/` files to those layers.

## Principles

1. Separate concerns. Activities and composables are entry points the OS controls; they hold no business logic and no data.
2. Drive UI from data models, not from UI events. The screen shows whatever the model says; events change the model.
3. Single source of truth. Each piece of data is owned by exactly one class (a repository), which is the only writer.
4. Unidirectional data flow. State flows down, events flow up. See `patterns/unidirectional-data-flow.md`.

## Layers

```
UI layer       Composables + ViewModel      (UiState out, events in)
      │
Domain layer   Use cases (optional)         (reusable business rules)
      │
Data layer     Repositories + data sources  (single source of truth)
```

### UI layer

- Screen composables are stateless: they take a `UiState` and lambdas. A route-level composable obtains the ViewModel and collects state with `collectAsStateWithLifecycle()`.
- The ViewModel exposes one immutable `UiState` through a `StateFlow`, holds no `Context`, `Activity` or view reference, and survives configuration changes. See `patterns/mvvm.md`.
- `UiState` is a sealed interface or a data class with explicit loading, empty, content and error representations. See `patterns/ui/compose-state.md`.
- Navigation is a UI concern. The ViewModel exposes "what happened"; the NavHost decides where to go. See `patterns/navigation.md`.
- Theming, adaptive layout and accessibility live here: `patterns/ui/material3-theming.md`, `patterns/ui/adaptive-layouts.md`, `patterns/ui/accessibility.md`.

### Domain layer

Optional. Add a use case when a rule is used by more than one ViewModel, when it combines several repositories, or when it is complex enough to deserve its own test. A use case is a class with a single `suspend operator fun invoke()` or a function returning a `Flow`, with no Android imports.

```kotlin
class GetPinnedNotesUseCase @Inject constructor(
    private val notes: NoteRepository,
    private val settings: SettingsRepository,
) {
    operator fun invoke(): Flow<List<Note>> =
        combine(notes.observeNotes(), settings.observePinned()) { all, pinned -> all.filter { it.id in pinned } }
}
```

Do not add a domain layer that only forwards calls. A ViewModel calling a repository directly is correct when there is no rule in between.

### Data layer

- A repository per data type, behind an interface, exposing `Flow` for observable reads and `suspend` functions for writes and one-shot reads. All functions main-safe. See `patterns/repository.md`.
- Data sources are the only classes that touch Room, DataStore, Retrofit, Ktor or the file system. A repository composes them and decides caching and conflict rules.
- Models: a `Dto` for the network shape, an `Entity` for the database shape, a domain model for everything above. Map at the data layer; nothing above it sees a `Dto`.
- Errors surface as sealed results or exceptions that the ViewModel maps to state. See `patterns/error-handling.md`.
- Offline-first: Room is the source of truth and the network updates Room; the UI observes Room. A `WorkManager` job retries uploads.

### Dependency injection

Constructor injection everywhere. Hilt by default: `@HiltAndroidApp` on the `Application`, `@AndroidEntryPoint` on the Activity, `@HiltViewModel` on ViewModels, `@Module` + `@InstallIn` to bind interfaces. Koin is the alternative when the project already uses it. See `patterns/dependency-injection.md`.

Every interface has a fake implementation used by unit tests and `@Preview`s. Fakes live in `src/main` of a `:core:testing` module or in `src/test` of the owning module, never in production `di` modules.

## Single module layout

Enough for a small app. Feature-first packages, layers inside each feature; see `docs/kotlin/kotlin-style.md` for the tree. The `templates/compose-app/` template uses this layout.

## Multi-module conventions

Split when build times, team size or reuse justify it. The convention below is the one the official samples use and tooling expects.

```
:app                      Application, MainActivity, NavHost, Hilt root. Depends on every feature.
:feature:notes            Screens, ViewModels, UiState for one feature. Depends on :core:*.
:feature:settings
:core:ui                  Shared composables, previews helpers.
:core:designsystem        Theme, colors, typography, components.
:core:data                Repository implementations. Depends on :core:database, :core:network, :core:model.
:core:domain              Use cases (only if present).
:core:database            Room entities, DAOs, database.
:core:network             Retrofit/Ktor API, DTOs.
:core:datastore           Proto or Preferences DataStore.
:core:model               Domain models. No dependencies.
:core:common              Dispatchers qualifiers, Result type.
:core:testing             Fakes, test rules, Hilt test runner.
:build-logic              Convention plugins (`convention.android.library`, `convention.android.compose`).
```

Rules:

- Feature modules never depend on each other. Cross-feature navigation goes through routes defined in `:app` or a `:core:navigation` module.
- `:core:model` and `:core:domain` are pure Kotlin (`org.jetbrains.kotlin.jvm`) so they compile fastest and cannot import Android.
- Each module has its own `namespace`; the application id is set only in `:app`.
- Share versions through the root `gradle/libs.versions.toml`; share build configuration through convention plugins in `build-logic`, not through `subprojects { }` blocks.
- Apply the Compose compiler plugin only to modules with composables.
- `api` dependencies are rare; default to `implementation`.

A convention plugin keeps module build files to a few lines:

```kotlin
// feature/notes/build.gradle.kts
plugins {
    id("convention.android.feature")
    id("convention.android.compose")
}

android { namespace = "com.example.app.feature.notes" }

dependencies {
    implementation(project(":core:data"))
    implementation(project(":core:designsystem"))
}
```

## How this repository's patterns map

| Layer | Concern | Pattern file |
|---|---|---|
| UI | ViewModel, UiState, events | `patterns/mvvm.md`, `patterns/unidirectional-data-flow.md`, `patterns/ui/compose-state.md` |
| UI | Routes, back stack, deep links | `patterns/navigation.md` |
| UI | Theme, adaptive, a11y, motion | `patterns/ui/material3-theming.md`, `patterns/ui/adaptive-layouts.md`, `patterns/ui/accessibility.md`, `patterns/ui/animation.md` |
| Domain | Use cases, module boundaries | `patterns/clean-architecture.md` |
| Data | Repositories, sources, caching | `patterns/repository.md` |
| Data and UI | Failure modeling | `patterns/error-handling.md` |
| All | Wiring | `patterns/dependency-injection.md` |
| All | Tests per layer | `patterns/testing/unit-testing.md`, `patterns/testing/compose-ui-testing.md`, `patterns/testing/screenshot-testing.md` |

`patterns/clean-architecture.md` is the multi-module, use-case-heavy variant of the same recommended architecture, not a different one. Pick it when the app has more than a handful of screens or more than one team.

## What goes where: quick decisions

| Thing | Belongs in |
|---|---|
| Formatting a date for display | UI layer (a `UiModel` mapper in the ViewModel or a composable helper) |
| Deciding whether a note can be deleted | Domain (use case) or the repository if it is a data rule |
| Retry with backoff on network failure | Data layer (repository or data source) |
| Showing a permission rationale | UI layer (composable + ViewModel state); the request itself is a composable side effect |
| Reading a `Context` | Data layer via injected `@ApplicationContext`, never in a ViewModel |
| Choosing between two screens after login | NavHost, driven by ViewModel state |
| Caching the last server response | Repository |
| Parsing JSON | Network data source |

## Verify

Architecture is verified by what the dependency graph allows:

```sh
./gradlew :app:dependencies --configuration debugRuntimeClasspath | grep project
./gradlew :feature:notes:dependencies --configuration debugCompileClasspath | grep "project :feature"   # must be empty
grep -rn "import android\." core/model/src core/domain/src                                               # must be empty
grep -rn "LiveData\|GlobalScope" --include=*.kt app feature core                                        # must be empty
./gradlew :app:testDebugUnitTest
```

A ViewModel unit test that uses only fakes and no Robolectric is the practical proof that the UI layer has no Android dependencies.

## Sources

- https://developer.android.com/topic/architecture
- https://developer.android.com/topic/architecture/ui-layer
- https://developer.android.com/topic/architecture/domain-layer
- https://developer.android.com/topic/architecture/data-layer
- https://developer.android.com/topic/modularization
- https://developer.android.com/topic/modularization/patterns
- https://developer.android.com/training/dependency-injection/hilt-android
