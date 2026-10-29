# MVVM with ViewModel, StateFlow and Compose

The default screen architecture for new Android code: a `ViewModel` owns one immutable `UiState`, exposes it as a `StateFlow`, and a Compose screen renders it and sends events back. This file is a complete worked example, from model to unit test.

```
┌──────────────────────────────────────────────┐
│ Compose screen                                │
│ collectAsStateWithLifecycle(); calls VM funcs │
└──────────────────────┬───────────────────────┘
                       │ UiState (down) / events (up)
┌──────────────────────▼───────────────────────┐
│ ViewModel                                     │
│ StateFlow<UiState>; viewModelScope; injected  │
│ repository interface + CoroutineDispatcher    │
└──────────────────────┬───────────────────────┘
                       │ Flow<List<TodoItem>> / suspend funcs
┌──────────────────────▼───────────────────────┐
│ Repository (interface) → Room / Retrofit      │
└──────────────────────────────────────────────┘
```

Rules that make this MVVM rather than "a class with some state":

1. One `UiState` data class, exposed as `StateFlow<UiState>`. No `LiveData`, no multiple loose `MutableState`s in the ViewModel.
2. Loading, empty, success and error are all representable in the state and all rendered by the screen.
3. Every dependency (repository, dispatcher) comes through the constructor as an interface or value. Tests and previews use fakes.
4. The composable contains no business logic. It renders state and forwards events.

## Model

Domain models are plain immutable data classes. They know nothing about Room, JSON or Compose.

```kotlin
package com.example.app.todo

import java.time.Instant

data class TodoItem(
    val id: String,
    val title: String,
    val isCompleted: Boolean,
    val createdAt: Instant,
)
```

Mapping from a network DTO or a Room entity to `TodoItem` happens in the data layer (see [repository.md](repository.md)). The ViewModel never sees a DTO.

## Repository interface and fake

```kotlin
package com.example.app.todo

import kotlinx.coroutines.flow.Flow

interface TodoRepository {
    /** Emits the current list and every subsequent change. */
    fun observeAll(): Flow<List<TodoItem>>
    suspend fun add(title: String)
    suspend fun setCompleted(id: String, completed: Boolean)
    suspend fun delete(id: String)
}
```

The fake is a real, working in-memory implementation, not a mock. It is used by unit tests and by `@Preview`s. Keep it in a `fakes` source set or a shared test-fixtures module so both can see it.

```kotlin
package com.example.app.todo

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import java.time.Instant
import java.util.UUID

class FakeTodoRepository(
    initial: List<TodoItem> = emptyList(),
) : TodoRepository {
    private val items = MutableStateFlow(initial)

    /** Set to make the next call to any suspend function throw. */
    var failure: Throwable? = null

    override fun observeAll(): Flow<List<TodoItem>> = items

    override suspend fun add(title: String) {
        failure?.let { throw it }
        items.update {
            it + TodoItem(UUID.randomUUID().toString(), title, false, Instant.now())
        }
    }

    override suspend fun setCompleted(id: String, completed: Boolean) {
        failure?.let { throw it }
        items.update { list -> list.map { if (it.id == id) it.copy(isCompleted = completed) else it } }
    }

    override suspend fun delete(id: String) {
        failure?.let { throw it }
        items.update { list -> list.filterNot { it.id == id } }
    }
}
```

## UiState

Model every screen phase explicitly. A sealed interface is the clearest when the phases are mutually exclusive; a data class with flags is acceptable when several things (list plus a banner) coexist. Here the list and a transient error can coexist, so use a data class with a nested sealed content.

```kotlin
package com.example.app.todo

import androidx.compose.runtime.Immutable

@Immutable
data class TodoUiState(
    val content: Content = Content.Loading,
    val filter: TodoFilter = TodoFilter.ALL,
    /** One-off message to show in a snackbar; null when nothing is pending. */
    val userMessage: UserMessage? = null,
) {
    @Immutable
    sealed interface Content {
        data object Loading : Content
        data object Empty : Content
        data class Success(val items: List<TodoItem>) : Content
        data class Error(val message: String) : Content
    }
}

enum class TodoFilter { ALL, ACTIVE, COMPLETED }

/** A message with an id so the UI can tell two identical messages apart. */
data class UserMessage(val id: Long, val text: String)
```

