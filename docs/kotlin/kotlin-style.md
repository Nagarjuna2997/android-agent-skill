# Kotlin style for Android

The Kotlin an Android codebase should read like: types that model the domain, immutability by default, nullability handled at the edge, and names and packages a second engineer can navigate without a tour.

## Classes and types

### Data classes for values with identity by content

```kotlin
data class Note(
    val id: Long,
    val text: String,
    val createdAt: Instant,
    val tags: List<String> = emptyList(),
)
```

Use trailing commas; diffs stay one line per change. Put defaults last. Data classes get `equals`, `hashCode`, `copy` and `toString`, which Compose stability and `StateFlow` deduplication depend on. Never put a `MutableList` or `var` in a data class that reaches the UI; `equals` would lie and Compose would skip or over-recompose.

### Value classes for typed identifiers

```kotlin
@JvmInline
value class NoteId(val raw: Long)

@JvmInline
value class Email(val value: String) {
    init { require('@' in value) { "Not an email: $value" } }
}
```

A `NoteId` cannot be passed where a `UserId` is expected. No allocation at runtime in most positions.

### Sealed interfaces for closed sets

Prefer `sealed interface` over `sealed class`; a type can implement several interfaces and there is no empty base constructor.

```kotlin
sealed interface NotesUiState {
    data object Loading : NotesUiState
    data object Empty : NotesUiState
    data class Content(val notes: List<Note>) : NotesUiState
    data class Error(val message: String, val retryable: Boolean = true) : NotesUiState
}

sealed interface NotesEvent {
    data class Add(val text: String) : NotesEvent
    data class Delete(val id: NoteId) : NotesEvent
    data object Retry : NotesEvent
}
```

`when` over a sealed type is exhaustive and the compiler errors when a case is added. Use `data object` so singletons print and compare sensibly.

```kotlin
when (state) {
    NotesUiState.Loading -> LoadingIndicator()
    NotesUiState.Empty -> EmptyNotes(onAdd)
    is NotesUiState.Content -> NotesList(state.notes)
    is NotesUiState.Error -> ErrorMessage(state.message, onRetry.takeIf { state.retryable })
}
```

### Enums for fixed sets without payload

```kotlin
enum class SortOrder(val label: Int) { Newest(R.string.sort_newest), Oldest(R.string.sort_oldest) }
```

### Objects

Use `object` for genuinely stateless singletons: a Hilt module, a `Comparator`, constants grouped by topic. Do not use `object` for anything that holds mutable state or a `Context`; that is a hidden global and a leak. Companion objects hold factories and constants that belong to the class.

```kotlin
object Durations {
    val SearchDebounce: Duration = 300.milliseconds
}
```

## Nullability

Null means "absent" and nothing else. Handle it where the value enters the app (network, database, intent extras) and keep domain types non-null.

- `?.let { }` for a single transformation; `if (x != null)` when the body is more than one expression, because smart casts read better than nested lambdas.
- `?:` to supply a default or `return`/`throw` early.
- `requireNotNull(x) { "reason" }` and `checkNotNull` at construction boundaries.
- `!!` only in tests, and even there `assertNotNull` is clearer.
- `lateinit` for DI-injected fields in Android framework classes (`Activity`, `Service`) only. In your own classes use constructor injection.

```kotlin
// Anti-pattern: nullability leaks through the whole stack.
data class User(val name: String?, val email: String?)

// Map once at the boundary.
fun UserDto.toDomain(): User? {
    val name = name?.takeIf { it.isNotBlank() } ?: return null
    val email = email?.let(::Email) ?: return null
    return User(name, email)
}
```

Platform types from Java APIs (`String!`) are nullable in practice. Declare the Kotlin type explicitly on anything that crosses from Java.

## Immutability

- `val` by default. `var` only for state that genuinely changes, and then private.
- `List`, `Set`, `Map` in public signatures, never `MutableList`. Build with `buildList { }` and return the read-only type.
- Prefer `copy` over mutation. `_uiState.update { it.copy(...) }`.
- Mark collections meant for Compose parameters as `@Immutable` or use `kotlinx.collections.immutable` (`PersistentList`) when stability matters; see `docs/compose/performance.md`.

## Extension functions

Extensions belong next to the type they extend or in a file named for the purpose (`StringExt.kt`, `FlowExt.kt`). They are for making a call site read naturally, not for hiding business logic.

```kotlin
fun Throwable.toUserMessage(): String = when (this) {
    is IOException -> "Check your connection and try again."
    is HttpException -> if (code() == 404) "Not found." else "Server error ($code())."
    else -> "Something went wrong."
}

fun Modifier.conditional(condition: Boolean, block: Modifier.() -> Modifier): Modifier =
    if (condition) then(block()) else this
```

Avoid extensions on `Any` or `Context` that do unrelated things. Avoid extension properties with side effects.

## Scope functions

Pick by what the call site should read as:

| Function | Receiver | Returns | Use when |
|---|---|---|---|
| `let` | `it` | lambda result | transform a nullable, or rename `it` once |
| `run` | `this` | lambda result | compute a value from an object's members |
| `apply` | `this` | receiver | configure an object you are building |
| `also` | `it` | receiver | side effect (log, add to list) on the way through |
| `with(x)` | `this` | lambda result | several calls on one object, not as a chain |

Do not nest scope functions more than one level. Do not use `apply` to hide mutation of something you did not just create. `takeIf`/`takeUnless` for conditional pass-through.

