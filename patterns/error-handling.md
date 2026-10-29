# Error Handling

Errors cross three boundaries in an Android app: from a transport library into the repository, from the repository into the ViewModel, and from the ViewModel into something the user can read. Each boundary converts to a narrower, more meaningful type. This file defines those types and the rules for coroutines, retries and logging.

## The Result type

Use a sealed type from `:core:common`, not `kotlin.Result`. `kotlin.Result` carries `Throwable`, which forces every caller to inspect exception classes; a sealed error type gives callers a closed, exhaustive set.

```kotlin
package com.example.app.core.common

sealed interface Result<out T> {
    data class Success<T>(val value: T) : Result<T>
    data class Failure(val error: AppError) : Result<Nothing>
}

sealed interface AppError {
    /** No connectivity, DNS failure, timeout. Retryable. */
    data class Network(val cause: Throwable) : AppError
    /** 5xx. Retryable with backoff. */
    data class Server(val code: Int) : AppError
    /** 401/403. Not retryable; requires re-auth. */
    data object Unauthorized : AppError
    /** 404 on a resource the app expected. */
    data object NotFound : AppError
    /** Other 4xx. Not retryable. */
    data class Http(val code: Int) : AppError
    /** Response could not be parsed. A bug on one side; not retryable. */
    data class Serialization(val cause: Throwable) : AppError
    /** A rule the domain enforces (quota, invalid state). */
    data class Domain(val reason: DomainReason) : AppError
    /** Anything else. Logged, shown generically. */
    data class Unknown(val cause: Throwable) : AppError
}

enum class DomainReason { QuotaExceeded, AlreadyExists, InvalidInput }

inline fun <T, R> Result<T>.map(transform: (T) -> R): Result<R> = when (this) {
    is Result.Success -> Result.Success(transform(value))
    is Result.Failure -> this
}

inline fun <T> Result<T>.onFailure(block: (AppError) -> Unit): Result<T> {
    if (this is Result.Failure) block(error)
    return this
}

fun <T> Result<T>.getOrNull(): T? = (this as? Result.Success)?.value

val AppError.isRetryable: Boolean
    get() = this is AppError.Network || this is AppError.Server
```

Keep the error set small. Each case must mean something different to a caller: different retry policy, different user message, or different recovery action. If two cases would be handled identically everywhere, merge them.

## Mapping at the repository boundary

The repository is the only place that sees `IOException`, `HttpException`, `SerializationException` or `SQLiteException`. It converts them once.

```kotlin
package com.example.app.core.common

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import retrofit2.HttpException
import java.io.IOException

/**
 * Runs [block] and maps thrown exceptions to [AppError].
 * CancellationException is always rethrown so structured concurrency keeps working.
 */
suspend inline fun <T> runCatchingApp(crossinline block: suspend () -> T): Result<T> =
    try {
        Result.Success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        Result.Failure(e.toAppError())
    }

fun Throwable.toAppError(): AppError = when (this) {
    is IOException -> AppError.Network(this)
    is HttpException -> when (code()) {
        401, 403 -> AppError.Unauthorized
        404 -> AppError.NotFound
        in 500..599 -> AppError.Server(code())
        else -> AppError.Http(code())
    }
    is SerializationException -> AppError.Serialization(this)
    is DomainException -> AppError.Domain(reason)
    else -> AppError.Unknown(this)
}

class DomainException(val reason: DomainReason) : RuntimeException(reason.name)
```

Usage inside a repository:

```kotlin
override suspend fun refresh(): Result<Unit> = withContext(io) {
    runCatchingApp {
        val remote = api.list()
        dao.applyServerSnapshot(remote.map(TodoDto::toEntity))
    }
}
```

Catching `Throwable` rather than `Exception` is deliberate here so an `OutOfMemoryError` from a giant response surfaces as `Unknown` rather than crashing silently in a worker. If you prefer to let `Error` subclasses crash, catch `Exception` instead; either is defensible, pick one and be consistent.

## CancellationException

`kotlinx.coroutines` cancels a coroutine by throwing `CancellationException` at the next suspension point. Any `catch (e: Exception)` or `runCatching { }` swallows it, which leaves the coroutine running after its scope was cancelled: a leaked network call, a ViewModel updating state after `onCleared`, a test that never finishes.

