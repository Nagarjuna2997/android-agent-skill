# Coroutines and Flow on Android

Structured concurrency, dispatchers, cancellation and exception rules, and the Flow APIs an Android app actually uses, with the lifecycle-safe way to collect them in Compose and how to test all of it.

## Structured concurrency

Every coroutine runs inside a `CoroutineScope`. The scope owns the coroutine: cancelling the scope cancels everything launched in it, and a failure in a child propagates to the parent unless a `SupervisorJob` stops it. This is the whole model; everything else follows from it.

On Android the scopes you use are:

| Scope | Lives as long as | Use for |
|---|---|---|
| `viewModelScope` | the `ViewModel` | loading, saving, observing data for one screen |
| `lifecycleScope` | the `Activity` or `Fragment` | UI-bound work outside Compose |
| `rememberCoroutineScope()` | the composable's composition | work started by a user action inside Compose |
| An application scope you create | the process | work that must outlive any screen, such as a write that was already started |
| `WorkManager` | survives process death | deferrable, guaranteed work |

```kotlin
// Anti-pattern: GlobalScope has no owner, so nothing cancels it and failures vanish.
GlobalScope.launch { repository.sync() }
```

```kotlin
// An application-level scope, provided once by DI.
@Module
@InstallIn(SingletonComponent::class)
object CoroutineModule {
    @Provides
    @Singleton
    @ApplicationScope
    fun provideApplicationScope(
        @IoDispatcher ioDispatcher: CoroutineDispatcher,
    ): CoroutineScope = CoroutineScope(SupervisorJob() + ioDispatcher)
}

@Qualifier @Retention(AnnotationRetention.RUNTIME) annotation class ApplicationScope
@Qualifier @Retention(AnnotationRetention.RUNTIME) annotation class IoDispatcher
@Qualifier @Retention(AnnotationRetention.RUNTIME) annotation class DefaultDispatcher
```

Use `coroutineScope { }` inside a suspend function to run children in parallel and wait for all of them. If one fails, the rest are cancelled and the exception is rethrown to the caller.

```kotlin
suspend fun loadDashboard(): Dashboard = coroutineScope {
    val profile = async { userRepository.profile() }
    val feed = async { feedRepository.latest() }
    Dashboard(profile.await(), feed.await())
}
```

## Dispatchers

- `Dispatchers.Main` (and `Main.immediate`): UI. `viewModelScope` uses `Main.immediate`.
- `Dispatchers.IO`: blocking I/O such as files, sockets, JDBC. Room and Retrofit suspend functions already switch internally; wrapping them in `withContext(Dispatchers.IO)` is harmless but unnecessary.
- `Dispatchers.Default`: CPU work such as parsing, sorting, image decoding.
- `Dispatchers.Unconfined`: tests and library internals only.

Inject dispatchers instead of referencing `Dispatchers.*` inline so tests can replace them.

```kotlin
class ImportNotesUseCase @Inject constructor(
    private val repository: NoteRepository,
    @DefaultDispatcher private val defaultDispatcher: CoroutineDispatcher,
) {
    suspend operator fun invoke(raw: String): List<Note> = withContext(defaultDispatcher) {
        parse(raw).also { repository.saveAll(it) }
    }
}
```

The rule for where to switch: the function that does the blocking work is responsible for moving off main. A repository or data source that reads a file calls `withContext(ioDispatcher)` itself, so every caller is main-safe and never needs to know.

## Cancellation

Cancellation is cooperative. A coroutine that never suspends and never checks `isActive` cannot be cancelled. Long loops should call `ensureActive()` or `yield()`.

`CancellationException` is how the machinery works; catching and swallowing it breaks structured concurrency. Any `catch (e: Exception)` or `runCatching` block must rethrow it.

```kotlin
suspend fun <T> safeCall(block: suspend () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(e)
    }
```

```kotlin
// Anti-pattern: swallows cancellation, so the ViewModel keeps running after the screen is gone.
val result = runCatching { repository.load() }
```

If a cancelled coroutine must still do a small amount of cleanup that suspends, wrap it in `withContext(NonCancellable)`. Keep it short.

## Exceptions and SupervisorJob

With a plain `Job`, one failing child cancels its siblings and the parent. With `SupervisorJob`, children fail independently. `viewModelScope` is a supervisor scope, so one failed `launch` does not take down the others, but an uncaught exception in a `launch` still crashes the process. Handle exceptions inside the coroutine, at the point where you know what to do with them.

```kotlin
fun refresh() {
    viewModelScope.launch {
        _uiState.update { it.copy(isRefreshing = true) }
        safeCall { repository.refresh() }
            .onSuccess { _uiState.update { it.copy(isRefreshing = false, error = null) } }
            .onFailure { e -> _uiState.update { it.copy(isRefreshing = false, error = e.toUserMessage()) } }
    }
}
```

`async` differs: its exception is stored and thrown at `await()`. Always `await()` inside the same `coroutineScope` that created it; an un-awaited `async` that fails will still cancel the parent scope.

