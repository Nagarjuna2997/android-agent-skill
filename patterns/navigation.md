# Navigation: Navigation Compose 2.10.2 and Navigation 3 1.2.0

Two official libraries exist. Navigation Compose (`androidx.navigation:navigation-compose:2.10.2`) is the mature `NavHost`-based library with type-safe routes since 2.8. Navigation 3 (`androidx.navigation3:navigation3-ui:1.2.0`) is the newer library where the back stack is a plain list you own. This file covers both and ends with how to choose.

## Navigation Compose with type-safe routes

### Setup

```kotlin
plugins {
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.20"
}
dependencies {
    implementation("androidx.navigation:navigation-compose:2.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-core:<version>")
    implementation("androidx.hilt:hilt-navigation-compose:1.4.0")
}
```

### Routes as serializable types

Every destination is a `@Serializable` class or object. Arguments are constructor fields. No string templates, no `NavType` tables.

```kotlin
package com.example.app.navigation

import kotlinx.serialization.Serializable

@Serializable data object Home
@Serializable data object Search
@Serializable data object Profile

@Serializable data class TodoDetail(val todoId: String)

// A nested graph is also a route; its start destination is a separate route.
@Serializable data object Onboarding
@Serializable data object OnboardingWelcome
@Serializable data object OnboardingPermissions
```

Supported field types out of the box: primitives, `String`, enums, nullable versions of those, and lists/arrays of them. For a custom type (say a `Parcelable` filter) register a `NavType` via `typeMap`, or better, pass an id and look the object up in the repository. Routes should carry identifiers, not payloads.

### NavHost with nested graphs

```kotlin
package com.example.app.navigation

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.navigation
import androidx.navigation.toRoute

@Composable
fun AppNavHost(navController: NavHostController, modifier: Modifier = Modifier) {
    NavHost(navController = navController, startDestination = Home, modifier = modifier) {
        composable<Home> {
            HomeRoute(onOpenTodo = { id -> navController.navigate(TodoDetail(id)) })
        }
        composable<Search> { SearchRoute() }
        composable<Profile> { ProfileRoute() }

        composable<TodoDetail> { backStackEntry ->
            // Read args in the composable, or (preferred) in the ViewModel via SavedStateHandle.
            val route = backStackEntry.toRoute<TodoDetail>()
            TodoDetailRoute(todoId = route.todoId, onBack = { navController.popBackStack() })
        }

        navigation<Onboarding>(startDestination = OnboardingWelcome) {
            composable<OnboardingWelcome> {
                OnboardingWelcomeScreen(onNext = { navController.navigate(OnboardingPermissions) })
            }
            composable<OnboardingPermissions> {
                OnboardingPermissionsScreen(onDone = {
                    navController.navigate(Home) {
                        // Remove the whole onboarding graph so back does not return to it.
                        popUpTo<Onboarding> { inclusive = true }
                    }
                })
            }
        }
    }
}
```

### Reading arguments in the ViewModel

The route fields arrive in `SavedStateHandle`, so the ViewModel does not need the composable to forward them:

```kotlin
@HiltViewModel
class TodoDetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    repository: TodoRepository,
) : ViewModel() {
    private val route = savedStateHandle.toRoute<TodoDetail>()
    val uiState = repository.observe(route.todoId)
        .map { it?.let(DetailUiState::Loaded) ?: DetailUiState.NotFound }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), DetailUiState.Loading)
}
```

`toRoute` on `SavedStateHandle` comes from `androidx.navigation:navigation-common`, which `navigation-compose` pulls in.

### Deep links

```kotlin
composable<TodoDetail>(
    deepLinks = listOf(
        navDeepLink<TodoDetail>(basePath = "https://example.com/todos"),
        // Produces https://example.com/todos/{todoId}
    ),
) { ... }
```

The manifest needs an intent filter and, for `https` links, Android App Links verification via `assetlinks.json` on the domain:

```xml
<activity android:name=".MainActivity" android:exported="true" android:launchMode="singleTask">
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="example.com" android:pathPrefix="/todos" />
    </intent-filter>
</activity>
```