```kotlin
// Anti-pattern: swallows cancellation.
try {
    repository.add(title)
} catch (e: Exception) {
    showError(e)
}

// Anti-pattern: kotlin.runCatching also catches CancellationException.
runCatching { repository.add(title) }.onFailure { showError(it) }

// Correct: rethrow cancellation first.
try {
    repository.add(title)
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    showError(e)
}
```

If you use `kotlin.runCatching` anywhere, wrap it:

```kotlin
inline fun <T> runCatchingCancellable(block: () -> T): kotlin.Result<T> =
    runCatching(block).onFailure { if (it is CancellationException) throw it }
```

Also note that `withTimeout` throws `TimeoutCancellationException`, a subclass of `CancellationException`. When a timeout is a real failure for the caller, catch `TimeoutCancellationException` specifically and convert it; let other cancellation through.

## Flows

A `Flow` that throws terminates. Catch and emit a state instead:

```kotlin
val uiState: StateFlow<FeedUiState> = repository.observeFeed()
    .map<List<Post>, FeedUiState> { FeedUiState.Loaded(it) }
    .catch { e ->
        if (e is CancellationException) throw e
        emit(FeedUiState.Error(e.toAppError()))
    }
    .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), FeedUiState.Loading)
```

`catch` only handles upstream exceptions; an exception thrown by the collector (the UI) is not caught here and should not be. Note that after `catch` emits, the flow is complete; the UI stays on the error state until the user triggers a reload, which recreates the flow (for example by keying on a `retryCount` state).

```kotlin
private val retry = MutableStateFlow(0)
val uiState = retry.flatMapLatest { repository.observeFeed().map(...).catch(...) }
    .stateIn(...)
fun retry() { retry.update { it + 1 } }
```

## Retry with exponential backoff

Retry only retryable errors, with jitter, bounded attempts, and cancellation respected.

```kotlin
package com.example.app.core.common

import kotlinx.coroutines.delay
import kotlin.random.Random
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

suspend fun <T> retryWithBackoff(
    maxAttempts: Int = 3,
    initialDelay: Duration = 500.milliseconds,
    maxDelay: Duration = 8.seconds,
    factor: Double = 2.0,
    shouldRetry: (AppError) -> Boolean = { it.isRetryable },
    block: suspend () -> Result<T>,
): Result<T> {
    var delayMs = initialDelay.inWholeMilliseconds
    var last: Result<T>
    repeat(maxAttempts - 1) {
        last = block()
        if (last is Result.Success) return last
        val error = (last as Result.Failure).error
        if (!shouldRetry(error)) return last
        val jitter = Random.nextLong(0, delayMs / 2 + 1)
        delay(delayMs + jitter)              // suspends; honors cancellation
        delayMs = (delayMs * factor).toLong().coerceAtMost(maxDelay.inWholeMilliseconds)
    }
    return block()
}
```

Use it for interactive calls (a pull-to-refresh, a submit button) where the user is waiting. For background pushes use WorkManager's `Result.retry()` with `BackoffPolicy.EXPONENTIAL`, which survives process death; do not reimplement backoff inside a worker.

Never retry on `Unauthorized` (it will not fix itself), `Http` 4xx (the request is wrong), or `Serialization`. Retrying a non-idempotent POST can duplicate an order; add an idempotency key header or retry only GETs and PUTs.

## User-facing error state

The ViewModel converts `AppError` into something displayable. Keep the mapping in one place, and prefer string resource ids over raw strings so the ViewModel stays free of `Context`.

```kotlin
package com.example.app.core.ui

import androidx.annotation.StringRes
import com.example.app.core.common.AppError

data class ErrorPresentation(
    @StringRes val message: Int,
    val canRetry: Boolean,
    val action: ErrorAction = ErrorAction.None,
)

enum class ErrorAction { None, SignIn, OpenSettings }

fun AppError.toPresentation(): ErrorPresentation = when (this) {
    is AppError.Network -> ErrorPresentation(R.string.error_network, canRetry = true)
    is AppError.Server -> ErrorPresentation(R.string.error_server, canRetry = true)
    AppError.Unauthorized -> ErrorPresentation(R.string.error_unauthorized, canRetry = false, action = ErrorAction.SignIn)
    AppError.NotFound -> ErrorPresentation(R.string.error_not_found, canRetry = false)
    is AppError.Http, is AppError.Serialization, is AppError.Unknown ->
        ErrorPresentation(R.string.error_generic, canRetry = true)
    is AppError.Domain -> when (reason) {
        DomainReason.QuotaExceeded -> ErrorPresentation(R.string.error_quota, canRetry = false)
        DomainReason.AlreadyExists -> ErrorPresentation(R.string.error_exists, canRetry = false)
        DomainReason.InvalidInput -> ErrorPresentation(R.string.error_invalid, canRetry = false)
    }
}
```

