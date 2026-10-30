# Compose UI Testing

Compose UI tests drive the semantics tree: find a node, act on it, assert on it. The same test code runs on the JVM under Robolectric (fast, no device) and on a device or emulator (real rendering, real system behavior). This file covers rules, finders, actions, assertions, synchronization and Hilt integration.

## Setup

```kotlin
// app/build.gradle.kts
dependencies {
    val bom = platform("androidx.compose:compose-bom:2026.09.00")
    androidTestImplementation(bom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")   // provides the test Activity

    testImplementation(bom)
    testImplementation("androidx.compose.ui:ui-test-junit4")
    testImplementation("org.robolectric:robolectric:<version>")

    androidTestImplementation("androidx.test.ext:junit:<version>")
    androidTestImplementation("androidx.test.espresso:espresso-core:<version>")
    androidTestImplementation("androidx.navigation:navigation-testing:2.10.2")
}
```

The test rule is the same class in both source sets; only the runner differs.

## createComposeRule vs createAndroidComposeRule

```kotlin
// Tests a composable in isolation. Uses an empty ComponentActivity from ui-test-manifest.
@get:Rule val composeRule = createComposeRule()

// Launches your real Activity (Hilt, theme, navigation all wired). Use for flows.
@get:Rule val composeRule = createAndroidComposeRule<MainActivity>()
```

With `createComposeRule`, call `composeRule.setContent { }` in the test. With `createAndroidComposeRule<MainActivity>()`, the Activity already set content; you do not call `setContent` again. `composeRule.activity` gives the Activity for string resources: `composeRule.activity.getString(R.string.action_delete)`.

## A screen test

```kotlin
package com.example.app.todo

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)   // real rendering under Robolectric for layout-dependent assertions
class TodoScreenTest {

    @get:Rule val composeRule = createComposeRule()

    private val success = TodoUiState(
        content = TodoUiState.Content.Success(
            listOf(TodoItem("1", "Buy milk", false, java.time.Instant.EPOCH)),
        ),
    )

    @Test
    fun loading_showsProgressIndicator() {
        composeRule.setContent {
            AppTheme { TodoScreen(state = TodoUiState(), onAdd = {}, onToggle = {}, onDelete = {}, onFilterChange = {}, onMessageShown = {}) }
        }
        composeRule.onNodeWithTag("loading").assertIsDisplayed()
    }

    @Test
    fun success_rendersItemsAndTogglesViaCheckbox() {
        var toggled: TodoItem? = null
        composeRule.setContent {
            AppTheme { TodoScreen(state = success, onAdd = {}, onToggle = { toggled = it }, onDelete = {}, onFilterChange = {}, onMessageShown = {}) }
        }
        composeRule.onNodeWithText("Buy milk").assertIsDisplayed()
        composeRule.onNode(hasText("Buy milk")).onChildren().filterToOne(isToggleable()).assertIsOff().performClick()
        assertEquals("1", toggled?.id)
    }

    @Test
    fun add_sendsTrimmedTitle() {
        var added: String? = null
        composeRule.setContent {
            AppTheme { TodoScreen(state = success, onAdd = { added = it }, onToggle = {}, onDelete = {}, onFilterChange = {}, onMessageShown = {}) }
        }
        composeRule.onNodeWithTag("new-item-input").performTextInput("  Walk dog ")
        composeRule.onNodeWithText("Add").performClick()
        assertEquals("  Walk dog ", added)   // trimming is the ViewModel's job; the screen passes raw input
    }

    @Test
    fun error_showsMessage() {
        composeRule.setContent {
            AppTheme { TodoScreen(state = TodoUiState(content = TodoUiState.Content.Error("Offline")), onAdd = {}, onToggle = {}, onDelete = {}, onFilterChange = {}, onMessageShown = {}) }
        }
        composeRule.onNodeWithText("Offline").assertIsDisplayed()
    }
}
```

Testing the stateless screen with a hand-built `UiState` covers every visual state without a ViewModel, a repository or a dispatcher. The callback assertions prove the wiring without a fake.

## Finders

