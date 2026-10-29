# Unidirectional Data Flow (MVI-style)

A stricter variant of MVVM: the UI emits a closed set of intents, a pure reducer folds each result into a single state, and nothing else touches the state. Use it when a screen's state transitions are complex enough that you want them enumerable and testable in isolation.

```
UI ──intent──▶ ViewModel ──(side effect)──▶ repository
 ▲                │                            │
 │                ▼                            │
 └──state──── reducer(state, result) ◀─────────┘
```

The plain MVVM in [mvvm.md](mvvm.md) already has unidirectional flow: state goes down, events come up. What MVI adds is (1) a sealed intent type instead of several public functions, (2) a reducer that is the only place state changes, and (3) often a sealed result/partial-change type between the side effect and the reducer.

## Intents

```kotlin
package com.example.app.checkout

sealed interface CheckoutIntent {
    data object Load : CheckoutIntent
    data class ChangeQuantity(val lineId: String, val quantity: Int) : CheckoutIntent
    data class ApplyPromo(val code: String) : CheckoutIntent
    data object RemovePromo : CheckoutIntent
    data object PlaceOrder : CheckoutIntent
    data object Retry : CheckoutIntent
    data object OrderNavigationHandled : CheckoutIntent
}
```

Every user action and every lifecycle trigger becomes one value. A `when` over this type in the ViewModel is exhaustive by construction, so adding an intent without handling it is a compile error.

## State

```kotlin
package com.example.app.checkout

import androidx.compose.runtime.Immutable

@Immutable
data class CheckoutState(
    val phase: Phase = Phase.Loading,
    val lines: List<CartLine> = emptyList(),
    val promo: Promo? = null,
    val promoError: String? = null,
    val isPlacingOrder: Boolean = false,
    val placedOrderId: String? = null,
) {
    val subtotal: Long get() = lines.sumOf { it.unitPriceCents * it.quantity }
    val discount: Long get() = promo?.discountFor(subtotal) ?: 0
    val total: Long get() = subtotal - discount
    val canPlaceOrder: Boolean get() = phase == Phase.Ready && lines.isNotEmpty() && !isPlacingOrder

    enum class Phase { Loading, Ready, Failed }
}

data class CartLine(val id: String, val name: String, val unitPriceCents: Long, val quantity: Int)
data class Promo(val code: String, val percentOff: Int) {
    fun discountFor(subtotalCents: Long): Long = subtotalCents * percentOff / 100
}
```

Derived values (`total`, `canPlaceOrder`) are computed properties, not stored fields. Storing them would create two sources of truth that the reducer has to keep in sync.

## Results (partial changes)

The side-effect layer does not touch state. It produces results, and the reducer maps results to a new state.

```kotlin
package com.example.app.checkout

sealed interface CheckoutResult {
    data object Loading : CheckoutResult
    data class CartLoaded(val lines: List<CartLine>) : CheckoutResult
    data class LoadFailed(val message: String) : CheckoutResult
    data class QuantityChanged(val lineId: String, val quantity: Int) : CheckoutResult
    data class PromoApplied(val promo: Promo) : CheckoutResult
    data class PromoRejected(val message: String) : CheckoutResult
    data object PromoRemoved : CheckoutResult
    data object PlacingOrder : CheckoutResult
    data class OrderPlaced(val orderId: String) : CheckoutResult
    data class OrderFailed(val message: String) : CheckoutResult
    data object OrderNavigationHandled : CheckoutResult
}
```

## Reducer

A pure function. No coroutines, no repository, no `Context`. This is what makes MVI worth it: every transition is a unit test with no setup.