## Functions

- Expression bodies for one-expression functions. Block bodies otherwise.
- Named arguments whenever a call has two or more arguments of the same type, or any `Boolean` argument.
- Default parameters instead of overloads.
- Return early. Deep nesting is the first thing to refactor.
- A function that suspends is named for what it does, not `suspendLoad`. A function that returns a `Flow` is `observeX()` or `xStream`; a suspend function that returns once is `getX()` or `loadX()`.
- Operator `invoke` for use cases: `class GetNotesUseCase { suspend operator fun invoke(): List<Note> }`.

## Naming

- Packages: lowercase, no underscores, by feature then layer: `com.example.app.notes.ui`, `com.example.app.notes.data`.
- Classes: `PascalCase`. Suffixes carry meaning: `ViewModel`, `Repository`, `DataSource`, `Dao`, `Entity`, `Dto`, `UseCase`, `Screen` (stateful route composable), `Content` (stateless composable body).
- Composables: `PascalCase` nouns, not verbs: `NoteCard`, not `ShowNoteCard`. Composables that return a value are `camelCase` (`rememberNoteListState`).
- Functions and properties: `camelCase`. Booleans read as predicates: `isLoading`, `hasError`, `canSubmit`.
- Constants: `const val MAX_RETRIES = 3` in a companion or top level; `val` with `PascalCase` for non-primitive constants (`val DefaultPadding = 16.dp`).
- Test names in backticks describing behavior: `` `shows error when repository fails` ``.
- Interfaces are the plain noun (`NoteRepository`); implementations say how (`RoomNoteRepository`, `FakeNoteRepository`). Never `NoteRepositoryImpl`.

## Package structure

Feature-first, layer-second. One screen's ViewModel, state and composables live together; the data layer for that feature lives beside them.

```
com.example.app
├── App.kt
├── MainActivity.kt
├── di/                  Hilt modules that bind interfaces to implementations
├── navigation/          routes and NavHost
├── ui/theme/            Theme, Color, Type
├── core/                shared helpers with no feature knowledge (dispatchers, Result)
└── notes/
    ├── data/            NoteDao, NoteEntity, RoomNoteRepository, NoteRepository (interface)
    ├── domain/          Note, use cases (only if logic is shared)
    └── ui/              NotesScreen, NotesViewModel, NotesUiState, NoteCard
```

For a multi-module app the same split becomes `:feature:notes`, `:core:data`, `:core:ui`, `:core:designsystem`; see `docs/android/app-architecture.md`.

Do not create `utils`, `misc` or `helpers` packages. Name the thing the helper helps with.

## Visibility

- `internal` for anything that should not leak out of a module.
- `private` for anything only one file needs. Top-level private functions in a composable file are normal.
- Public API of a class is the smallest set that callers use. Expose `StateFlow`, keep `MutableStateFlow` private.

## Error handling

Use the type system before exceptions. A sealed result for expected failures the UI must distinguish; exceptions for programming errors.

```kotlin
sealed interface AuthResult {
    data class Success(val session: Session) : AuthResult
    data object InvalidCredentials : AuthResult
    data object Locked : AuthResult
    data class Failure(val cause: Throwable) : AuthResult
}
```

`runCatching` is fine at a boundary if `CancellationException` is rethrown (see `docs/kotlin/coroutines-and-flow.md`). Never catch `Throwable`; it includes `OutOfMemoryError`.

## KDoc

Document public types and functions that a caller cannot understand from the signature. Say what, when and why; not how. Document units and threading.

```kotlin
/**
 * Stores notes locally and keeps them in sync with the server.
 *
 * All functions are main-safe. [observeNotes] emits the local cache immediately and again on every change.
 *
 * @throws IOException from [refresh] when the server is unreachable; the cache is left intact.
 */
interface NoteRepository {
    fun observeNotes(): Flow<List<Note>>
    suspend fun refresh()
    suspend fun add(text: String): NoteId
}
```

Skip KDoc on private members and on obvious properties. A comment that repeats the name is noise.

## Formatting

Follow the official Kotlin style guide: four-space indent, 100 or 120 column limit chosen once per project, trailing commas on multi-line declarations and calls, imports sorted without wildcards (`import androidx.compose.material3.*` hides what a file uses and breaks when the BOM adds a name). Configure it in `.editorconfig` and enforce with ktlint or detekt in CI.

```
[*.{kt,kts}]
indent_size = 4
max_line_length = 120
ij_kotlin_allow_trailing_comma = true
ij_kotlin_allow_trailing_comma_on_call_site = true
```

## Verify

```sh
./gradlew :app:ktlintCheck      # if ktlint-gradle is applied
./gradlew :app:detekt           # if detekt is applied
./gradlew :app:compileDebugKotlin -Pkotlin.compiler.allWarningsAsErrors=true
```

Treat compiler warnings in touched files as errors: unused variables, unchecked casts and redundant nullability checks are usually real.

## Sources

- https://kotlinlang.org/docs/coding-conventions.html
- https://kotlinlang.org/docs/idioms.html
- https://kotlinlang.org/docs/sealed-classes.html
- https://kotlinlang.org/docs/inline-classes.html
- https://kotlinlang.org/docs/null-safety.html
- https://kotlinlang.org/docs/kotlin-doc.html
- https://developer.android.com/kotlin/style-guide
- https://developer.android.com/develop/ui/compose/api-guidelines