| Finder | Matches |
|---|---|
| `onNodeWithText("x")` | Text or editable text, merged tree. `substring = true`, `ignoreCase = true` available |
| `onNodeWithContentDescription("x")` | contentDescription |
| `onNodeWithTag("x")` | `Modifier.testTag("x")` |
| `onNode(matcher)` | Any `SemanticsMatcher`: `hasText`, `hasClickAction`, `isToggleable`, `hasRole(Role.Button)`, combined with `and`, `or`, `not` |
| `onAllNodesWithText("x")` | A collection; `.assertCountEquals(n)`, `[0]`, `.filterToOne(...)` |
| `.onChildren()`, `.onParent()`, `.onChildAt(i)`, `.onSiblings()` | Tree traversal |

`useUnmergedTree = true` on any finder looks inside merged nodes (a `Button`'s inner `Text`). Default is the merged tree, which is what TalkBack sees and is usually what you want.

Prefer text and content description over `testTag`: they test what the user sees, and they catch a missing accessibility label. Use `testTag` for nodes that have no user-visible text (a progress indicator, a scroll container, an input before any text is typed) and keep tags as constants in one file so tests and production agree.

```kotlin
object TodoTestTags {
    const val LOADING = "loading"
    const val NEW_ITEM_INPUT = "new-item-input"
    const val LIST = "todo-list"
}
```

## Actions

`performClick()`, `performTextInput()`, `performTextClearance()`, `performTextReplacement()`, `performScrollTo()`, `performScrollToIndex(i)` and `performScrollToNode(matcher)` for lazy lists, `performTouchInput { swipeLeft() }`, `performKeyInput { pressKey(Key.Enter) }`, `performSemanticsAction(SemanticsActions.OnClick)`, `performImeAction()`.

Lazy lists compose only visible items; find an off-screen item by scrolling first:

```kotlin
composeRule.onNodeWithTag(TodoTestTags.LIST).performScrollToNode(hasText("Item 80"))
composeRule.onNodeWithText("Item 80").assertIsDisplayed()
```

## Assertions

`assertIsDisplayed()`, `assertIsNotDisplayed()`, `assertExists()`, `assertDoesNotExist()`, `assertIsEnabled()`, `assertIsOn()`/`assertIsOff()`, `assertIsSelected()`, `assertTextEquals("x")`, `assertTextContains("x")`, `assertHasClickAction()`, `assertContentDescriptionEquals("x")`, `assert(matcher)`.

`assertIsDisplayed` checks the node has non-zero size inside the viewport, which needs real layout; under Robolectric that requires `@GraphicsMode(NATIVE)` (the default since Robolectric 4.10). `assertExists` only checks the semantics tree.

When a finder fails, the error prints the whole tree. For exploration, `composeRule.onRoot().printToLog("UI")` dumps it with `useUnmergedTree` variants available.

## Synchronization

The rule waits for the composition to be idle before every finder and action: pending recompositions, `LaunchedEffect`s that have run to a suspension point, and animations driven by the Compose clock. It does not know about:

- Coroutines on `Dispatchers.IO` or a real repository. Use fakes so work completes synchronously, or `waitUntil`:

```kotlin
composeRule.waitUntil(timeoutMillis = 5_000) {
    composeRule.onAllNodesWithText("Buy milk").fetchSemanticsNodes().isNotEmpty()
}
```

- Infinite animations. They keep the clock busy and `waitForIdle` never returns. Control the clock:

```kotlin
composeRule.mainClock.autoAdvance = false
composeRule.onNodeWithText("Expand").performClick()
composeRule.mainClock.advanceTimeBy(300)        // finish a 300 ms transition
composeRule.onNodeWithText("Details").assertIsDisplayed()
```

- Espresso idling resources. For instrumented tests that mix Views and Compose, `createAndroidComposeRule` registers Compose as an idling resource with Espresso automatically.

## Navigation tests

```kotlin
@Test
fun openDetail_thenBack_returnsToList() {
    lateinit var navController: TestNavHostController
    composeRule.setContent {
        navController = TestNavHostController(LocalContext.current).apply {
            navigatorProvider.addNavigator(ComposeNavigator())
        }
        AppTheme { AppNavHost(navController = navController) }
    }
    composeRule.onNodeWithText("Buy milk").performClick()
    assertTrue(navController.currentDestination?.hasRoute<TodoDetail>() == true)
    composeRule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    assertTrue(navController.currentDestination?.hasRoute<Home>() == true)
}
```

`TestNavHostController` is from `androidx.navigation:navigation-testing`. Prefer asserting on visible content ("the list is shown again") over the controller's destination where you can; the destination check is useful when two screens look alike.

## Hilt in UI tests

For end-to-end screen tests through `MainActivity`, replace data modules with fakes using `@TestInstallIn` (full setup in [../dependency-injection.md](../dependency-injection.md)).

```kotlin
@HiltAndroidTest
@RunWith(AndroidJUnit4::class)
class TodoFlowTest {
    @get:Rule(order = 0) val hiltRule = HiltAndroidRule(this)
    @get:Rule(order = 1) val composeRule = createAndroidComposeRule<MainActivity>()

    @Inject lateinit var repository: TodoRepository

    @Before fun inject() = hiltRule.inject()

    @Test
    fun addingAnItemShowsItInTheList() {
        composeRule.onNodeWithTag(TodoTestTags.NEW_ITEM_INPUT).performTextInput("Walk dog")
        composeRule.onNodeWithText("Add").performClick()
        composeRule.onNodeWithText("Walk dog").assertIsDisplayed()
    }
}
```

Rule order matters: Hilt must inject before the Activity launches. These tests live in `androidTest` and run on a device or emulator; Hilt instrumentation under Robolectric works too but needs `@Config(application = HiltTestApplication::class)` and is slower to set up than plain `createComposeRule` tests.

## Architecture Samples style: a fake repository shared with instrumented tests

Google's Architecture Samples to-do app (see [../../references/architecture-samples.md](../../references/architecture-samples.md)) keeps one `shared-test` module whose `main` source set serves both JVM unit tests and instrumented tests: the fake repository, a `MainCoroutineRule`, `@TestInstallIn` modules and a custom runner. That is the single-module-app version of the `:core:testing` / `:core:data-test` split in [unit-testing.md](unit-testing.md). The pieces, re-implemented:

```kotlin
// app/build.gradle.kts
dependencies {
    testImplementation(project(":shared-test"))
    androidTestImplementation(project(":shared-test"))
}
android {
    defaultConfig.testInstrumentationRunner = "com.example.app.testing.AppTestRunner"   // installs HiltTestApplication
}
```

The fake exposes its contents as a read-only `StateFlow` so tests assert on repository state without a second query, a `seed(vararg)` method, and one switch that makes every call fail:

```kotlin
// shared-test/src/main/kotlin/com/example/app/testing/FakeTodoRepository.kt
package com.example.app.testing

import com.example.app.todo.TodoItem
import com.example.app.todo.TodoRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import java.io.IOException
import java.time.Instant
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class FakeTodoRepository @Inject constructor() : TodoRepository {
    private val _saved = MutableStateFlow<Map<String, TodoItem>>(linkedMapOf())
    /** Read-only view for assertions: `repository.saved.value["1"]?.isCompleted`. */
    val saved: StateFlow<Map<String, TodoItem>> = _saved.asStateFlow()

    /** When true every suspend call throws; observeAll keeps emitting the last value. */
    var shouldFail: Boolean = false

    override fun observeAll(): Flow<List<TodoItem>> = saved.map { it.values.toList() }

    override suspend fun add(title: String) {
        failIfRequested()
        val id = UUID.randomUUID().toString()
        _saved.update { it + (id to TodoItem(id, title, false, Instant.EPOCH)) }
    }

    override suspend fun setCompleted(id: String, completed: Boolean) {
        failIfRequested()
        _saved.update { map -> map[id]?.let { map + (id to it.copy(isCompleted = completed)) } ?: map }
    }

    override suspend fun delete(id: String) {
        failIfRequested()
        _saved.update { it - id }
    }

    /** Test-only. */
    fun seed(vararg items: TodoItem) = _saved.update { it + items.associateBy(TodoItem::id) }

    private fun failIfRequested() { if (shouldFail) throw IOException("fake failure") }
}
```

```kotlin
// shared-test/src/main/kotlin/com/example/app/testing/di/TestRepositoryModule.kt
package com.example.app.testing.di

import com.example.app.di.RepositoryModule
import com.example.app.testing.FakeTodoRepository
import com.example.app.todo.TodoRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.components.SingletonComponent
import dagger.hilt.testing.TestInstallIn

@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [RepositoryModule::class])
interface TestRepositoryModule {
    @Binds fun bindTodoRepository(fake: FakeTodoRepository): TodoRepository
}
```

```kotlin
// shared-test/src/main/kotlin/com/example/app/testing/di/TestDatabaseModule.kt
@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [DatabaseModule::class])
object TestDatabaseModule {
    @Provides @Singleton
    fun provideDatabase(@ApplicationContext context: Context): AppDatabase =
        Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).allowMainThreadQueries().build()
}
```

The in-memory database module is for tests that exercise the real repository through the UI; the fake-repository module is for tests of screens and navigation. A test class gets one or the other by which module is on its classpath, so keep them in separate Gradle modules (`:shared-test` and `:shared-test-db`) if both kinds of instrumented tests exist; two `@TestInstallIn` modules replacing different production modules can coexist in one test module, as above.

The sample's `MainCoroutineRule` defaults to `UnconfinedTestDispatcher` and the one test that must observe an intermediate `isLoading = true` overrides it for that test:

```kotlin
@Test
fun refresh_showsLoadingThenData() = runTest {
    Dispatchers.setMain(StandardTestDispatcher())   // override the rule for this test only; the rule's finished() resets it
    viewModel.refresh()
    assertTrue(viewModel.uiState.first().isRefreshing)
    advanceUntilIdle()
    assertFalse(viewModel.uiState.first().isRefreshing)
}
```

This repository's `MainDispatcherRule` (in [unit-testing.md](unit-testing.md)) defaults to `StandardTestDispatcher` for the reasons given there, so the override goes the other way: `Dispatchers.setMain(UnconfinedTestDispatcher())` in a test that wants eager execution. The technique is the same.

### Navigation tests through the real graph

The sample's `AppNavigationTest` does not inspect a `NavController`. It launches an empty Hilt-enabled Activity, sets the whole nav graph as content, seeds the injected fake repository, then clicks and asserts on visible text, including after `Espresso.pressBack()`. That tests what the user experiences, and survives a migration from Navigation Compose to Navigation 3 without changes.

The debug-only Activity (in `app/src/debug/`, so it never ships):

```kotlin
// app/src/debug/kotlin/com/example/app/HiltTestActivity.kt
package com.example.app

import androidx.activity.ComponentActivity
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class HiltTestActivity : ComponentActivity()
```

Also register it in `app/src/debug/AndroidManifest.xml` with `android:exported="false"` and `android:theme="@style/Theme.App"`.

```kotlin
// app/src/androidTest/kotlin/com/example/app/AppNavigationTest.kt
package com.example.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.espresso.Espresso.pressBack
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.example.app.testing.FakeTodoRepository
import com.example.app.todo.TodoItem
import com.example.app.ui.theme.AppTheme
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import javax.inject.Inject

@RunWith(AndroidJUnit4::class)
@HiltAndroidTest
class AppNavigationTest {
    @get:Rule(order = 0) val hiltRule = HiltAndroidRule(this)
    @get:Rule(order = 1) val composeRule = createAndroidComposeRule<HiltTestActivity>()

    @Inject lateinit var repository: FakeTodoRepository   // the @Singleton fake the ViewModels also get

    private val activity get() = composeRule.activity

    @Before
    fun setUp() {
        hiltRule.inject()
        repository.seed(TodoItem("1", "Buy milk", false, Instant.EPOCH))
        composeRule.setContent { AppTheme { AppNavHost() } }   // the real graph, default start destination
    }

    @Test
    fun openDetail_thenBack_returnsToList() {
        composeRule.onNodeWithText("Buy milk").performClick()
        composeRule.onNodeWithText(activity.getString(R.string.detail_title)).assertIsDisplayed()

        pressBack()

        composeRule.onNodeWithText(activity.getString(R.string.list_title)).assertIsDisplayed()
        composeRule.onNodeWithText("Buy milk").assertIsDisplayed()
    }

    @Test
    fun detail_deleteNavigatesToListAndShowsMessage() {
        composeRule.onNodeWithText("Buy milk").performClick()
        composeRule.onNodeWithContentDescription(activity.getString(R.string.action_delete)).performClick()

        composeRule.onNodeWithText(activity.getString(R.string.list_title)).assertIsDisplayed()
        composeRule.onNodeWithText(activity.getString(R.string.todo_deleted)).assertIsDisplayed()   // snackbar
    }

    @Test
    fun backOnStartDestination_finishesActivity() {
        pressBack()
        composeRule.waitUntil { activity.isFinishing }
    }
}
```

Rules of this style:

- Strings come from `activity.getString(R.string.x)`, never literals, so the test passes under any locale and fails when a label is removed.
- `pressBack()` from Espresso exercises the real `OnBackPressedDispatcher`, including predictive back handling; `navController.popBackStack()` would not.
- Seed through the injected fake before `setContent`, because the start destination's ViewModel subscribes as soon as it composes.
- Assert visible content, not destinations. Use `TestNavHostController` (the earlier "Navigation tests" section) only when two screens look identical or when testing a graph builder in isolation.
- These tests need a device or emulator because of Hilt plus the real Activity; keep them to the handful of flows that matter and put everything else in the Robolectric screen tests above.

## What belongs here vs elsewhere

- State rendering (loading, empty, error, lists): UI test on the stateless screen under Robolectric. Fast, in the unit test task.
- Visual appearance (spacing, colors, dark theme, font scale): [screenshot-testing.md](screenshot-testing.md).
- Business logic: ViewModel unit tests in [unit-testing.md](unit-testing.md). Do not assert business rules through the UI.
- Critical flows across screens (sign in, checkout): a small number of instrumented Hilt tests on a device.

## Avoid

```kotlin
// Anti-pattern: Thread.sleep instead of waitUntil or clock control.
Thread.sleep(1000)

// Anti-pattern: testTag on everything, including things with visible text; hides a11y regressions.
Text("Save", Modifier.testTag("save-button"))

// Anti-pattern: testing the ViewModel through the UI.
composeRule.onNodeWithText("Add").performClick(); assertEquals(1, viewModel.uiState.value.items.size)

// Anti-pattern: real network in a UI test.

// Anti-pattern: asserting on unmerged inner text of a Material component; brittle across versions.
composeRule.onNodeWithText("Save", useUnmergedTree = true).onParent().onParent().assertIsEnabled()
```

## Verify

```sh
./gradlew :app:testDebugUnitTest --tests "*ScreenTest"        # Robolectric Compose tests
./gradlew :app:connectedDebugAndroidTest                      # device/emulator, incl. Hilt flows
./gradlew :app:pixel7Api35DebugAndroidTest                    # Gradle-managed device, if configured
```

Gradle-managed devices (`testOptions.managedDevices`) give CI a reproducible emulator without a device farm.

## Sources

- https://developer.android.com/develop/ui/compose/testing
- https://developer.android.com/develop/ui/compose/testing/apis
- https://developer.android.com/develop/ui/compose/testing/synchronization
- https://developer.android.com/develop/ui/compose/testing/interoperability
- https://developer.android.com/guide/navigation/testing
- https://developer.android.com/training/dependency-injection/hilt-testing
- https://developer.android.com/studio/test/gradle-managed-devices
- https://robolectric.org/
- https://developer.android.com/training/testing/espresso/basics
- [../../references/architecture-samples.md](../../references/architecture-samples.md) for the sample the shared-test and navigation-test style was studied from
