# Play Billing

In-app products and subscriptions with the Play Billing Library 9.0.0: a `BillingClient` wrapped in a repository with connection retry, product details queries, launching the purchase flow, handling `PurchasesUpdatedListener`, acknowledging purchases after server verification, restoring entitlements with `queryPurchasesAsync`, and testing with license testers.

## When to use

- Selling digital goods or subscriptions inside an app distributed on Google Play. Play policy requires Play Billing for in-app digital content.
- Physical goods and services must not use Play Billing; use a payment processor SDK instead.
- Entitlement decisions belong on your server: verify the purchase token with the Google Play Developer API before granting access, then acknowledge.

## Dependencies

```toml
[versions]
billing = "9.0.0"

[libraries]
billing-ktx = { group = "com.android.billingclient", name = "billing-ktx", version.ref = "billing" }
```

```kotlin
dependencies {
    implementation(libs.billing.ktx)
}
```

`billing-ktx` adds suspend wrappers (`queryProductDetails`, `queryPurchasesAsync`, `acknowledgePurchase`).

## Manifest and permissions

The library merges `com.android.vending.BILLING` automatically. No runtime permissions. The app must be uploaded to Play (at least the internal testing track) with the products created in Play Console; purchase flows do not work on sideloaded builds with a different signature.

## Implementation

### Repository

```kotlin
package com.example.app.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.android.billingclient.api.acknowledgePurchase
import com.android.billingclient.api.queryProductDetails
import com.android.billingclient.api.queryPurchasesAsync
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

sealed interface PurchaseEvent {
    data class Completed(val purchase: Purchase) : PurchaseEvent
    data object Cancelled : PurchaseEvent
    data object AlreadyOwned : PurchaseEvent
    data class Failed(val code: Int, val message: String) : PurchaseEvent
}

interface EntitlementVerifier {
    /** Sends productId + purchaseToken to your server; returns true when the server verified and recorded it. */
    suspend fun verify(productId: String, purchaseToken: String): Boolean
}

@Singleton
class BillingRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    @ApplicationScope private val scope: CoroutineScope,
    private val verifier: EntitlementVerifier,
) : PurchasesUpdatedListener {

    private val _events = MutableSharedFlow<PurchaseEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<PurchaseEvent> = _events

    private val _entitled = MutableStateFlow<Set<String>>(emptySet())
    val entitledProductIds: StateFlow<Set<String>> = _entitled.asStateFlow()

    private val client: BillingClient = BillingClient.newBuilder(context)
        .setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()

    private suspend fun ensureConnected(): Boolean {
        if (client.isReady) return true
        repeat(3) { attempt ->
            val ok = suspendCancellableCoroutine { cont ->
                client.startConnection(object : BillingClientStateListener {
                    override fun onBillingSetupFinished(result: BillingResult) {
                        if (cont.isActive) cont.resume(result.responseCode == BillingClient.BillingResponseCode.OK)
                    }
                    override fun onBillingServiceDisconnected() { if (cont.isActive) cont.resume(false) }
                })
            }
            if (ok) return true
            delay(1_000L shl attempt)
        }
        return false
    }

    suspend fun products(ids: List<String>, type: String): List<ProductDetails> {
        if (!ensureConnected()) return emptyList()
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(ids.map {
                QueryProductDetailsParams.Product.newBuilder().setProductId(it).setProductType(type).build()
            })
            .build()
        val result = client.queryProductDetails(params)
        return if (result.billingResult.responseCode == BillingClient.BillingResponseCode.OK)
            result.productDetailsList.orEmpty() else emptyList()
    }

    fun launchPurchase(activity: Activity, details: ProductDetails, offerToken: String? = null): BillingResult {
        val product = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(details)
            .apply { offerToken?.let(::setOfferToken) }   // required for subscriptions
            .build()
        val params = BillingFlowParams.newBuilder().setProductDetailsParamsList(listOf(product)).build()
        return client.launchBillingFlow(activity, params)
    }

    override fun onPurchasesUpdated(result: BillingResult, purchases: List<Purchase>?) {
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> purchases?.forEach { scope.launch { process(it) } }
            BillingClient.BillingResponseCode.USER_CANCELED -> _events.tryEmit(PurchaseEvent.Cancelled)
            BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> {
                _events.tryEmit(PurchaseEvent.AlreadyOwned); scope.launch { restore() }
            }
            else -> _events.tryEmit(PurchaseEvent.Failed(result.responseCode, result.debugMessage))
        }
    }

    private suspend fun process(purchase: Purchase) {
        if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) return   // PENDING: wait for a later update
        val verified = purchase.products.all { verifier.verify(it, purchase.purchaseToken) }
        if (!verified) { _events.tryEmit(PurchaseEvent.Failed(-1, "Verification failed")); return }
        if (!purchase.isAcknowledged) {
            val ack = client.acknowledgePurchase(
                AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchase.purchaseToken).build()
            )
            if (ack.responseCode != BillingClient.BillingResponseCode.OK) return   // will be retried on next restore
        }
        _entitled.value = _entitled.value + purchase.products
        _events.tryEmit(PurchaseEvent.Completed(purchase))
    }

    /** Call on app start and after sign-in: Play is the source of truth for owned items. */
    suspend fun restore() {
        if (!ensureConnected()) return
        val types = listOf(BillingClient.ProductType.INAPP, BillingClient.ProductType.SUBS)
        val owned = types.flatMap { type ->
            client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(type).build()).purchasesList
        }
        owned.forEach { process(it) }
        _entitled.value = owned.filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }.flatMap { it.products }.toSet()
    }
}
```