Treat deep link arguments as untrusted input: validate the id format in the ViewModel before querying, and never deep-link into a destination that assumes an authenticated session without checking it. With `singleTask`, a new link while the app is running arrives in `onNewIntent`; call `navController.handleDeepLink(intent)` there.

### Bottom navigation with Scaffold

```kotlin
package com.example.app

import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController

private data class TopLevelDestination(val route: Any, val label: String, val icon: ImageVector)

private val topLevel = listOf(
    TopLevelDestination(Home, "Home", Icons.Filled.Home),
    TopLevelDestination(Search, "Search", Icons.Filled.Search),
    TopLevelDestination(Profile, "Profile", Icons.Filled.Person),
)

@Composable
fun AppScaffold() {
    val navController = rememberNavController()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = backStackEntry?.destination

    Scaffold(
        bottomBar = {
            NavigationBar {
                topLevel.forEach { dest ->
                    val selected = currentDestination?.hierarchy?.any { it.hasRoute(dest.route::class) } == true
                    NavigationBarItem(
                        selected = selected,
                        onClick = {
                            navController.navigate(dest.route) {
                                // Pop to the graph's start so back from any tab exits the app
                                // rather than cycling through tabs; save and restore each tab's stack.
                                popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(dest.icon, contentDescription = null) },
                        label = { Text(dest.label) },
                    )
                }
            }
        },
    ) { innerPadding ->
        // Pass the padding down; the NavHost's screens apply it. Do not apply it twice.
        AppNavHost(navController = navController, modifier = Modifier.padding(innerPadding))
    }
}
```

`hierarchy` is `androidx.navigation.NavDestination.Companion.hierarchy`. Screens inside the NavHost that have their own `Scaffold` with a top bar should receive `innerPadding` and apply only the bottom part, or the content gets double-padded. For large screens, replace `NavigationBar` with `NavigationSuiteScaffold` (see [ui/adaptive-layouts.md](ui/adaptive-layouts.md)).

### Back handling

System back pops the NavHost automatically. Intercept it only for a reason the user would understand (unsaved changes, a modal step):

```kotlin
import androidx.activity.compose.BackHandler

@Composable
fun EditorScreen(hasUnsavedChanges: Boolean, onDiscard: () -> Unit) {
    var showDiscardDialog by rememberSaveable { mutableStateOf(false) }
    BackHandler(enabled = hasUnsavedChanges) { showDiscardDialog = true }
    ...
}
```

Android 16+ enforces predictive back; make sure every `BackHandler` is `enabled` only when it actually intercepts, otherwise the system cannot preview the previous screen. `PredictiveBackHandler` from `androidx.activity:activity-compose` gives progress events if you want to animate the gesture.

### Results back to a previous screen

Use the previous entry's `SavedStateHandle`:

```kotlin
// In the picker:
navController.previousBackStackEntry?.savedStateHandle?.set("picked_color", color.name)
navController.popBackStack()

// In the caller:
val picked = backStackEntry.savedStateHandle.getStateFlow<String?>("picked_color", null)
    .collectAsStateWithLifecycle()
```

For anything more than a trivial value, write the result to a repository and let the caller observe it. The back stack is not a message bus.

## Navigation 3

Navigation 3 inverts the model: you own the back stack as a `SnapshotStateList<NavKey>`, and `NavDisplay` renders the top of it. There is no `NavController`, no graph, and no hidden state.

```kotlin
dependencies {
    implementation("androidx.navigation3:navigation3-runtime:1.2.0")
    implementation("androidx.navigation3:navigation3-ui:1.2.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-navigation3:2.11.0")
    implementation("androidx.hilt:hilt-navigation-compose:1.4.0")
}
```

