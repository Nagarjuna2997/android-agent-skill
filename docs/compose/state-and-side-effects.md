# Compose state and side effects

Composables are functions that describe UI from state and can be re-run at any time. Anything that is not a pure description (starting a coroutine, registering a listener, talking to the system) is a side effect and must go through one of the effect APIs so Compose can start, restart and clean it up correctly.

## The mental model

- Recomposition re-executes a composable when state it read has changed. It can happen many times, in any order, and can be skipped or cancelled.
- Code in the body of a composable runs on every recomposition. Code inside an effect runs only when the effect's keys change.
- Every effect is tied to the composition: it starts when the composable enters, is cleaned up when it leaves, and restarts when its keys change.

```kotlin
// Anti-pattern: runs on every recomposition and leaks a coroutine each time.
@Composable
fun Bad(viewModel: NotesViewModel) {
    viewModel.viewModelScope.launch { viewModel.load() }
}
```

## State in composables

`remember` keeps a value across recompositions; `rememberSaveable` also keeps it across configuration changes and process death (for types `Bundle` can hold, or with a `Saver`).

```kotlin
var query by rememberSaveable { mutableStateOf("") }
val listState = rememberLazyListState()
val visibleItems by remember { derivedStateOf { listState.layoutInfo.visibleItemsInfo.size } }
```

`derivedStateOf` is for a computed value that changes less often than its inputs, so readers recompose only when the derived value changes. Do not use it for a cheap `a + b`; the overhead exceeds the benefit.

Hoist state: a composable either owns a piece of state and passes it down with a change lambda, or receives it. A screen-level composable takes `uiState` and lambdas; it does not create a ViewModel. Only the route-level wrapper calls `hiltViewModel()`.

```kotlin
@Composable
fun NotesRoute(viewModel: NotesViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    NotesScreen(uiState = uiState, onEvent = viewModel::onEvent)
}

@Composable
fun NotesScreen(uiState: NotesUiState, onEvent: (NotesEvent) -> Unit, modifier: Modifier = Modifier) { /* ... */ }
```

## LaunchedEffect

Runs a suspend block in a coroutine scoped to the composition. Cancelled when the composable leaves or when a key changes, then restarted with the new keys.

```kotlin
@Composable
fun NoteDetail(noteId: NoteId, viewModel: NoteDetailViewModel) {
    LaunchedEffect(noteId) {
        viewModel.load(noteId)
    }
}
```

Showing a snackbar from state:

```kotlin
@Composable
fun NotesScreen(uiState: NotesUiState, onErrorShown: () -> Unit) {
    val snackbarHostState = remember { SnackbarHostState() }
    val error = (uiState as? NotesUiState.Content)?.transientError

    LaunchedEffect(error) {
        if (error != null) {
            snackbarHostState.showSnackbar(error)
            onErrorShown()
        }
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { /* ... */ }
}
```

The message lives in state until the UI acknowledges it with `onErrorShown()`. This survives rotation and does not drop messages, unlike a `SharedFlow` of events.

Key choice:
- `LaunchedEffect(Unit)` or `LaunchedEffect(true)`: once per composition entry. Acceptable for a one-time trigger such as requesting focus, but ask whether the work belongs in the ViewModel's `init` instead.
- Keys are the inputs the effect reads. If the block reads `noteId`, `noteId` must be a key, or the effect will keep using a stale value.
- To read a frequently changing value without restarting, wrap it in `rememberUpdatedState` (below).

## rememberCoroutineScope

A scope tied to the composition for work started by an event handler, not by composition itself.

```kotlin
val scope = rememberCoroutineScope()
val listState = rememberLazyListState()

FloatingActionButton(onClick = { scope.launch { listState.animateScrollToItem(0) } }) {
    Icon(Icons.Default.ArrowUpward, contentDescription = stringResource(R.string.scroll_to_top))
}
```

The scope cancels when the composable leaves. Do not launch from this scope during composition; that is what `LaunchedEffect` is for. Do not launch business logic here; call the ViewModel and let `viewModelScope` own it.

## DisposableEffect

For effects that need explicit cleanup: listeners, observers, system callbacks.

```kotlin
@Composable
fun LifecycleLogger(lifecycleOwner: LifecycleOwner = LocalLifecycleOwner.current) {
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> Log.d("Lifecycle", event.name) }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
}
```

`onDispose` must be the last statement. It runs when the keys change (before the effect re-runs) and when the composable leaves.

Keep the screen on while a video plays:

```kotlin
@Composable
fun KeepScreenOn() {
    val view = LocalView.current
    DisposableEffect(view) {
        view.keepScreenOn = true
        onDispose { view.keepScreenOn = false }
    }
}
```

