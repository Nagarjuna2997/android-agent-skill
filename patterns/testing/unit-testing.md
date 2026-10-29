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