```kotlin
package com.example.app.nav3

import androidx.compose.runtime.Composable
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.mutableStateListOf
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.entry
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.runtime.rememberSavedStateNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import kotlinx.serialization.Serializable

@Serializable data object HomeKey : NavKey
@Serializable data class TodoDetailKey(val todoId: String) : NavKey

@Composable
fun App() {
    // rememberNavBackStack saves the list across config change and process death
    // because every key is @Serializable.
    val backStack = rememberNavBackStack(HomeKey)

    NavDisplay(
        backStack = backStack,
        onBack = { backStack.removeLastOrNull() },
        entryDecorators = listOf(
            rememberSavedStateNavEntryDecorator(),      // rememberSaveable per entry
            rememberViewModelStoreNavEntryDecorator(),  // a ViewModelStore per entry
        ),
        entryProvider = entryProvider {
            entry<HomeKey> {
                HomeRoute(onOpenTodo = { id -> backStack.add(TodoDetailKey(id)) })
            }
            entry<TodoDetailKey> { key ->
                TodoDetailRoute(todoId = key.todoId, onBack = { backStack.removeLastOrNull() })
            }
        },
    )
}
```

Because the back stack is a list, "pop to home" is `backStack.retainAll(listOf(HomeKey))` or `backStack.clear(); backStack.add(HomeKey)`. Conditional flows (login gating) are a `when` on state that rewrites the list. Tabs are several lists, one per tab, and you swap which one you hand to `NavDisplay`.

`hiltViewModel()` works inside an `entry` block because the ViewModelStore decorator provides a store per entry; `SavedStateHandle` receives nothing automatically in Navigation 3, so pass the key's fields in via the composable or an assisted factory.

Navigation 3 also supports showing more than one entry at a time (list-detail on a tablet) through `Scene` strategies; `ListDetailSceneStrategy` lives in `androidx.compose.material3.adaptive:adaptive-navigation3`.

## Choosing

| | Navigation Compose 2.10.2 | Navigation 3 1.2.0 |
|---|---|---|
| Back stack | Owned by `NavController`, observed indirectly | A `List<NavKey>` you own and mutate |
| Deep links | Built in (`navDeepLink`) | You parse the intent and build the list |
| Nested graphs | `navigation<>()` builder | Just more keys; group by convention |
| Multi-pane (list-detail) | Via `ListDetailPaneScaffold` alongside the NavHost | First-class through scenes |
| Arguments to ViewModel | `SavedStateHandle.toRoute()` | Pass from the key manually |
| Maturity | Stable since 2018; type-safe since 2.8 | Stable 1.0 in 2025; API surface still growing |
| Views interop | Full | Compose only |

Pick Navigation Compose when the app needs deep links, bottom tabs with saved state, or interop with Fragments, or when the team already knows it. Pick Navigation 3 for a new Compose-only app whose navigation is state-driven (role-based flows, adaptive multi-pane, complex conditional stacks) and where owning the back stack as data simplifies testing. Do not mix both in one app.

## Avoid

```kotlin
// Anti-pattern: string routes with manual argument templates.
composable("todo/{id}", arguments = listOf(navArgument("id") { type = NavType.StringType }))

// Anti-pattern: passing the NavController into ViewModels or deep into screens.
class TodoViewModel(private val navController: NavController)

// Anti-pattern: navigating from a SharedFlow collector; events are lost if emitted while paused.
viewModel.navigationEvents.collect { navController.navigate(it) }

// Anti-pattern: putting a large object (bitmap, full model) in a route.
@Serializable data class Detail(val todo: TodoItem)

// Anti-pattern: BackHandler always enabled; breaks predictive back preview.
BackHandler { ... }
```

## Verify

```sh
./gradlew :app:assembleDebug
# Deep link from the shell:
adb shell am start -a android.intent.action.VIEW -d "https://example.com/todos/abc" com.example.app
# App Links verification state:
adb shell pm get-app-links com.example.app
```

Add a UI test that navigates Home -> Detail -> back and asserts the Home content is shown again; see [testing/compose-ui-testing.md](testing/compose-ui-testing.md).

## Sources

- https://developer.android.com/guide/navigation
- https://developer.android.com/guide/navigation/design/type-safety
- https://developer.android.com/guide/navigation/design/nested-graphs
- https://developer.android.com/guide/navigation/design/deep-link
- https://developer.android.com/guide/navigation/navigation-3
- https://developer.android.com/jetpack/androidx/releases/navigation
- https://developer.android.com/jetpack/androidx/releases/navigation3
- https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture
- https://developer.android.com/training/app-links