`@Immutable` tells the Compose compiler that the type never changes after construction, which lets composables taking it skip recomposition when the instance is equal. `List<TodoItem>` is an interface the compiler treats as unstable, so the annotation on the wrapper is what makes this work. See [ui/compose-state.md](ui/compose-state.md).

## ViewModel

```kotlin
package com.example.app.todo

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class TodoViewModel @Inject constructor(
    private val repository: TodoRepository,
    private val savedStateHandle: SavedStateHandle,
    @IoDispatcher private val ioDispatcher: CoroutineDispatcher,
) : ViewModel() {

    // Filter survives process death because it lives in SavedStateHandle.
    private val filter: StateFlow<TodoFilter> =
        savedStateHandle.getStateFlow(KEY_FILTER, TodoFilter.ALL)

    private val userMessage = MutableStateFlow<UserMessage?>(null)

    private val content: kotlinx.coroutines.flow.Flow<TodoUiState.Content> =
        combine(repository.observeAll(), filter) { items, filter ->
            val visible = when (filter) {
                TodoFilter.ALL -> items
                TodoFilter.ACTIVE -> items.filterNot { it.isCompleted }
                TodoFilter.COMPLETED -> items.filter { it.isCompleted }
            }
            if (visible.isEmpty()) TodoUiState.Content.Empty
            else TodoUiState.Content.Success(visible.sortedByDescending { it.createdAt })
        }
            .flowOn(ioDispatcher)
            .catch { e -> emit(TodoUiState.Content.Error(e.toUserMessage())) }

    val uiState: StateFlow<TodoUiState> =
        combine(content, filter, userMessage) { content, filter, message ->
            TodoUiState(content = content, filter = filter, userMessage = message)
        }.stateIn(
            scope = viewModelScope,
            // Keep collecting for 5 s after the last subscriber leaves so a
            // rotation does not restart the upstream query.
            started = SharingStarted.WhileSubscribed(5_000),
            initialValue = TodoUiState(),
        )

    fun setFilter(filter: TodoFilter) {
        savedStateHandle[KEY_FILTER] = filter
    }

    fun add(title: String) {
        val trimmed = title.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            runCatching { repository.add(trimmed) }
                .onFailure { showMessage(it.toUserMessage()) }
        }
    }

    fun toggle(item: TodoItem) {
        viewModelScope.launch {
            runCatching { repository.setCompleted(item.id, !item.isCompleted) }
                .onFailure { showMessage(it.toUserMessage()) }
        }
    }

    fun delete(item: TodoItem) {
        viewModelScope.launch {
            runCatching { repository.delete(item.id) }
                .onFailure { showMessage(it.toUserMessage()) }
        }
    }

    /** Called by the UI after it has shown the message. */
    fun messageShown(id: Long) {
        userMessage.update { current -> if (current?.id == id) null else current }
    }

    private fun showMessage(text: String) {
        userMessage.value = UserMessage(id = System.nanoTime(), text = text)
    }

    private companion object {
        const val KEY_FILTER = "filter"
    }
}

private fun Throwable.toUserMessage(): String {
    // runCatching catches CancellationException; rethrow so structured
    // concurrency keeps working. Never swallow it.
    if (this is CancellationException) throw this
    return when (this) {
        is java.io.IOException -> "Could not reach the server. Check your connection."
        else -> "Something went wrong."
    }
}
```

Points worth noticing:

- `stateIn` with `WhileSubscribed(5_000)` is the standard choice. `Eagerly` keeps the upstream Room query alive for the whole ViewModel lifetime; `Lazily` never stops it once started.
- `flowOn(ioDispatcher)` moves the filtering upstream off the main thread. Room already runs queries on its own executor, so for a pure Room flow the `flowOn` is optional; it matters when you do nontrivial transformation.
- `runCatching` catches `CancellationException`. The `toUserMessage` helper rethrows it. This is the single most common coroutine bug in Android code; see [error-handling.md](error-handling.md).
- `viewModelScope` is cancelled in `onCleared()`. Work that must outlive the screen (upload, sync) belongs in WorkManager or an application-scoped coroutine scope injected via DI, never in `GlobalScope`.

### Injecting dispatchers

Never hardcode `Dispatchers.IO` inside a ViewModel or repository. Provide it through DI with a qualifier so tests can substitute a `StandardTestDispatcher`.

