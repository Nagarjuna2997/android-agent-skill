# Compose State

How state flows through composables, which composables own state and which do not, and how the Compose compiler decides what to skip. Getting this right is the difference between a screen that recomposes a few nodes per frame and one that recomposes everything.

## Stateless vs stateful composables

A stateful composable owns state with `remember`. A stateless composable receives state and callbacks as parameters. Build the stateless one first; wrap it in a stateful one only when callers should not care about the state.

```kotlin
// Stateless: fully controlled by the caller, previewable in every state, testable.
@Composable
fun QuantityStepper(
    value: Int,
    onValueChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
    range: IntRange = 0..99,
) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { onValueChange(value - 1) }, enabled = value > range.first) {
            Icon(Icons.Filled.Remove, contentDescription = "Decrease")
        }
        Text("$value", modifier = Modifier.widthIn(min = 32.dp), textAlign = TextAlign.Center)
        IconButton(onClick = { onValueChange(value + 1) }, enabled = value < range.last) {
            Icon(Icons.Filled.Add, contentDescription = "Increase")
        }
    }
}

// Stateful wrapper for callers that just want a self-contained widget.
@Composable
fun QuantityStepper(initial: Int = 0, modifier: Modifier = Modifier) {
    var value by rememberSaveable { mutableStateOf(initial) }
    QuantityStepper(value = value, onValueChange = { value = it }, modifier = modifier)
}
```

The stateless version is the one a form screen uses, because the form's ViewModel owns the quantity. The stateful version is for a demo or a settings row where nothing else needs the value.

## State hoisting

Hoist state to the lowest common ancestor of every composable that reads or writes it. Lower than that and two siblings cannot share it; higher than that and unrelated parents recompose.

```
Screen (ViewModel owns `query`, `results`)
 ├── SearchBar(query, onQueryChange)          reads+writes query
 └── ResultsList(results, onItemClick)         reads results
```

`query` is hoisted to the ViewModel because the results depend on it. The text field's cursor position and selection, however, stay inside `SearchBar` because nothing else cares.

Rule of thumb for where state lives:

| State | Owner |
|---|---|
| Business data, anything that comes from a repository | ViewModel (`UiState`) |
| Transient UI input the ViewModel acts on (query, draft) | ViewModel, or `rememberSaveable` in the screen if it is discarded on leave |
| Pure UI state (expanded/collapsed, scroll position, dialog visible) | `rememberSaveable` in the composable |
| Ephemeral animation state | `remember` |

## remember and rememberSaveable

`remember` keeps a value across recompositions of the same composable instance. It is lost when the composable leaves the composition, on configuration change, and on process death.

`rememberSaveable` additionally writes the value into the Activity's saved instance state, so it survives rotation and process death. It handles primitives, `String`, `Parcelable` and `Serializable`; anything else needs a `Saver`.

```kotlin
// Survives rotation.
var expanded by rememberSaveable { mutableStateOf(false) }

// Custom Saver for a non-Parcelable type.
data class DateRange(val start: LocalDate, val end: LocalDate)

val DateRangeSaver = listSaver<DateRange, Long>(
    save = { listOf(it.start.toEpochDay(), it.end.toEpochDay()) },
    restore = { DateRange(LocalDate.ofEpochDay(it[0]), LocalDate.ofEpochDay(it[1])) },
)
var range by rememberSaveable(stateSaver = DateRangeSaver) { mutableStateOf(DateRange(today, today)) }

// Lazy list scroll position already uses rememberSaveable internally.
val listState = rememberLazyListState()
```

The `key` parameters matter: `remember(id) { ... }` recomputes when `id` changes. Forgetting the key is the classic "the detail screen shows the previous item" bug.

```kotlin
// Anti-pattern: computed once, never updated when `item` changes.
val formattedDate = remember { formatter.format(item.createdAt) }

// Correct: keyed on the input.
val formattedDate = remember(item.createdAt) { formatter.format(item.createdAt) }
```

## derivedStateOf

Use `derivedStateOf` when a value is computed from state that changes often but the result changes rarely. It caches and only notifies readers when the derived result actually changes.