Consumable products (coins, credits) use `consumePurchase` instead of `acknowledgePurchase`; consumption also acknowledges. A purchase not acknowledged within three days is refunded automatically.

### Server verification note

The client never grants an entitlement from `onPurchasesUpdated` alone. The server calls `purchases.products.get` or `purchases.subscriptionsv2.get` on the Google Play Developer API with the purchase token, checks `purchaseState`/`subscriptionState` and the package name, stores the entitlement against the user, and only then does the client acknowledge. Configure Real-time Developer Notifications (Pub/Sub) so renewals, cancellations and refunds reach the server without the app being open.

### ViewModel and UI

```kotlin
sealed interface PaywallUiState {
    data object Loading : PaywallUiState
    data object Unavailable : PaywallUiState
    data class Ready(val offers: List<Offer>, val owned: Boolean, val processing: Boolean) : PaywallUiState
}

data class Offer(val productId: String, val title: String, val formattedPrice: String, val offerToken: String?, val details: ProductDetails)

@HiltViewModel
class PaywallViewModel @Inject constructor(private val billing: BillingRepository) : ViewModel() {
    private val processing = MutableStateFlow(false)
    private val products = MutableStateFlow<List<ProductDetails>?>(null)

    val uiState: StateFlow<PaywallUiState> = combine(products, billing.entitledProductIds, processing) { list, owned, busy ->
        when {
            list == null -> PaywallUiState.Loading
            list.isEmpty() -> PaywallUiState.Unavailable
            else -> PaywallUiState.Ready(list.map { it.toOffer() }, owned = PRO in owned, processing = busy)
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PaywallUiState.Loading)

    init {
        viewModelScope.launch { billing.restore(); products.value = billing.products(listOf(PRO), BillingClient.ProductType.SUBS) }
        viewModelScope.launch { billing.events.collect { processing.value = false } }
    }

    fun buy(activity: Activity, offer: Offer) {
        processing.value = true
        billing.launchPurchase(activity, offer.details, offer.offerToken)
    }

    private fun ProductDetails.toOffer(): Offer {
        val sub = subscriptionOfferDetails?.firstOrNull()
        val price = sub?.pricingPhases?.pricingPhaseList?.firstOrNull()?.formattedPrice
            ?: oneTimePurchaseOfferDetails?.formattedPrice ?: ""
        return Offer(productId, name, price, sub?.offerToken, this)
    }

    companion object { const val PRO = "pro_monthly" }
}
```

The composable passes `LocalActivity.current` to `buy`; purchase sheets need an Activity.

## Verify

```sh
./gradlew :app:assembleRelease           # signed with the upload key
# Upload to Play Console > Internal testing; add license testers under Setup > License testing.
adb install -r app/build/outputs/apk/release/app-release.apk   # same signature as the uploaded build
adb logcat -s BillingClient                                     # response codes for each call
./gradlew :app:testDebugUnitTest --tests "*PaywallViewModelTest*"
```

Unit test with a fake repository (extract `BillingRepository` behind an interface so the ViewModel can be tested without Play):

```kotlin
@Test fun ownedProductShowsAsOwned() = runTest {
    val fake = FakeBillingRepository(entitled = setOf(PaywallViewModel.PRO), products = listOf(fakeProDetails))
    val vm = PaywallViewModel(fake)
    advanceUntilIdle()
    val state = vm.uiState.first { it is PaywallUiState.Ready } as PaywallUiState.Ready
    assertTrue(state.owned)
}
```

License testers can use "Test card, always approves" and the slow-test-card flows to exercise pending purchases. Subscription test renewals are shortened (for example five minutes for a monthly plan).

## Pitfalls

- Not acknowledging within three days refunds the purchase. Acknowledge only after server verification, and re-run `restore()` on launch to acknowledge anything missed.
- `launchBillingFlow` for a subscription without an `offerToken` returns `DEVELOPER_ERROR`.
- Granting entitlement from the client response alone is trivially spoofable. Server-side verification is the rule, not an option.
- Products appear in `queryProductDetails` only after the app is published to a testing track and the products are active. Empty lists on a fresh project are expected until then.
- The purchase listener fires on the main thread; move verification and acknowledgement to a coroutine.
- `BillingClient` is a singleton per process; building more than one causes duplicate callbacks.
- `PENDING` purchases (cash payment, parental approval) must not be rewarded until a later `PURCHASED` update arrives.
- Play Billing Library versions have a support window; new app submissions must use a supported major version. 9.0.0 is current in `data/versions.json`; check the deprecation schedule before shipping an older one.

## Sources

- https://developer.android.com/google/play/billing/integrate
- https://developer.android.com/google/play/billing/security
- https://developer.android.com/google/play/billing/test
- https://developer.android.com/google/play/billing/release-notes
- https://developer.android.com/google/play/billing/rtdn-reference
