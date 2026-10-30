# Unit Testing

JVM tests that run with `./gradlew testDebugUnitTest` in seconds. This file covers the framework choice, fakes vs mocks, coroutine and Flow testing, and Room with Robolectric. Compose UI tests are in [compose-ui-testing.md](compose-ui-testing.md); the project-wide strategy is in [../../checklists/testing.md](../../checklists/testing.md).

## JUnit 4 or JUnit 5

Android's instrumentation runner, Compose test rules (`createComposeRule`), Hilt (`HiltAndroidRule`) and Robolectric (`RobolectricTestRunner`) are all JUnit 4 rules and runners. JUnit 5 works for pure JVM modules (`:domain`, `:core:common`) and gives parameterized tests, nested classes and better assertions, but requires a third-party plugin for instrumented tests and does not support rules.

Recommendation: JUnit 4 everywhere in Android modules, so one style covers unit, Robolectric and instrumented tests. JUnit 5 in pure Kotlin modules only if the team wants it. Do not mix within a module.

```kotlin
// app/build.gradle.kts
dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:<version>")
    testImplementation("app.cash.turbine:turbine:<version>")
    testImplementation("androidx.test:core-ktx:<version>")
    testImplementation("org.robolectric:robolectric:<version>")
    testImplementation("com.google.truth:truth:<version>")   // optional; JUnit asserts are fine
}
android {
    testOptions.unitTests.isIncludeAndroidResources = true   // Robolectric needs resources
    testOptions.unitTests.isReturnDefaultValues = true       // android.jar stubs return defaults instead of throwing
}
```

Resolve the versions from `data/versions.json` or each library's release page; do not invent them.

## Fakes over mocks

A fake is a working implementation with shortcuts (in-memory, no network). A mock is a scripted stub that records calls. Prefer fakes:

- A fake implements the interface, so a signature change breaks it at compile time; a mock's `every { }` block breaks at runtime or silently.
- Fakes are reused by previews, UI tests and other unit tests. Mocks are rewritten per test.
- Fakes test behavior ("after add, observeAll emits the item"); mocks test interaction ("add was called once"), which couples the test to the implementation.

```kotlin
// core/testing/src/main/kotlin/.../FakeTodoRepository.kt
class FakeTodoRepository(initial: List<TodoItem> = emptyList()) : TodoRepository {
    private val items = MutableStateFlow(initial)
    var failure: AppError? = null
    val addCalls = mutableListOf<String>()      // lightweight call recording when you need it

    override fun observeAll(): Flow<List<TodoItem>> = items
    override suspend fun refresh(): Result<Unit> = failure?.let { Result.Failure(it) } ?: Result.Success(Unit)
    override suspend fun add(title: String) {
        addCalls += title
        failure?.let { throw IllegalStateException("fake failure") }
        items.update { it + TodoItem(UUID.randomUUID().toString(), title, false, 0) }
    }
    override suspend fun setCompleted(id: String, completed: Boolean) =
        items.update { list -> list.map { if (it.id == id) it.copy(isCompleted = completed) else it } }
    override suspend fun delete(id: String) = items.update { list -> list.filterNot { it.id == id } }
    override suspend fun pushPending(): Result<Unit> = Result.Success(Unit)
}
```

Put fakes in `:core:testing` (a regular `main` source set depended on with `testImplementation` and `debugImplementation`) so previews can use them without being in a test source set.

Use MockK (`io.mockk:mockk:<version>`) when a fake is impractical: a third-party SDK with a huge interface, a `Context` method, or verifying that an analytics call happened. Keep `relaxed = true` out of production-adjacent tests; a relaxed mock returns defaults for everything and hides mistakes.

```kotlin
val analytics = mockk<Analytics>()
every { analytics.track(any()) } just Runs
viewModel.add("Milk")
verify(exactly = 1) { analytics.track(match { it.name == "todo_added" }) }
```

## Coroutines: runTest and MainDispatcherRule

`runTest` runs the body in a `TestScope` with virtual time: `delay` advances instantly, and the test fails if a coroutine is still active at the end. ViewModels launch on `Dispatchers.Main`, which does not exist on the JVM; replace it with the rule from [../mvvm.md](../mvvm.md):