```kotlin
package com.example.app.checkout

fun reduce(state: CheckoutState, result: CheckoutResult): CheckoutState = when (result) {
    CheckoutResult.Loading -> state.copy(phase = CheckoutState.Phase.Loading)
    is CheckoutResult.CartLoaded -> state.copy(phase = CheckoutState.Phase.Ready, lines = result.lines)
    is CheckoutResult.LoadFailed -> state.copy(phase = CheckoutState.Phase.Failed)
    is CheckoutResult.QuantityChanged -> state.copy(
        lines = state.lines.mapNotNull { line ->
            when {
                line.id != result.lineId -> line
                result.quantity <= 0 -> null
                else -> line.copy(quantity = result.quantity)
            }
        },
    )
    is CheckoutResult.PromoApplied -> state.copy(promo = result.promo, promoError = null)
    is CheckoutResult.PromoRejected -> state.copy(promo = null, promoError = result.message)
    CheckoutResult.PromoRemoved -> state.copy(promo = null, promoError = null)
    CheckoutResult.PlacingOrder -> state.copy(isPlacingOrder = true)
    is CheckoutResult.OrderPlaced -> state.copy(isPlacingOrder = false, placedOrderId = result.orderId)
    is CheckoutResult.OrderFailed -> state.copy(isPlacingOrder = false)
    CheckoutResult.OrderNavigationHandled -> state.copy(placedOrderId = null)
}
```

The reducer is a top-level function so it can be tested without constructing a ViewModel. If you need to show a transient error for `OrderFailed`, add a `userMessage` field as in [mvvm.md](mvvm.md); keep it in state, not in a `SharedFlow`.

## ViewModel

The ViewModel routes intents to side effects and feeds results into the reducer. A `Mutex` or a single-consumer channel keeps reductions serialized so two concurrent results cannot race on `state.value`.

```kotlin
package com.example.app.checkout

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class CheckoutViewModel @Inject constructor(
    private val cart: CartRepository,
    private val orders: OrderRepository,
) : ViewModel() {

    private val _state = MutableStateFlow(CheckoutState())
    val state: StateFlow<CheckoutState> = _state.asStateFlow()

    init { onIntent(CheckoutIntent.Load) }

    fun onIntent(intent: CheckoutIntent) {
        when (intent) {
            CheckoutIntent.Load, CheckoutIntent.Retry -> load()
            is CheckoutIntent.ChangeQuantity -> dispatch(
                CheckoutResult.QuantityChanged(intent.lineId, intent.quantity),
            )
            is CheckoutIntent.ApplyPromo -> applyPromo(intent.code)
            CheckoutIntent.RemovePromo -> dispatch(CheckoutResult.PromoRemoved)
            CheckoutIntent.PlaceOrder -> placeOrder()
            CheckoutIntent.OrderNavigationHandled -> dispatch(CheckoutResult.OrderNavigationHandled)
        }
    }

    // MutableStateFlow.update is atomic (compare-and-set loop), so concurrent
    // dispatches from different coroutines cannot lose a result.
    private fun dispatch(result: CheckoutResult) = _state.update { reduce(it, result) }

    private fun load() = viewModelScope.launch {
        dispatch(CheckoutResult.Loading)
        runCatching { cart.currentLines() }
            .onSuccess { dispatch(CheckoutResult.CartLoaded(it)) }
            .onFailure { dispatch(CheckoutResult.LoadFailed(it.messageOrRethrow())) }
    }

    private fun applyPromo(code: String) = viewModelScope.launch {
        runCatching { cart.validatePromo(code) }
            .onSuccess { dispatch(CheckoutResult.PromoApplied(it)) }
            .onFailure { dispatch(CheckoutResult.PromoRejected(it.messageOrRethrow())) }
    }

    private fun placeOrder() = viewModelScope.launch {
        val snapshot = _state.value
        if (!snapshot.canPlaceOrder) return@launch
        dispatch(CheckoutResult.PlacingOrder)
        runCatching { orders.place(snapshot.lines, snapshot.promo?.code) }
            .onSuccess { dispatch(CheckoutResult.OrderPlaced(it)) }
            .onFailure { dispatch(CheckoutResult.OrderFailed(it.messageOrRethrow())) }
    }
}

private fun Throwable.messageOrRethrow(): String {
    if (this is CancellationException) throw this
    return message ?: "Something went wrong."
}
```

Because `placeOrder` snapshots state before suspending and the reducer re-reads current state after, a quantity change during the network call does not corrupt the order: the reducer applies `OrderPlaced` on top of whatever state exists then. Decide deliberately whether that is the behavior you want; if the order must be based on exactly the submitted lines, send the snapshot in the result and let the reducer compare.

## Screen

The screen takes `state` and a single `onIntent` lambda.