## SideEffect

Runs after every successful recomposition, without a coroutine. Use it to push Compose state into a non-Compose object that must see every value.

```kotlin
@Composable
fun AnalyticsScreen(screenName: String, analytics: Analytics) {
    SideEffect { analytics.setCurrentScreen(screenName) }
}
```

Rare. If you reach for it to start work, you want `LaunchedEffect`.

## rememberUpdatedState

Captures the latest value of a parameter inside a long-lived effect whose keys you deliberately do not want to include.

```kotlin
@Composable
fun AutoDismiss(timeoutMillis: Long, onDismiss: () -> Unit) {
    val currentOnDismiss by rememberUpdatedState(onDismiss)
    LaunchedEffect(timeoutMillis) {
        delay(timeoutMillis)
        currentOnDismiss()
    }
}
```

Without it, a new `onDismiss` lambda (which is created on every recomposition of the caller) would either restart the timer if used as a key, or call a stale lambda if not.

## produceState

Turns a non-Compose source into `State<T>`, running a producer coroutine scoped to the composition.

```kotlin
@Composable
fun rememberImageBitmap(url: String, loader: ImageLoader): State<Result<ImageBitmap>?> =
    produceState<Result<ImageBitmap>?>(initialValue = null, url) {
        value = runCatching { loader.load(url) }
    }
```

Inside the producer, `awaitDispose { }` is available when the source needs cleanup. For a `Flow`, `collectAsStateWithLifecycle` is the right tool instead; `produceState` is for callback-style or suspend-once sources.

## snapshotFlow

Converts Compose state into a `Flow`, so you can apply Flow operators to UI state and react in a coroutine.

```kotlin
val listState = rememberLazyListState()

LaunchedEffect(listState) {
    snapshotFlow { listState.firstVisibleItemIndex }
        .map { it > 0 }
        .distinctUntilChanged()
        .collect { showScrollToTop -> viewModel.onScrollToTopVisibilityChanged(showScrollToTop) }
}
```

Paging a list when the user nears the end:

```kotlin
LaunchedEffect(listState) {
    snapshotFlow {
        val layout = listState.layoutInfo
        layout.visibleItemsInfo.lastOrNull()?.index to layout.totalItemsCount
    }
        .distinctUntilChanged()
        .filter { (last, total) -> last != null && last >= total - 5 }
        .collect { viewModel.loadMore() }
}
```

`snapshotFlow` emits only when the result of the block changes (`equals`), so wrap the state reads in it rather than reading outside and passing values in.

## Keys and identity

In lazy lists, give each item a stable `key` so state (`remember`, animations, scroll position) follows the item through inserts, removes and reorders:

```kotlin
LazyColumn {
    items(items = notes, key = { it.id.raw }, contentType = { "note" }) { note ->
        NoteCard(note)
    }
}
```

Outside lazy lists, `key(id) { }` does the same for a composable whose identity should follow data rather than position:

```kotlin
for (note in notes) {
    key(note.id) { NoteCard(note) }
}
```

Without keys, Compose matches by position: deleting the first item hands every card the next item's state.

## Sample-derived examples

Three cases from JetNews and Jetchat in `android/compose-samples` ([../../references/compose-samples.md](../../references/compose-samples.md)) that extend the sections above.

### A queue of messages, one snackbar at a time, with a retry action

The snackbar example earlier handles one transient error. When the ViewModel can accumulate several (a refresh failed and a toggle failed), keep a `List<UiMessage>` in `UiState`, show only the head, and acknowledge it by id. Both lambdas go through `rememberUpdatedState` so a recomposition of the caller does not restart the running effect, and the effect is keyed on the resolved text so a new message with the same id but different text still shows.

```kotlin
data class UiMessage(val id: Long, @StringRes val textRes: Int, val retryable: Boolean)

@Composable
fun MessageHost(messages: List<UiMessage>, onRetry: () -> Unit, onShown: (Long) -> Unit, hostState: SnackbarHostState) {
    val message = messages.firstOrNull() ?: return
    val text = stringResource(message.textRes)
    val retryLabel = stringResource(R.string.retry)
    val currentOnRetry by rememberUpdatedState(onRetry)
    val currentOnShown by rememberUpdatedState(onShown)

    // Technique from android/compose-samples JetNews (Apache-2.0): one effect per message text;
    // the next message starts a new effect only after the ViewModel removes this one.
    LaunchedEffect(text, hostState) {
        val result = hostState.showSnackbar(
            message = text,
            actionLabel = if (message.retryable) retryLabel else null,
        )
        if (result == SnackbarResult.ActionPerformed) currentOnRetry()
        currentOnShown(message.id)
    }
}
```

