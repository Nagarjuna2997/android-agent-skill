# Patterns

Architecture and UI patterns for modern Android apps written in Kotlin with Jetpack Compose and Material 3. Each file is self-contained, ends with a Verify section listing the commands that prove the pattern works, and links only to files that exist in this repository. Versions cited match `data/versions.json`.

Start with `mvvm.md`; everything else builds on it.

## Architecture

| File | When to use it | Summary |
|---|---|---|
| [mvvm.md](mvvm.md) | Every screen, by default | ViewModel exposing one `StateFlow<UiState>`, Compose screen collecting with `collectAsStateWithLifecycle()`, complete TodoItem example with fake repository, previews and Turbine tests |
| [unidirectional-data-flow.md](unidirectional-data-flow.md) | Screens with many interacting inputs or complex transitions | MVI-style sealed intents, sealed results and a pure reducer; when it beats plain MVVM and when it is overhead |
| [clean-architecture.md](clean-architecture.md) | Multi-module apps, teams, slow builds | `:app`, `:core:*`, `:feature:*`, `:data:*`, `:domain` layout, use cases that earn their place, layer mapping, Gradle convention plugins, when not to split |
| [repository.md](repository.md) | Any data that is read more than once or edited offline | Room as single source of truth, remote source writes into Room, pending-flag sync with WorkManager, error mapping at the boundary |
| [dependency-injection.md](dependency-injection.md) | Every app beyond a prototype | Hilt end to end (modules, qualifiers, scopes, `hiltViewModel()`, `@HiltAndroidTest`, `@TestInstallIn`), Koin equivalents, manual DI for tiny apps |
| [navigation.md](navigation.md) | Any app with more than one screen | Navigation Compose 2.10.2 with `@Serializable` routes, nested graphs, deep links, bottom navigation, back handling; Navigation 3 1.2.0 with a back stack you own; how to choose |
| [error-handling.md](error-handling.md) | Every repository and ViewModel | Sealed `Result` and `AppError`, exception mapping at the repository, `CancellationException` rules, retry with backoff, user-facing error state, logging without PII |

## UI

| File | When to use it | Summary |
|---|---|---|
| [ui/compose-state.md](ui/compose-state.md) | Before writing any non-trivial composable | State hoisting, stateless vs stateful, `remember`/`rememberSaveable`, `derivedStateOf`, stability and `@Immutable`/`@Stable`, lambdas, snapshot collections, lazy list keys, custom `Saver`/`rememberSerializable`, `rememberXState` holders, `LazyListState` effects |
| [ui/material3-theming.md](ui/material3-theming.md) | Setting up or changing the app theme | `MaterialTheme` with color scheme, dynamic color, typography, shapes, dark theme, custom tokens via `CompositionLocal`, contrast-level schemes, a fully custom design system, Material 3 Expressive notes |
| [ui/adaptive-layouts.md](ui/adaptive-layouts.md) | Any app shipping to tablets, foldables or ChromeOS | `WindowSizeClass` from window 1.5.1, `ListDetailPaneScaffold`, `NavigationSuiteScaffold` and choosing the suite yourself, the `isExpandedScreen` two-pane shell, multi-form-factor module layout, foldable posture, orientation and configuration changes |
| [ui/accessibility.md](ui/accessibility.md) | Every screen before it ships | Semantics, `contentDescription`, merging, custom actions and click labels, custom semantics keys for tests, 48 dp targets, font scaling, reduced motion, contrast, testing with the semantics tree and Accessibility Scanner |
| [ui/animation.md](ui/animation.md) | Any motion beyond Material defaults | `animate*AsState`, `AnimatedVisibility`, `AnimatedContent`, `updateTransition`, shared elements and bounds, animated custom drawing, keyboard-aware input, `MotionScheme`, respecting reduced motion |

## Testing

| File | When to use it | Summary |
|---|---|---|
| [testing/unit-testing.md](testing/unit-testing.md) | ViewModels, repositories, use cases | JUnit 4 vs 5, fakes over MockK, `runTest` and `MainDispatcherRule`, Turbine, repository tests with in-memory Room under Robolectric |
| [testing/compose-ui-testing.md](testing/compose-ui-testing.md) | Screen rendering and interaction | `createComposeRule`/`createAndroidComposeRule`, finders, actions, assertions, `testTag`, synchronization and clock control, navigation and Hilt in UI tests |
| [testing/screenshot-testing.md](testing/screenshot-testing.md) | Visual regression on reviewed designs | Compose Preview Screenshot Testing plugin, generating and validating references, CI, what it does and does not prove |

## Related

- Checklists for release-time verification: [../checklists/](../checklists/)
- Toolchain versions: `../data/versions.json`