`CoroutineExceptionHandler` is a last-resort logger for `launch` roots; it does not make code recover. Install one on the application scope so failures there are logged rather than crashing silently.

## Flow basics

A `Flow` is a cold, asynchronous sequence. Nothing runs until something collects it, and each collector gets its own execution.

```kotlin
fun observeNotes(): Flow<List<Note>> = noteDao.observeAll()
    .map { entities -> entities.map(NoteEntity::toDomain) }
    .distinctUntilChanged()
```

Operators used daily:

- `map`, `filter`, `distinctUntilChanged`: shape the stream.
- `combine(a, b) { x, y -> }`: latest value of each; emits when either changes.
- `zip`: pairwise, rarely wanted in UI.
- `flatMapLatest { }`: switch to a new inner flow when the outer emits; cancels the previous inner flow. The standard tool for "when the query changes, search again".
- `debounce(300)`: wait for input to settle. Pair with `flatMapLatest` for search.
- `catch { }`: handles exceptions from upstream only. Put it above the UI state mapping and emit an error state.
- `onStart { emit(Loading) }`: initial loading state.
- `retryWhen { cause, attempt -> }`: bounded retry with backoff.
- `first()`, `firstOrNull()`, `toList()`: terminal operators for one-shot use.
- `conflate()`, `buffer()`: when a fast producer meets a slow collector.

```kotlin
val searchResults: StateFlow<SearchUiState> = query
    .debounce(300)
    .distinctUntilChanged()
    .flatMapLatest { q ->
        if (q.isBlank()) flowOf(SearchUiState.Idle)
        else repository.search(q)
            .map<List<Item>, SearchUiState> { SearchUiState.Results(it) }
            .onStart { emit(SearchUiState.Searching) }
            .catch { e -> emit(SearchUiState.Error(e.toUserMessage())) }
    }
    .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SearchUiState.Idle)
```

Flows are sequential by default. `map { api.call() }` runs calls one after another; use `flatMapMerge` or `channelFlow` with `launch` for concurrency, and keep the concurrency bounded.

## flowOn

`flowOn(dispatcher)` changes the dispatcher for everything upstream of it, not downstream. The collector keeps running on its own context.

```kotlin
fun readLargeFile(): Flow<Line> = flow {
    File(path).useLines { lines -> lines.forEach { emit(Line(it)) } }
}.flowOn(ioDispatcher)
```

Never call `withContext` inside a `flow { }` builder to emit from another dispatcher; the flow builder enforces context preservation and throws. Use `flowOn` or `channelFlow`.

## Cold vs hot: StateFlow and SharedFlow

A cold flow restarts for every collector. A hot flow runs independently of collectors and shares emissions.

`StateFlow<T>`:
- Always has a value; `value` is readable synchronously.
- Conflates: a collector sees the latest value, not every intermediate one.
- Skips emissions equal to the current value (`equals`).
- The right type for UI state.

`SharedFlow<T>`:
- No initial value unless `replay` is set.
- Delivers every emission to active subscribers; with `replay = 0`, an emission with no subscribers is lost.
- Historically used for one-time events (snackbar, navigation). Prefer modeling those as state the UI consumes and then acknowledges, because an event emitted while the screen is in the background is dropped.

```kotlin
@HiltViewModel
class NotesViewModel @Inject constructor(
    repository: NoteRepository,
) : ViewModel() {

    val uiState: StateFlow<NotesUiState> = repository.observeNotes()
        .map { notes -> if (notes.isEmpty()) NotesUiState.Empty else NotesUiState.Content(notes) }
        .catch { e -> emit(NotesUiState.Error(e.toUserMessage())) }
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = NotesUiState.Loading,
        )
}
```

`SharingStarted.WhileSubscribed(5_000)` keeps the upstream alive for five seconds after the last collector leaves, which covers configuration changes without restarting the query, while stopping it when the app is in the background.

When state is mutated from the ViewModel instead of derived from a repository, use `MutableStateFlow` privately and expose the read-only type:

```kotlin
private val _uiState = MutableStateFlow(FormUiState())
val uiState: StateFlow<FormUiState> = _uiState.asStateFlow()

fun onNameChanged(name: String) {
    _uiState.update { it.copy(name = name, nameError = null) }
}
```

Use `update { }` rather than `value = value.copy()`; it is atomic under concurrent writers.

## callbackFlow

Wrap callback-based APIs (location, sensors, Bluetooth, Firebase listeners) in `callbackFlow`. Register in the builder, unregister in `awaitClose`. Without `awaitClose` the flow throws when the collector cancels, which is the library telling you that you forgot to clean up.

```kotlin
fun locationUpdates(client: FusedLocationProviderClient, request: LocationRequest): Flow<Location> =
    callbackFlow {
        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { trySend(it) }
            }
        }
        client.requestLocationUpdates(request, callback, Looper.getMainLooper())
            .addOnFailureListener { close(it) }
        awaitClose { client.removeLocationUpdates(callback) }
    }
```