Decide per screen whether an error replaces content or overlays it:

- Initial load failed, nothing cached: full-screen error with a retry button.
- Refresh failed, content cached: keep the content, show a snackbar or inline banner.
- Action failed (toggle, delete): snackbar, and revert any optimistic update.

```kotlin
@Composable
fun ErrorContent(presentation: ErrorPresentation, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(stringResource(presentation.message), style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
        if (presentation.canRetry) {
            Button(onClick = onRetry, modifier = Modifier.padding(top = 16.dp)) { Text(stringResource(R.string.action_retry)) }
        }
    }
}
```

Never show `e.message` or a stack trace to users. It is not translated, often empty, and can leak server internals.

## Logging without PII

Log the error class and the code, not the request body, the URL query, or anything user-entered.

```kotlin
package com.example.app.core.common

import android.util.Log

object ErrorLog {
    fun report(error: AppError, where: String) {
        when (error) {
            is AppError.Network -> Log.w(TAG, "$where: network ${error.cause::class.simpleName}")
            is AppError.Server -> Log.w(TAG, "$where: server ${error.code}")
            is AppError.Unknown -> Log.e(TAG, "$where: unknown", error.cause)   // stack trace is fine; message is not
            else -> Log.i(TAG, "$where: ${error::class.simpleName}")
        }
        // crashReporter.recordNonFatal(...) in release; see checklists/release.md
    }
    private const val TAG = "AppError"
}
```

Rules:

- Strip or hash identifiers (email, phone, user id) before they reach any log or crash reporter. Crash reporters store logs on third-party servers; the Data safety form has to disclose that.
- Release builds: R8 strips `Log.v` and `Log.d` calls only if you add `-assumenosideeffects` rules; otherwise the strings remain in the APK. Use a logging facade that is a no-op in release, or Timber with a release tree that only forwards warnings.
- Never log tokens, even partially. `token.take(6)` still identifies the session for anyone with log access.
- `OkHttp`'s `HttpLoggingInterceptor` at `BODY` level is a debug-only dependency; gate it with `if (BuildConfig.DEBUG)`.

## Avoid

```kotlin
// Anti-pattern: exceptions as control flow across layers; every caller must know Retrofit.
suspend fun refresh() { api.list() }   // throws HttpException to the ViewModel

// Anti-pattern: catch-and-ignore.
try { repository.sync() } catch (e: Exception) { }

// Anti-pattern: generic Exception subclass with a string reason the UI has to parse.
throw Exception("network_error")

// Anti-pattern: showing exception text.
Text(error.message ?: "Error")

// Anti-pattern: retrying forever or retrying Unauthorized.
while (true) { if (api.call() is Success) break; delay(1000) }

// Anti-pattern: logging the request.
Log.d("Api", "POST /login body=$body")
```

## Verify

```sh
./gradlew :core:common:test     # Result/mapping/retry unit tests, pure JVM
./gradlew :app:assembleDebug
# Simulate failures on a device:
adb shell svc wifi disable; adb shell svc data disable     # Network
# Point BuildConfig.API_BASE_URL at a local server returning 500 for Server
```

Unit tests to write: `toAppError` for each exception class; `retryWithBackoff` with a `runTest` scheduler (`advanceTimeBy`) checking attempt counts and that `Unauthorized` is not retried; `runCatchingApp` rethrows `CancellationException`.

## Sources

- https://developer.android.com/kotlin/coroutines/coroutines-best-practices
- https://kotlinlang.org/docs/cancellation-and-timeouts.html
- https://kotlinlang.org/docs/exception-handling.html
- https://kotlinlang.org/docs/flow.html#exception-transparency
- https://developer.android.com/topic/architecture/data-layer
- https://developer.android.com/topic/architecture/ui-layer/events
- https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work