```kotlin
package com.example.app.checkout

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun CheckoutRoute(
    onOrderPlaced: (orderId: String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: CheckoutViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // Navigation is state consumed once, then acknowledged.
    state.placedOrderId?.let { id ->
        LaunchedEffect(id) {
            onOrderPlaced(id)
            viewModel.onIntent(CheckoutIntent.OrderNavigationHandled)
        }
    }

    CheckoutScreen(state = state, onIntent = viewModel::onIntent, modifier = modifier)
}
```

A single `onIntent` lambda keeps every row composable's parameter list short and stable. The cost is that a row for one cart line receives a lambda that could emit any intent; if a design review wants narrower contracts, pass `(Int) -> Unit` to the row and wrap it in the parent.

## Reducer tests

```kotlin
package com.example.app.checkout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CheckoutReducerTest {
    private val line = CartLine("a", "Mug", 1200, 2)
    private val ready = CheckoutState(phase = CheckoutState.Phase.Ready, lines = listOf(line))

    @Test
    fun `quantity zero removes the line`() {
        val next = reduce(ready, CheckoutResult.QuantityChanged("a", 0))
        assertEquals(emptyList<CartLine>(), next.lines)
    }

    @Test
    fun `promo discount is applied to total`() {
        val next = reduce(ready, CheckoutResult.PromoApplied(Promo("SAVE10", 10)))
        assertEquals(2400L, next.subtotal)
        assertEquals(2160L, next.total)
    }

    @Test
    fun `rejected promo clears an existing promo and sets the error`() {
        val withPromo = reduce(ready, CheckoutResult.PromoApplied(Promo("SAVE10", 10)))
        val next = reduce(withPromo, CheckoutResult.PromoRejected("Expired"))
        assertNull(next.promo)
        assertEquals("Expired", next.promoError)
    }

    @Test
    fun `order placed clears placing flag and sets navigation target`() {
        val placing = reduce(ready, CheckoutResult.PlacingOrder)
        val next = reduce(placing, CheckoutResult.OrderPlaced("o-1"))
        assertEquals(false, next.isPlacingOrder)
        assertEquals("o-1", next.placedOrderId)
    }
}
```

No dispatcher rule, no fakes, no coroutines. This is the payoff. ViewModel tests that exercise the side effects still look like those in [mvvm.md](mvvm.md).

## When MVI is worth it

Choose MVI over plain MVVM when:

- The screen has many interacting inputs (a checkout, an editor with undo, a multi-step form) and you keep finding bugs where two updates interleave badly.
- You want transitions testable as pure functions and reviewable as a single `when`.
- You want a log of every intent and result for debugging; add a `Timber.d` in `dispatch` and you have one.
- Several people work on the same screen and the enumerated contract reduces merge conflicts.

Stay with plain MVVM when:

- The screen is a list plus a detail with two or three actions. The sealed types triple the file count for no gain.
- State is mostly a projection of a repository `Flow`; `combine` plus `stateIn` is already a reducer.
- The team is new to the codebase. The indirection (intent, result, reducer) has a real reading cost.

Do not mix both styles inside one feature module. Pick one per module and write it down in the module README.

## Avoid

```kotlin
// Anti-pattern: mutating state outside the reducer. Two places now own transitions.
_state.update { it.copy(isPlacingOrder = true) }

// Anti-pattern: a reducer that suspends or calls the repository. It is no longer pure or testable.
suspend fun reduce(state: CheckoutState, result: CheckoutResult): CheckoutState

// Anti-pattern: a SharedFlow<Effect> for navigation; events emitted while the
// collector is paused are dropped.
private val _effects = MutableSharedFlow<CheckoutEffect>()

// Anti-pattern: storing derived values in state and recomputing them in the reducer.
data class CheckoutState(val total: Long, val subtotal: Long, val discount: Long, ...)
```

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "com.example.app.checkout.*"
```

Add a Turbine test on `state` for at least one intent that goes through a side effect, so the dispatcher wiring is covered.

## Sources

- https://developer.android.com/topic/architecture/ui-layer
- https://developer.android.com/topic/architecture/ui-layer/events
- https://developer.android.com/topic/architecture/ui-layer/stateholders
- https://developer.android.com/kotlin/flow/stateflow-and-sharedflow
- https://kotlinlang.org/docs/sealed-classes.html