`trySend` is for non-suspending callbacks. If the producer may outrun the collector, add `.buffer(Channel.CONFLATED)` or `.conflate()` downstream.

## Collecting in the UI

Collect only while the lifecycle is at least `STARTED`. A collection that continues in the background wastes work and can touch a destroyed view.

In Compose:

```kotlin
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun NotesRoute(viewModel: NotesViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    NotesScreen(uiState = uiState, onRetry = viewModel::retry)
}
```

`collectAsStateWithLifecycle()` comes from `androidx.lifecycle:lifecycle-runtime-compose` (Lifecycle 2.11.0). `collectAsState()` from Compose runtime does not stop in the background; use it only in previews or non-Android Compose.

In an Activity or Fragment:

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.uiState.collect { render(it) }
    }
}
```

`repeatOnLifecycle` cancels the block on `STOPPED` and restarts it on `STARTED`. `flowWithLifecycle` is the operator form for a single flow. Do not use `launchWhenStarted`; it suspends instead of cancelling and is deprecated.

Inside a composable, never start a collection in a plain `LaunchedEffect` when `collectAsStateWithLifecycle` fits. If you need a side effect per emission (for example scrolling a list when an item is added), collect inside `LaunchedEffect` with `repeatOnLifecycle` through `LocalLifecycleOwner`:

```kotlin
val lifecycleOwner = LocalLifecycleOwner.current
LaunchedEffect(viewModel, lifecycleOwner) {
    lifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
        viewModel.scrollToTopRequests.collect { listState.animateScrollToItem(0) }
    }
}
```

## Testing

Dependencies: `kotlinx-coroutines-test` and `app.cash.turbine:turbine` (resolve the Turbine version from its release page; it is not in `data/versions.json`).

A dispatcher rule that replaces `Dispatchers.Main` so `viewModelScope` runs on the test scheduler:

```kotlin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.rules.TestWatcher
import org.junit.runner.Description

class MainDispatcherRule(
    val dispatcher: TestDispatcher = StandardTestDispatcher(),
) : TestWatcher() {
    override fun starting(description: Description) = Dispatchers.setMain(dispatcher)
    override fun finished(description: Description) = Dispatchers.resetMain()
}
```

A ViewModel test with Turbine:

```kotlin
class NotesViewModelTest {

    @get:Rule val mainDispatcherRule = MainDispatcherRule()

    private val repository = FakeNoteRepository()

    @Test
    fun `emits empty then content when a note is added`() = runTest {
        val viewModel = NotesViewModel(repository)

        viewModel.uiState.test {
            assertEquals(NotesUiState.Loading, awaitItem())
            assertEquals(NotesUiState.Empty, awaitItem())
            repository.add(Note(id = 1, text = "Buy milk"))
            assertEquals(NotesUiState.Content(listOf(Note(1, "Buy milk"))), awaitItem())
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `maps repository failure to error state`() = runTest {
        repository.failNextObserve(IOException("offline"))
        val viewModel = NotesViewModel(repository)

        viewModel.uiState.test {
            assertEquals(NotesUiState.Loading, awaitItem())
            assertTrue(awaitItem() is NotesUiState.Error)
        }
    }
}
```

Notes on test behavior:

- `runTest` skips `delay` automatically; `debounce` and timeouts resolve instantly in virtual time.
- A `StateFlow` built with `WhileSubscribed` has no upstream until something collects; Turbine's `test { }` is that collector. Without a collector, `uiState.value` stays at the initial value and the test will hang or fail.
- `StandardTestDispatcher` queues work until the scheduler runs; `awaitItem()` advances it. If you read `value` directly, call `advanceUntilIdle()` first. `UnconfinedTestDispatcher` runs eagerly and is simpler for small tests but hides ordering bugs.
- Inject the same `dispatcher` from the rule into any class that takes a `CoroutineDispatcher`, so all work shares the scheduler.
- Test a `callbackFlow` by driving the fake callback source and asserting with `turbineScope`.

## Verify

```sh
./gradlew :app:testDebugUnitTest --tests "*ViewModelTest"
./gradlew :app:lintDebug
```

Lint must not report `CoroutineCreationDuringComposition`, `FlowOperatorInvokedInComposition` or `StateFlowValueCalledInComposition`. `grep -rn "GlobalScope\|runBlocking" app/src/main` must return nothing.

## Sources

- https://kotlinlang.org/docs/coroutines-guide.html
- https://kotlinlang.org/docs/flow.html
- https://kotlinlang.org/docs/exception-handling.html
- https://developer.android.com/kotlin/coroutines
- https://developer.android.com/kotlin/flow
- https://developer.android.com/kotlin/flow/stateflow-and-sharedflow
- https://developer.android.com/topic/libraries/architecture/coroutines
- https://developer.android.com/kotlin/coroutines/test