In the ViewModel, `onShown(id)` removes the message from the list and `nextMessageId` is a counter, so two identical errors in a row are two entries and both get shown.

### Persisting scroll position through snapshotFlow with debounce

The earlier `snapshotFlow` examples derive a Boolean. To store the position itself (so the ViewModel can restore it after process death, or hand it to a second pane), emit the pair, debounce so the ViewModel is not written on every pixel, and use `collectLatest`:

```kotlin
@OptIn(FlowPreview::class)
LaunchedEffect(listState) {
    snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
        .debounce(50)
        .collectLatest { (index, offset) -> viewModel.onScrolled(index, offset) }
}
```

Restore with `rememberLazyListState(initialFirstVisibleItemIndex = uiState.index, initialFirstVisibleItemScrollOffset = uiState.offset)`; the initial values are only read when the state object is created, which is exactly once per composition entry.

### rememberUpdatedState inside a remember block

`remember(keys) { }` caches an object that may capture a lambda. If the lambda is not a key, the cached object calls a stale lambda; if it is a key, the cache is useless because lambdas are new on every recomposition. Jetchat's message formatter resolves this by reading a `rememberUpdatedState` holder inside the cached object:

```kotlin
@Composable
fun rememberFormattedMessage(text: String, onMentionClick: (String) -> Unit): AnnotatedString {
    val currentOnMentionClick by rememberUpdatedState(onMentionClick)
    return remember(text) {
        buildAnnotatedString {
            // ... for each @mention:
            withLink(LinkAnnotation.Clickable("mention") { currentOnMentionClick(name) }) { append(name) }
        }
    }
}
```

The same shape applies to any cached listener: a `remember`ed `WebViewClient`, a `DisposableEffect`-registered callback, a `NestedScrollConnection` that reports to the ViewModel.

## Effect pitfalls

- Reading state in the effect body but not listing it as a key. The effect runs with the first value forever. Either add the key or use `rememberUpdatedState`.
- Using a lambda as a key. Lambdas that capture state are new objects on each recomposition, so the effect restarts every time. Use `rememberUpdatedState` for the lambda and key on the data.
- `LaunchedEffect(Unit)` that loads data. Rotation keeps the ViewModel but recreates the composition, so the load runs again. Load in the ViewModel (`init` or `stateIn`), not in the UI.
- Mutating state during composition (`count++` in the body). Causes an infinite recomposition loop or a crash. Mutate in event handlers or effects.
- Creating objects in composition without `remember` (`SnackbarHostState()`, `Paint()`, a `Regex`). Allocated on every recomposition and the previous instance's state is lost.
- Calling `viewModel.uiState.value` in composition. Reads once, never recomposes. Use `collectAsStateWithLifecycle()`.
- `collectAsState()` on Android. Keeps collecting in the background. Use `collectAsStateWithLifecycle()` from `androidx.lifecycle.compose`.
- Navigating inside composition (`navController.navigate(...)` in the body). Fires on every recomposition. Navigate from an event handler or a `LaunchedEffect` keyed on the state that requested it, then clear that state.
- `DisposableEffect` without `onDispose`. The compiler rejects it; the fix is to add real cleanup, not an empty block.
- Forgetting that `rememberSaveable` needs a `Saver` for non-`Bundle` types. Use `listSaver` or `mapSaver`, or save only the primitive id and re-derive.

## Verify

Lint catches most misuse. These checks must be clean in touched files:

```sh
./gradlew :app:lintDebug
```

Look for `CoroutineCreationDuringComposition`, `FlowOperatorInvokedInComposition`, `StateFlowValueCalledInComposition`, `RememberReturnType`, `UnrememberedMutableState`, `ComposableNaming`, `FrequentlyChangedStateReadInComposition`.

Then a Compose UI test for any effect-driven behavior, for example that a snackbar appears once when the error state is set and does not reappear after `onErrorShown`:

```sh
./gradlew :app:connectedDebugAndroidTest
```

## Sources

- https://developer.android.com/develop/ui/compose/side-effects
- https://developer.android.com/develop/ui/compose/state
- https://developer.android.com/develop/ui/compose/state-hoisting
- https://developer.android.com/develop/ui/compose/lifecycle
- https://developer.android.com/develop/ui/compose/lists
- https://developer.android.com/topic/libraries/architecture/coroutines
- https://developer.android.com/develop/ui/compose/text/user-interactions
- https://github.com/android/compose-samples (JetNews, Jetchat; see [../../references/compose-samples.md](../../references/compose-samples.md))