```kotlin
val listState = rememberLazyListState()

// firstVisibleItemIndex changes on every scrolled pixel; showButton only flips at index 0/1.
val showScrollToTop by remember {
    derivedStateOf { listState.firstVisibleItemIndex > 0 }
}

AnimatedVisibility(visible = showScrollToTop) { ScrollToTopButton(...) }
```

Do not use it for cheap transformations of parameters that already change together with the result; that just adds overhead.

```kotlin
// Anti-pattern: `items` is a parameter, not state; derivedStateOf gains nothing and
// its remember has no key, so it never updates.
val count by remember { derivedStateOf { items.size } }

// Correct: plain expression.
val count = items.size
```

## Stability and skipping

The Compose compiler can skip recomposing a composable when all its parameters are equal to last time, but only if it can prove the parameters are stable: it knows equality is meaningful and the value cannot change behind its back.

Stable by inference: primitives, `String`, function types, data classes whose properties are all `val` of stable types, enums, and types from modules compiled with the Compose compiler that pass the check.

Not stable by inference: `List`, `Map`, `Set` (interfaces; the implementation might be mutable), classes with `var` properties, classes from modules without the Compose compiler (including most of the JDK and third-party models), and `Any`.

Tell the compiler when it cannot infer:

```kotlin
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable

// Every property is val and the List is never mutated after construction.
@Immutable
data class TodoUiState(val items: List<TodoItem>, val filter: TodoFilter)

// Has mutable internals, but changes are observable via snapshot state, so Compose
// will be notified. Use for holder classes that wrap MutableState.
@Stable
class ScrollController {
    var offset by mutableStateOf(0f)
        private set
    fun scrollTo(value: Float) { offset = value }
}
```

`@Immutable` is a promise. If you annotate a class that holds a `MutableList` and then mutate it, Compose will not recompose and the UI will be stale. Prefer `kotlinx.collections.immutable` (`ImmutableList`, `persistentListOf()`) when a module's models are shared with non-Compose code and you want the compiler to infer stability without annotations.

For third-party or multi-module types you cannot annotate, add a stability configuration file:

```
# app/compose_compiler_config.conf
java.time.Instant
java.time.LocalDate
com.example.app.domain.*
```

```kotlin
// app/build.gradle.kts
composeCompiler {
    stabilityConfigurationFiles.add(rootProject.layout.projectDirectory.file("compose_compiler_config.conf"))
}
```

Check what the compiler inferred with the compiler reports:

```kotlin
composeCompiler {
    reportsDestination = layout.buildDirectory.dir("compose_reports")
    metricsDestination = layout.buildDirectory.dir("compose_metrics")
}
```

`build/compose_reports/<module>-classes.txt` lists each class as `stable` or `unstable`, and `-composables.txt` shows which composables are `skippable` and `restartable`. Strong skipping mode is on by default since Kotlin 2.0.20, which lets composables with unstable parameters still skip when the instances are referentially equal; it reduces but does not remove the need for stable types, because a new `List` instance from `map` is a different reference every time.

## Lambdas and recomposition

A lambda that captures nothing unstable is stable; Compose memoizes it. A lambda that captures an unstable value (a `List`, an unstable ViewModel from another module) is recreated on every recomposition, which defeats skipping in the child that receives it.

```kotlin
// Potentially unstable: captures `items` (a List).
Button(onClick = { onSelect(items.first()) })

// Stable: capture only stable values or hoist the logic.
Button(onClick = { onSelectFirst() })
```

With strong skipping, lambdas are memoized unless they capture an unstable value whose reference changed; the practical rule is to pass method references (`viewModel::toggle`) or lambdas that capture ids and primitives, not collections.

`rememberUpdatedState` is for a different problem: a long-lived effect that must call the latest lambda without restarting.

```kotlin
@Composable
fun AutoDismiss(onDismiss: () -> Unit) {
    val currentOnDismiss by rememberUpdatedState(onDismiss)
    LaunchedEffect(Unit) {         // runs once
        delay(3_000)
        currentOnDismiss()         // but calls the latest lambda
    }
}
```

## Snapshot state in lists

`mutableStateListOf()` and `mutableStateMapOf()` are observable collections: adding or removing an element triggers recomposition of readers. A `MutableList` inside a `mutableStateOf` is not; the state only notices when you assign a new list.