```kotlin
package com.example.app.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import javax.inject.Qualifier

@Qualifier
@Retention(AnnotationRetention.RUNTIME)
annotation class IoDispatcher

@Qualifier
@Retention(AnnotationRetention.RUNTIME)
annotation class DefaultDispatcher

@Module
@InstallIn(SingletonComponent::class)
object DispatchersModule {
    @Provides @IoDispatcher fun io(): CoroutineDispatcher = Dispatchers.IO
    @Provides @DefaultDispatcher fun default(): CoroutineDispatcher = Dispatchers.Default
}
```

`Dispatchers.Main` is not injected; `viewModelScope` already uses `Dispatchers.Main.immediate`, and tests replace it globally with `Dispatchers.setMain` (see the test rule below).

### SavedStateHandle and process death

Android kills backgrounded processes freely. When the user returns, the Activity is recreated with its saved instance state, and a ViewModel is created fresh. Anything you want to survive goes into `SavedStateHandle`:

- Small UI inputs: selected filter, scroll position, a draft text field, the id of the item being edited.
- Not: the item list itself (reload it from the repository), bitmaps, anything over a few hundred KB. The Bundle limit is about 1 MB per transaction and exceeding it crashes with `TransactionTooLargeException`.

`savedStateHandle.getStateFlow(key, default)` returns a `StateFlow` that reads and writes the handle, so the rest of the ViewModel can treat it like any other state. Navigation arguments also arrive in `SavedStateHandle`; with type-safe routes use `savedStateHandle.toRoute<TodoDetailRoute>()` (see [navigation.md](navigation.md)).

To test process death manually: enable "Don't keep activities" in developer options, or run `adb shell am kill com.example.app` while the app is backgrounded, then reopen it from Recents.

### One-off events

Do not expose a `SharedFlow<Event>` for navigation or snackbars. A `SharedFlow` without replay drops events emitted while there is no collector, which is exactly what happens during configuration changes and when the app is in the background with a lifecycle-aware collector paused. Model one-off events as state that the UI consumes and then tells the ViewModel to clear. That is what `userMessage` plus `messageShown(id)` above does. The same pattern applies to navigation: expose `navigateToDetail: String?` in the state, navigate in a `LaunchedEffect`, then call `navigationHandled()`.

```kotlin
// Anti-pattern: events can be lost, and the collector must be manually
// scoped to the lifecycle to avoid handling them in the background.
private val _events = MutableSharedFlow<TodoEvent>()
val events: SharedFlow<TodoEvent> = _events
```

## Screen composable

Split every screen into a stateful entry composable that obtains the ViewModel and a stateless one that takes `UiState` and lambdas. Only the stateless one is previewed and UI-tested.

```kotlin
package com.example.app.todo

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.ListItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun TodoRoute(
    modifier: Modifier = Modifier,
    viewModel: TodoViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    TodoScreen(
        state = uiState,
        onAdd = viewModel::add,
        onToggle = viewModel::toggle,
        onDelete = viewModel::delete,
        onFilterChange = viewModel::setFilter,
        onMessageShown = viewModel::messageShown,
        modifier = modifier,
    )
}

@Composable
fun TodoScreen(
    state: TodoUiState,
    onAdd: (String) -> Unit,
    onToggle: (TodoItem) -> Unit,
    onDelete: (TodoItem) -> Unit,
    onFilterChange: (TodoFilter) -> Unit,
    onMessageShown: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val snackbarHostState = remember { SnackbarHostState() }

    // Consume the one-off message: show it, then tell the ViewModel it is done.
    state.userMessage?.let { message ->
        LaunchedEffect(message.id) {
            snackbarHostState.showSnackbar(message.text)
            onMessageShown(message.id)
        }
    }

    Scaffold(
        modifier = modifier,
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { innerPadding ->
        Column(Modifier.padding(innerPadding).fillMaxSize()) {
            AddTodoBar(onAdd = onAdd)
            FilterRow(selected = state.filter, onSelect = onFilterChange)
            when (val content = state.content) {
                TodoUiState.Content.Loading -> Centered { CircularProgressIndicator() }
                TodoUiState.Content.Empty -> Centered { Text("Nothing to do") }
                is TodoUiState.Content.Error -> Centered { Text(content.message) }
                is TodoUiState.Content.Success -> TodoList(
                    items = content.items,
                    onToggle = onToggle,
                    onDelete = onDelete,
                )
            }
        }
    }
}

@Composable
private fun TodoList(
    items: List<TodoItem>,
    onToggle: (TodoItem) -> Unit,
    onDelete: (TodoItem) -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize()) {
        // key is required: without it, deleting an item makes every row below
        // it recompose and lose its internal state.
        items(items, key = { it.id }) { item ->
            ListItem(
                headlineContent = { Text(item.title) },
                leadingContent = {
                    Checkbox(checked = item.isCompleted, onCheckedChange = { onToggle(item) })
                },
                trailingContent = {
                    androidx.compose.material3.TextButton(onClick = { onDelete(item) }) { Text("Delete") }
                },
            )
        }
    }
}

@Composable
private fun AddTodoBar(onAdd: (String) -> Unit) {
    // Draft text is view state; rememberSaveable keeps it across rotation.
    var draft by rememberSaveable { mutableStateOf("") }
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            label = { Text("New item") },
            modifier = Modifier.weight(1f),
            singleLine = true,
        )
        Button(onClick = { onAdd(draft); draft = "" }, modifier = Modifier.padding(start = 8.dp)) {
            Text("Add")
        }
    }
}

@Composable
private fun FilterRow(selected: TodoFilter, onSelect: (TodoFilter) -> Unit) {
    Row(Modifier.padding(horizontal = 16.dp)) {
        TodoFilter.entries.forEach { filter ->
            FilterChip(
                selected = filter == selected,
                onClick = { onSelect(filter) },
                label = { Text(filter.name.lowercase().replaceFirstChar(Char::uppercase)) },
                modifier = Modifier.padding(end = 8.dp),
            )
        }
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}
```