```kotlin
@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(val dispatcher: TestDispatcher = StandardTestDispatcher()) : TestWatcher() {
    override fun starting(description: Description) = Dispatchers.setMain(dispatcher)
    override fun finished(description: Description) = Dispatchers.resetMain()
}
```

`StandardTestDispatcher` queues launched coroutines until the test yields (`advanceUntilIdle()`, `runCurrent()`, or a suspension such as Turbine's `awaitItem()`). `UnconfinedTestDispatcher` runs them eagerly, which is convenient but hides ordering bugs; use `Standard` by default.

Inject the same dispatcher where the code under test takes an `IoDispatcher`, so all work shares one scheduler:

```kotlin
val vm = TodoViewModel(repo, SavedStateHandle(), ioDispatcher = mainDispatcherRule.dispatcher)
```

If a class hardcodes `Dispatchers.IO`, the test will run real threads and become flaky. Fix the class.

Timeouts and retries:

```kotlin
@Test
fun `retry waits with backoff`() = runTest {
    var attempts = 0
    val result = retryWithBackoff(maxAttempts = 3, initialDelay = 1.seconds) {
        attempts++
        if (attempts < 3) Result.Failure(AppError.Server(503)) else Result.Success("ok")
    }
    assertEquals(3, attempts)
    assertTrue(currentTime >= 1_000 + 2_000)     // virtual time advanced past the delays
    assertEquals(Result.Success("ok"), result)
}
```

## Flow testing with Turbine

`Flow.test { }` collects in a coroutine and gives `awaitItem()`, `expectNoEvents()`, `awaitComplete()`, `awaitError()`. Always end with `cancelAndIgnoreRemainingEvents()` on a `StateFlow` because it never completes.

```kotlin
@Test
fun `uiState goes Loading then Success`() = runTest {
    viewModel.uiState.test {
        assertEquals(Content.Loading, awaitItem().content)
        assertTrue(awaitItem().content is Content.Success)
        cancelAndIgnoreRemainingEvents()
    }
}
```

`StateFlow` conflates: if two updates happen before the collector runs, you see only the last. Tests asserting an intermediate state (a brief `isSubmitting = true`) need either `UnconfinedTestDispatcher` in the rule, or an assertion on the final state only. Prefer the latter; the intermediate flash is an implementation detail.

For `stateIn(WhileSubscribed)` flows, nothing runs until `test { }` subscribes; that is correct and mirrors production. For `SharedFlow` (which you should not use for events; see [../mvvm.md](../mvvm.md)), `turbineScope` with multiple `testIn` collectors is available.

## Testing ViewModels

Test through the public surface: call functions, assert on `uiState`. Do not reach into private fields.

```kotlin
class TodoViewModelTest {
    @get:Rule val mainDispatcherRule = MainDispatcherRule()
    private val repo = FakeTodoRepository(listOf(TodoItem("1", "Milk", false, 0)))
    private val vm by lazy { TodoViewModel(repo, SavedStateHandle(), mainDispatcherRule.dispatcher) }

    @Test fun `toggle marks item completed`() = runTest {
        vm.uiState.test {
            awaitItem(); awaitItem()
            vm.toggle(TodoItem("1", "Milk", false, 0))
            val items = (awaitItem().content as Content.Success).items
            assertTrue(items.single().isCompleted)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test fun `failed refresh keeps content and shows a message`() = runTest {
        repo.failure = AppError.Network(IOException())
        vm.uiState.test {
            awaitItem(); awaitItem()
            vm.refresh()
            val state = awaitItem()
            assertTrue(state.content is Content.Success)
            assertNotNull(state.userMessage)
            cancelAndIgnoreRemainingEvents()
        }
    }
}
```

`SavedStateHandle()` is a plain class; constructing it in a JVM test needs no Android. If a test must assert what the ViewModel saved, read `handle.get<T>(key)` after the call.

## Testing repositories

Test the real repository against a fake remote and an in-memory Room database. Only the `TodoApi` is faked; Room runs for real under Robolectric.

```kotlin
class FakeTodoApi : TodoApi {
    var items = listOf<TodoDto>()
    var failWith: Throwable? = null
    val puts = mutableListOf<TodoDto>()
    override suspend fun list(): List<TodoDto> { failWith?.let { throw it }; return items }
    override suspend fun put(id: String, body: TodoDto): TodoDto { failWith?.let { throw it }; puts += body; return body }
    override suspend fun delete(id: String) { failWith?.let { throw it } }
}
```

```kotlin
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])   // pin an SDK Robolectric supports; it lags the newest platform
class TodoRepositoryImplTest {
    private lateinit var db: AppDatabase
    private val api = FakeTodoApi()
    private val scheduler = RecordingSyncScheduler()
    private lateinit var repo: TodoRepositoryImpl

    @Before fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        repo = TodoRepositoryImpl(db.todoDao(), api, Clock.fixed(Instant.EPOCH, ZoneOffset.UTC), scheduler, UnconfinedTestDispatcher())
    }

    @After fun tearDown() = db.close()

    @Test fun `refresh maps IOException to Network`() = runTest {
        api.failWith = IOException("down")
        val result = repo.refresh()
        assertTrue((result as Result.Failure).error is AppError.Network)
    }

    @Test fun `pushPending clears the pending flag after a successful put`() = runTest {
        repo.add("Milk")
        assertEquals(1, db.todoDao().pending().size)
        repo.pushPending()
        assertEquals(0, db.todoDao().pending().size)
        assertEquals("Milk", api.puts.single().title)
    }

    @Test fun `observeAll emits on local write`() = runTest {
        repo.observeAll().test {
            assertEquals(emptyList<TodoItem>(), awaitItem())
            repo.add("Milk")
            assertEquals("Milk", awaitItem().single().title)
            cancelAndIgnoreRemainingEvents()
        }
    }
}
```

`allowMainThreadQueries()` is acceptable in tests only. Room's `Flow` queries use their own dispatcher, so Turbine collection works under Robolectric without extra setup. `UnconfinedTestDispatcher` is used for the repository's `io` here because Robolectric's main looper and the test scheduler do not share a clock; with `Standard` you would need `advanceUntilIdle()` after each call.

Migrations: with `exportSchema = true` and `androidx.room:room-testing`, `MigrationTestHelper` validates that each migration produces the expected schema. Run those as instrumented tests; Robolectric's SQLite differs from the device's in edge cases.

## Test doubles as Gradle modules

In a multi-module project (see [../clean-architecture.md](../clean-architecture.md)) the fakes, the dispatcher rule and the Hilt test modules are shared code with their own dependencies. Now in Android (see [../../references/nowinandroid.md](../../references/nowinandroid.md)) splits them into two modules; the split keeps JVM unit tests free of Hilt while instrumented tests get a whole fake data layer.

```
core/
  testing/      main source set: MainDispatcherRule, Test*Repository doubles, test data, TestDispatcherModule, AppTestRunner
  data-test/    main source set: TestDataModule (@TestInstallIn replacing DataModule) binding the doubles above
```

Both are ordinary Android library modules with `main` source sets (not `test`), consumed with `testImplementation(project(":core:testing"))` and `androidTestImplementation(project(":core:data-test"))`. A `debugImplementation` on `:core:testing` lets previews use the doubles too.

```kotlin
// core/testing/build.gradle.kts
plugins {
    id("com.example.android.library")
    id("com.example.android.library.hilt")
}
android { namespace = "com.example.app.core.testing" }
dependencies {
    api(libs.kotlinx.coroutines.test)        // api: every consumer writes runTest
    api(project(":core:common"))
    api(project(":core:data"))               // the interfaces the doubles implement
    api(project(":core:model"))
    implementation(libs.androidx.test.rules)
    implementation(libs.hilt.android.testing)
}
```

The doubles follow the fake style above and add a test-only push method so a test can drive emissions after the ViewModel subscribed:

```kotlin
// core/testing/src/main/kotlin/com/example/app/core/testing/repository/TestNotesRepository.kt
package com.example.app.core.testing.repository

import com.example.app.core.data.repository.NotesRepository
import com.example.app.core.data.sync.Synchronizer
import com.example.app.core.model.Note
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TestNotesRepository @Inject constructor() : NotesRepository {
    private val notes = MutableStateFlow<List<Note>>(emptyList())

    override fun observeAll(): Flow<List<Note>> = notes
    override fun observe(id: String): Flow<Note?> = notes.map { list -> list.firstOrNull { it.id == id } }
    override suspend fun setArchived(id: String, archived: Boolean) =
        notes.update { list -> list.map { if (it.id == id) it.copy(isArchived = archived) else it } }
    override suspend fun syncWith(synchronizer: Synchronizer): Boolean = true

    /** Test-only: replace the whole list; subscribers see the new value immediately. */
    fun sendNotes(value: List<Note>) { notes.value = value }
}
```

```kotlin
// core/testing/src/main/kotlin/com/example/app/core/testing/di/TestDispatcherModule.kt
package com.example.app.core.testing.di

import com.example.app.core.common.IoDispatcher
import com.example.app.core.common.di.DispatchersModule
import dagger.Module
import dagger.Provides
import dagger.hilt.components.SingletonComponent
import dagger.hilt.testing.TestInstallIn
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import javax.inject.Singleton

/** One scheduler for the whole Hilt graph in instrumented tests, injectable into the test class as TestDispatcher. */
@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [DispatchersModule::class])
internal object TestDispatcherModule {
    @Provides @Singleton fun provideTestDispatcher(): TestDispatcher = StandardTestDispatcher()
    @Provides @IoDispatcher fun provideIo(dispatcher: TestDispatcher): CoroutineDispatcher = dispatcher
}
```

The runner that makes `@HiltAndroidTest` work on a device without a test `Application` subclass per module:

```kotlin
// core/testing/src/main/kotlin/com/example/app/core/testing/AppTestRunner.kt
package com.example.app.core.testing

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import dagger.hilt.android.testing.HiltTestApplication

class AppTestRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader, name: String, context: Context): Application =
        super.newApplication(cl, HiltTestApplication::class.java.name, context)
}
```

Set `testInstrumentationRunner = "com.example.app.core.testing.AppTestRunner"` in the library convention plugin so every module uses it.

`:core:data-test` replaces the real data bindings in one place:

```kotlin
// core/data-test/src/main/kotlin/com/example/app/core/data/test/TestDataModule.kt
package com.example.app.core.data.test

import com.example.app.core.data.di.DataModule
import com.example.app.core.data.repository.NotesRepository
import com.example.app.core.data.repository.UserDataRepository
import com.example.app.core.data.sync.SyncManager
import com.example.app.core.testing.repository.TestNotesRepository
import com.example.app.core.testing.repository.TestUserDataRepository
import com.example.app.core.testing.util.NeverSyncingSyncManager
import dagger.Binds
import dagger.Module
import dagger.hilt.components.SingletonComponent
import dagger.hilt.testing.TestInstallIn

@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [DataModule::class])
internal interface TestDataModule {
    @Binds fun bindNotes(impl: TestNotesRepository): NotesRepository
    @Binds fun bindUserData(impl: TestUserDataRepository): UserDataRepository
    @Binds fun bindSyncManager(impl: NeverSyncingSyncManager): SyncManager
}
```

`@TestInstallIn` is processed by the Hilt compiler in the module that applies it, which is why `:core:data-test` is a library with the Hilt plugin rather than a `test` source set: every instrumented test that depends on it gets the replacement without `@UninstallModules`. The doubles carry `@Inject constructor()` and `@Singleton` so a test can `@Inject lateinit var notes: TestNotesRepository` and push data into the same instance the ViewModel reads.

A ViewModel test then needs no Hilt at all:

```kotlin
class NotesViewModelTest {
    @get:Rule val mainDispatcherRule = MainDispatcherRule()
    private val notes = TestNotesRepository()
    private val viewModel = NotesViewModel(notes = notes, syncManager = NeverSyncingSyncManager())

    @Test fun `emits Success once the repository has data`() = runTest {
        viewModel.uiState.test {
            assertEquals(NotesUiState.Loading, awaitItem())
            notes.sendNotes(listOf(Note("1", "First", isArchived = false)))
            assertEquals(listOf("1"), (awaitItem() as NotesUiState.Success).notes.map { it.id })
            cancelAndIgnoreRemainingEvents()
        }
    }
}
```

## Screenshot tests with Roborazzi under Robolectric

[screenshot-testing.md](screenshot-testing.md) covers Compose Preview Screenshot Testing, which renders `@Preview`s with layoutlib. Now in Android uses the other JVM option: Roborazzi (`io.github.takahirom.roborazzi`, `<version>` from https://github.com/takahirom/roborazzi/releases) renders through Robolectric's native graphics, so the screenshot comes from the same Compose test rule you already use, can include a full screen with state, and can run the Accessibility Test Framework checks on the rendered tree. Pick one of the two per project; both in one module doubles the reference images to maintain.

Setup, in the module that owns the composables under test:

```kotlin
// core/designsystem/build.gradle.kts (and each feature impl module with screenshot tests)
plugins {
    id("com.example.android.library.compose")
    id("io.github.takahirom.roborazzi") version "<version>"
}
android { testOptions.unitTests.isIncludeAndroidResources = true }
dependencies {
    testImplementation(project(":core:screenshot-testing"))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.androidx.compose.ui.test.manifest)
    testImplementation("org.robolectric:robolectric:<version>")
}
```

```properties
# gradle.properties
roborazzi.test.verify=true     # testDebugUnitTest compares against src/test/screenshots; record with recordRoborazziDebug
```

A small `:core:screenshot-testing` module holds the helper so every test is three lines. Original re-implementation of the idea:

```kotlin
// core/screenshot-testing/src/main/kotlin/com/example/app/core/screenshottesting/Screenshots.kt
package com.example.app.core.screenshottesting

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.DarkMode
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.rules.ActivityScenarioRule
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import org.robolectric.RuntimeEnvironment

/** Device specs as Robolectric qualifiers; keep the list short, each entry is one PNG per test. */
enum class ScreenshotDevice(val label: String, val qualifiers: String) {
    PHONE("phone", "w411dp-h891dp-480dpi"),
    FOLDABLE("foldable", "w673dp-h841dp-480dpi"),
    TABLET("tablet", "w1280dp-h800dp-480dpi"),
}

private val options = RoborazziOptions(
    compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0f),   // pixel-exact; raise only for antialiasing noise
    recordOptions = RoborazziOptions.RecordOptions(resizeScale = 0.5),        // halves PNG size in the repository
)

fun <A : ComponentActivity> AndroidComposeTestRule<ActivityScenarioRule<A>, A>.captureMultiDevice(
    name: String,
    darkMode: Boolean = false,
    content: @Composable () -> Unit,
) {
    ScreenshotDevice.entries.forEach { device ->
        RuntimeEnvironment.setQualifiers(device.qualifiers)
        activity.setContent {
            // LocalInspectionMode = true makes AsyncImage and similar render placeholders, as in previews.
            CompositionLocalProvider(LocalInspectionMode provides true) {
                DeviceConfigurationOverride(DeviceConfigurationOverride.DarkMode(darkMode)) { content() }
            }
        }
        val suffix = if (darkMode) "_dark" else ""
        onRoot().captureRoboImage("src/test/screenshots/${name}_${device.label}$suffix.png", roborazziOptions = options)
    }
}
```

The test:

```kotlin
package com.example.app.feature.notes.impl

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import com.example.app.core.designsystem.theme.AppTheme
import com.example.app.core.screenshottesting.captureMultiDevice
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)    // real Skia rendering; without it the PNG is blank
@LooperMode(LooperMode.Mode.PAUSED)
@Config(sdk = [35])
class NotesScreenScreenshotTest {
    @get:Rule val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val notes = NotesPreviewParameterProvider().values.first()

    @Test
    fun populated() = composeRule.captureMultiDevice("NotesScreen_populated") {
        AppTheme(dynamicColor = false) { NotesScreen(state = NotesUiState.Success(notes), onOpen = {}, onArchive = {}) }
    }

    @Test
    fun populatedDark() = composeRule.captureMultiDevice("NotesScreen_populated", darkMode = true) {
        AppTheme(dynamicColor = false) { NotesScreen(state = NotesUiState.Success(notes), onOpen = {}, onArchive = {}) }
    }

    @Test
    fun empty() = composeRule.captureMultiDevice("NotesScreen_empty") {
        AppTheme(dynamicColor = false) { NotesScreen(state = NotesUiState.Empty, onOpen = {}, onArchive = {}) }
    }
}
```

Deterministic inputs are the whole game: `TimeZone.setDefault(TimeZone.getTimeZone("UTC"))` in a `@Before` when dates render, preview parameter providers instead of random data, `dynamicColor = false`, and `@Config(sdk = [...])` pinned, because fonts differ between Robolectric SDK levels.

Accessibility checks on the same render: `roborazzi-accessibility-check` adds `onRoot().checkRoboAccessibility(...)` backed by the Accessibility Test Framework (text contrast, touch target size, missing labels). Run it before `captureRoboImage` so a failing check still records the image for the report; suppress known false positives per check with a Hamcrest matcher rather than disabling the whole category.

Commands:

```sh
./gradlew :feature:notes:impl:recordRoborazziDebug      # write/overwrite src/test/screenshots/*.png
./gradlew :feature:notes:impl:verifyRoborazziDebug      # fail on diff; build/outputs/roborazzi/*_compare.png shows the delta
./gradlew :feature:notes:impl:testDebugUnitTest         # same as verify when roborazzi.test.verify=true
```

In CI, run verify; on a pull request from the same repository a failed verify can trigger `recordRoborazziDebug` and a commit of the new PNGs for review (Now in Android does this with a bot commit). Never auto-record on `main`, and reject PRs from forks that change screenshots without a human look. The reference PNGs live in the repository; at `resizeScale = 0.5` a screen is 50 to 150 KB, so keep the device list to what the product supports.

## What not to unit test

- Composables (use [compose-ui-testing.md](compose-ui-testing.md) or [screenshot-testing.md](screenshot-testing.md)).
- Generated code (Room DAOs' SQL is validated at compile time; test the repository around them).
- Trivial mappers with no logic; a round-trip test for a mapper with field renames is enough.
- Framework behavior (that `stateIn` shares, that Hilt injects).

## Avoid

```kotlin
// Anti-pattern: Thread.sleep to wait for a coroutine.
vm.load(); Thread.sleep(500); assertEquals(...)

// Anti-pattern: GlobalScope or runBlocking in the test body with a Main dispatcher.
runBlocking { vm.load() }

// Anti-pattern: asserting on a mock's internal calls instead of the observable state.
verify { repo.add("Milk") }     // when you could assert the item appears in uiState

// Anti-pattern: a relaxed mock for the repository; returns null/empty for everything silently.
mockk<TodoRepository>(relaxed = true)

// Anti-pattern: one giant test method covering load, toggle, delete and error.
```

## Verify

```sh
./gradlew :app:testDebugUnitTest
./gradlew :app:testDebugUnitTest --tests "com.example.app.todo.*" -i    # single package, verbose
./gradlew :domain:test
# HTML report: app/build/reports/tests/testDebugUnitTest/index.html
```

A test suite that takes longer than a minute for a few hundred tests usually has a real dispatcher or a `Thread.sleep` hiding somewhere.

## Sources

- https://developer.android.com/training/testing/local-tests
- https://developer.android.com/kotlin/coroutines/test
- https://developer.android.com/kotlin/flow/test
- https://developer.android.com/training/testing/fundamentals/test-doubles
- https://developer.android.com/training/data-storage/room/testing-db
- https://developer.android.com/training/testing/local-tests/robolectric
- https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-test/
- https://github.com/cashapp/turbine
- https://developer.android.com/training/dependency-injection/hilt-testing
- https://robolectric.org/
- https://github.com/takahirom/roborazzi