```kotlin
// Anti-pattern: mutation is invisible to Compose.
var selected by remember { mutableStateOf(mutableListOf<String>()) }
selected.add(id)                       // no recomposition

// Correct, option A: observable collection.
val selected = remember { mutableStateListOf<String>() }
selected.add(id)                       // recomposes readers

// Correct, option B: immutable value, reassign.
var selected by remember { mutableStateOf(setOf<String>()) }
selected = selected + id
```

Option B composes better with `rememberSaveable` and with ViewModel-owned state. Option A is for purely local UI collections.

In a `LazyColumn`, always provide `key`:

```kotlin
LazyColumn {
    items(items = todos, key = { it.id }, contentType = { "todo" }) { todo ->
        TodoRow(todo, onToggle = { onToggle(todo.id) })
    }
}
```

Without `key`, Compose identifies items by position: removing item 3 recomposes items 4 through N and resets their `remember`ed state (a swipe offset, an expanded flag). With `key`, removed items leave and the rest keep their state and skip. `contentType` lets the list reuse compositions across items of the same shape; set it when the list mixes headers and rows.

## Side effects

State changes belong in event handlers and ViewModels. When a composable must do something non-UI in response to state (show a snackbar, start an animation, register a listener), use an effect and key it correctly.

```kotlin
// Runs when `messageId` changes, cancelled when it changes again or the composable leaves.
LaunchedEffect(messageId) { snackbarHostState.showSnackbar(text) }

// Acquire/release around the composable's lifetime.
DisposableEffect(lifecycleOwner) {
    val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) refresh() }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
}

// Anti-pattern: side effect in composition; runs on every recomposition.
@Composable fun Screen(vm: VM) { vm.load(); ... }
```

A `LaunchedEffect(Unit)` that calls `viewModel.load()` is a smell: the ViewModel should start loading in `init` or on first `stateIn` subscription, so a recomposition or navigation back does not reload.

## Reading state at the right level

Compose recomposes the nearest restartable scope that read a state object. Reading state as late as possible (in a lambda passed to a modifier, or in a `drawBehind` block) moves the invalidation to the layout or draw phase and avoids recomposition entirely.

```kotlin
// Recomposes the whole Box on every scroll frame.
Box(Modifier.offset(y = scrollOffset.dp))

// Reads scrollOffset in the layout phase only; no recomposition.
Box(Modifier.offset { IntOffset(0, scrollOffset.roundToInt()) })

// Reads color in the draw phase only.
Box(Modifier.drawBehind { drawRect(animatedColor) })
```

## Avoid

```kotlin
// Anti-pattern: ViewModel exposes MutableState; UI mutates it.
class VM : ViewModel() { val query = mutableStateOf("") }

// Anti-pattern: remember without keys for something that depends on a parameter.
val sorted = remember { items.sortedBy { it.name } }

// Anti-pattern: passing the ViewModel into a leaf composable; nothing below is skippable
// and the leaf cannot be previewed.
@Composable fun TodoRow(viewModel: TodoViewModel, id: String)

// Anti-pattern: LazyColumn without keys.
items(todos) { TodoRow(it) }

// Anti-pattern: business logic in the composable.
val total = items.filter { !it.refunded }.sumOf { it.price * (1 - discount) }
```

## Verify

```sh
./gradlew :app:assembleDebug
# Then inspect build/compose_reports/*-composables.txt: every screen-level composable
# should be "restartable skippable"; search for "unstable" in *-classes.txt.
```

In Android Studio, enable Layout Inspector's recomposition counts and scroll the list: row counts should stay flat while scrolling and increase by one per row only on data changes.

## Sources

- https://developer.android.com/develop/ui/compose/state
- https://developer.android.com/develop/ui/compose/state-hoisting
- https://developer.android.com/develop/ui/compose/state-saving
- https://developer.android.com/develop/ui/compose/side-effects
- https://developer.android.com/develop/ui/compose/performance/stability
- https://developer.android.com/develop/ui/compose/performance/stability/fix
- https://developer.android.com/develop/ui/compose/performance/stability/diagnose
- https://developer.android.com/develop/ui/compose/lists
- https://developer.android.com/develop/ui/compose/phases