`collectAsStateWithLifecycle()` (from `androidx.lifecycle:lifecycle-runtime-compose`) stops collecting when the lifecycle drops below STARTED, so a backgrounded app does not keep the flow hot. Plain `collectAsState()` keeps collecting forever and is the wrong default on Android.

## Previews

Previews render the stateless composable with fake data. No ViewModel, no Hilt.

```kotlin
package com.example.app.todo

import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import com.example.app.ui.theme.AppTheme
import java.time.Instant

class TodoStateProvider : PreviewParameterProvider<TodoUiState> {
    override val values = sequenceOf(
        TodoUiState(content = TodoUiState.Content.Loading),
        TodoUiState(content = TodoUiState.Content.Empty),
        TodoUiState(content = TodoUiState.Content.Error("Could not reach the server.")),
        TodoUiState(
            content = TodoUiState.Content.Success(
                listOf(
                    TodoItem("1", "Buy groceries", false, Instant.EPOCH),
                    TodoItem("2", "Read a chapter", true, Instant.EPOCH),
                ),
            ),
        ),
    )
}

@Preview(showBackground = true)
@Composable
private fun TodoScreenPreview(@PreviewParameter(TodoStateProvider::class) state: TodoUiState) {
    AppTheme {
        TodoScreen(
            state = state,
            onAdd = {}, onToggle = {}, onDelete = {}, onFilterChange = {}, onMessageShown = {},
        )
    }
}
```

## Unit tests

Dependencies in `app/build.gradle.kts` (resolve versions from `data/versions.json` or the official release pages; do not guess):

```kotlin
testImplementation("junit:junit:4.13.2")
testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:<version>")
testImplementation("app.cash.turbine:turbine:<version>")
```

A reusable rule that swaps `Dispatchers.Main` for a test dispatcher. Every ViewModel test needs it because `viewModelScope` uses `Dispatchers.Main`.

```kotlin
package com.example.app.testing

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.rules.TestWatcher
import org.junit.runner.Description

@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(
    val dispatcher: TestDispatcher = StandardTestDispatcher(),
) : TestWatcher() {
    override fun starting(description: Description) = Dispatchers.setMain(dispatcher)
    override fun finished(description: Description) = Dispatchers.resetMain()
}
```

The tests:

```kotlin
package com.example.app.todo

import androidx.lifecycle.SavedStateHandle
import app.cash.turbine.test
import com.example.app.testing.MainDispatcherRule
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.IOException
import java.time.Instant

class TodoViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private val sample = listOf(
        TodoItem("1", "Buy groceries", false, Instant.ofEpochSecond(2)),
        TodoItem("2", "Read a chapter", true, Instant.ofEpochSecond(1)),
    )

    private fun viewModel(repo: TodoRepository = FakeTodoRepository(sample)) = TodoViewModel(
        repository = repo,
        savedStateHandle = SavedStateHandle(),
        ioDispatcher = mainDispatcherRule.dispatcher,
    )

    @Test
    fun `starts in Loading then emits Success sorted newest first`() = runTest {
        viewModel().uiState.test {
            assertEquals(TodoUiState.Content.Loading, awaitItem().content)
            val success = awaitItem().content as TodoUiState.Content.Success
            assertEquals(listOf("1", "2"), success.items.map { it.id })
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `empty repository emits Empty`() = runTest {
        viewModel(FakeTodoRepository()).uiState.test {
            awaitItem() // Loading
            assertEquals(TodoUiState.Content.Empty, awaitItem().content)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `filter ACTIVE hides completed items and survives in SavedStateHandle`() = runTest {
        val handle = SavedStateHandle()
        val vm = TodoViewModel(FakeTodoRepository(sample), handle, mainDispatcherRule.dispatcher)
        vm.uiState.test {
            awaitItem(); awaitItem()
            vm.setFilter(TodoFilter.ACTIVE)
            val state = awaitItem()
            val success = state.content as TodoUiState.Content.Success
            assertEquals(listOf("1"), success.items.map { it.id })
            assertEquals(TodoFilter.ACTIVE, handle.get<TodoFilter>("filter"))
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `add failure surfaces a user message and clears it when shown`() = runTest {
        val repo = FakeTodoRepository(sample).apply { failure = IOException("offline") }
        val vm = viewModel(repo)
        vm.uiState.test {
            awaitItem(); awaitItem()
            vm.add("Walk the dog")
            val withMessage = awaitItem()
            val message = withMessage.userMessage
            assertNotNull(message)
            assertTrue(message!!.text.contains("connection"))
            vm.messageShown(message.id)
            assertEquals(null, awaitItem().userMessage)
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun `blank title is ignored`() = runTest {
        val repo = FakeTodoRepository(sample)
        val vm = viewModel(repo)
        vm.uiState.test {
            awaitItem(); awaitItem()
            vm.add("   ")
            expectNoEvents()
            cancelAndIgnoreRemainingEvents()
        }
    }
}
```

`runTest` with a `StandardTestDispatcher` queues coroutines until the test yields; Turbine's `awaitItem()` yields, so launches inside `add()` run at the right moment. If a test hangs on `awaitItem()`, the usual cause is a dispatcher that was not routed through the rule.

## Anti-patterns

```kotlin
// Anti-pattern: multiple mutable states; the screen can observe an inconsistent mix.
val items = MutableStateFlow<List<TodoItem>>(emptyList())
val isLoading = MutableStateFlow(false)
val error = MutableStateFlow<String?>(null)

// Anti-pattern: exposing MutableStateFlow; the UI can write state.
val uiState = MutableStateFlow(TodoUiState())

// Anti-pattern: LiveData in new code.
val items: LiveData<List<TodoItem>> = repository.observeAll().asLiveData()

// Anti-pattern: hardcoded dispatcher; untestable without Robolectric tricks.
viewModelScope.launch(Dispatchers.IO) { ... }

// Anti-pattern: collectAsState keeps collecting while the app is in the background.
val state by viewModel.uiState.collectAsState()

// Anti-pattern: catching everything, including cancellation.
try { repository.add(title) } catch (e: Exception) { showError() }

// Anti-pattern: holding a Context or View in the ViewModel (leaks the Activity).
class TodoViewModel(private val context: Context) : ViewModel()
```

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "com.example.app.todo.TodoViewModelTest"
```

Both must pass before claiming the screen works. "Compiled and unit-tested" is a different claim from "verified on device"; say which one you made.

## Sources

- https://developer.android.com/topic/architecture
- https://developer.android.com/topic/architecture/ui-layer
- https://developer.android.com/topic/architecture/ui-layer/stateholders
- https://developer.android.com/topic/libraries/architecture/viewmodel
- https://developer.android.com/topic/libraries/architecture/viewmodel/viewmodel-savedstate
- https://developer.android.com/kotlin/coroutines/coroutines-best-practices
- https://developer.android.com/kotlin/flow/stateflow-and-sharedflow
- https://developer.android.com/develop/ui/compose/state
- https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-test/
