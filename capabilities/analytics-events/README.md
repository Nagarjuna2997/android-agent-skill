# Analytics events

Product analytics with Firebase Analytics (Google Analytics for Firebase) from the Firebase BoM 34.18.0: an `AnalyticsTracker` interface with a typed event catalog, consent mode and collection disabled until the user agrees, screen tracking from Navigation Compose, user properties, a debug-view workflow for verification and a recording fake for tests.

## When to use

- Understanding which features are used, funnels (onboarding complete, first purchase) and retention. Firebase Analytics feeds Crashlytics breadcrumbs, Remote Config targeting and Play Console audiences.
- Not for anything that identifies a person: no emails, names, free text or precise location in event parameters.
- Consent is a legal requirement in many regions; wire it before shipping, not after.

## Dependencies

```toml
[versions]
firebase-bom = "34.18.0"
google-services = "<version>"   # https://firebase.google.com/docs/android/setup
navigation = "2.10.2"

[libraries]
firebase-bom = { group = "com.google.firebase", name = "firebase-bom", version.ref = "firebase-bom" }
firebase-analytics = { group = "com.google.firebase", name = "firebase-analytics" }
navigation-compose = { group = "androidx.navigation", name = "navigation-compose", version.ref = "navigation" }

[plugins]
google-services = { id = "com.google.gms.google-services", version.ref = "google-services" }
```

```kotlin
plugins { alias(libs.plugins.google.services) }
dependencies {
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.analytics)
}
```

## Manifest and permissions

`INTERNET`, plus the following to keep collection and advertising id use off until consent:

```xml
<meta-data android:name="firebase_analytics_collection_enabled" android:value="false" />
<meta-data android:name="google_analytics_adid_collection_enabled" android:value="false" />
<meta-data android:name="google_analytics_default_allow_analytics_storage" android:value="false" />
<meta-data android:name="google_analytics_default_allow_ad_storage" android:value="false" />
<meta-data android:name="google_analytics_default_allow_ad_user_data" android:value="false" />
<meta-data android:name="google_analytics_default_allow_ad_personalization_signals" android:value="false" />
```

If the app does not use ads at all, also remove the `AD_ID` permission the library merges: `<uses-permission android:name="com.google.android.gms.permission.AD_ID" tools:node="remove" />`, and answer the Data safety form accordingly.

## Implementation

### Event catalog

```kotlin
package com.example.app.analytics

sealed class AnalyticsEvent(val name: String, val params: Map<String, Any> = emptyMap()) {
    data object OnboardingComplete : AnalyticsEvent("onboarding_complete")
    data class NoteCreated(val source: String) : AnalyticsEvent("note_created", mapOf("source" to source))
    data class SearchPerformed(val resultCount: Int) : AnalyticsEvent("search", mapOf("result_count" to resultCount))
    data class PurchaseStarted(val productId: String) : AnalyticsEvent("begin_checkout", mapOf("item_id" to productId))
    data class ScreenView(val screen: String) : AnalyticsEvent("screen_view", mapOf("screen_name" to screen, "screen_class" to screen))
}

enum class UserProperty(val key: String) { PLAN("plan"), THEME("theme") }
```

Event names are lowercase snake case, up to 40 characters, at most 25 parameters per event, parameter values up to 100 characters. Prefer the reserved names (`screen_view`, `begin_checkout`, `purchase`, `login`, `sign_up`) when they fit, so GA reports populate automatically.

### Tracker

```kotlin
package com.example.app.analytics

import android.os.Bundle
import com.google.firebase.Firebase
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.analytics.analytics
import javax.inject.Inject
import javax.inject.Singleton

interface AnalyticsTracker {
    fun setConsent(analytics: Boolean, ads: Boolean)
    fun track(event: AnalyticsEvent)
    fun setUserProperty(property: UserProperty, value: String?)
    fun setUserId(id: String?)
}

@Singleton
class FirebaseAnalyticsTracker @Inject constructor() : AnalyticsTracker {
    private val analytics: FirebaseAnalytics = Firebase.analytics

    override fun setConsent(analytics: Boolean, ads: Boolean) {
        val a = if (analytics) FirebaseAnalytics.ConsentStatus.GRANTED else FirebaseAnalytics.ConsentStatus.DENIED
        val d = if (ads) FirebaseAnalytics.ConsentStatus.GRANTED else FirebaseAnalytics.ConsentStatus.DENIED
        this.analytics.setConsent(
            mapOf(
                FirebaseAnalytics.ConsentType.ANALYTICS_STORAGE to a,
                FirebaseAnalytics.ConsentType.AD_STORAGE to d,
                FirebaseAnalytics.ConsentType.AD_USER_DATA to d,
                FirebaseAnalytics.ConsentType.AD_PERSONALIZATION to d,
            )
        )
        this.analytics.setAnalyticsCollectionEnabled(analytics)
    }

    override fun track(event: AnalyticsEvent) {
        val bundle = Bundle().apply {
            event.params.forEach { (k, v) ->
                when (v) {
                    is String -> putString(k, v.take(100))
                    is Int -> putLong(k, v.toLong())
                    is Long -> putLong(k, v)
                    is Double -> putDouble(k, v)
                    is Boolean -> putString(k, v.toString())
                    else -> putString(k, v.toString().take(100))
                }
            }
        }
        analytics.logEvent(event.name, bundle)
    }

    override fun setUserProperty(property: UserProperty, value: String?) = analytics.setUserProperty(property.key, value)
    override fun setUserId(id: String?) = analytics.setUserId(id)
}

class RecordingAnalyticsTracker : AnalyticsTracker {
    val events = mutableListOf<AnalyticsEvent>()
    var consent: Pair<Boolean, Boolean>? = null
    override fun setConsent(analytics: Boolean, ads: Boolean) { consent = analytics to ads }
    override fun track(event: AnalyticsEvent) { events += event }
    override fun setUserProperty(property: UserProperty, value: String?) = Unit
    override fun setUserId(id: String?) = Unit
}
```

Bind `FirebaseAnalyticsTracker` in release and `RecordingAnalyticsTracker` (or a logcat tracker) in debug through the same `BuildConfig.DEBUG` switch as [crash-reporting](../crash-reporting/README.md).

### Consent

```kotlin
class AnalyticsConsentObserver @Inject constructor(
    private val settings: SettingsRepository,
    private val tracker: AnalyticsTracker,
    @ApplicationScope private val scope: CoroutineScope,
) {
    fun start() = scope.launch {
        settings.settings
            .map { it.analyticsConsent to it.adsConsent }
            .distinctUntilChanged()
            .collect { (analytics, ads) -> tracker.setConsent(analytics, ads) }
    }
}
```

Store consent with a timestamp and version in DataStore; show the consent screen in onboarding or on first launch after a policy change. The setting rows live in [settings-screen](../settings-screen/README.md).

### Screen tracking

```kotlin
@Composable
fun TrackScreenViews(navController: NavHostController, tracker: AnalyticsTracker) {
    DisposableEffect(navController) {
        val listener = NavController.OnDestinationChangedListener { _, destination, _ ->
            val name = destination.route?.substringBefore('/')?.substringAfterLast('.') ?: return@OnDestinationChangedListener
            tracker.track(AnalyticsEvent.ScreenView(name))
        }
        navController.addOnDestinationChangedListener(listener)
        onDispose { navController.removeOnDestinationChangedListener(listener) }
    }
}
```

With typed routes `destination.route` is the serialized class name pattern; the substring logic turns `com.example.app.navigation.NoteRoute/{id}` into `NoteRoute`. Call `TrackScreenViews` once next to the `NavHost`. Disable Firebase's automatic Activity-based screen tracking, which is useless in a single-Activity app: `<meta-data android:name="google_analytics_automatic_screen_reporting_enabled" android:value="false" />`.

### Tracking from ViewModels

```kotlin
@HiltViewModel
class NoteEditorViewModel @Inject constructor(
    private val repo: NoteRepository,
    private val tracker: AnalyticsTracker,
) : ViewModel() {
    fun save(note: Note, source: String) = viewModelScope.launch {
        repo.save(note)
        tracker.track(AnalyticsEvent.NoteCreated(source))
    }
}
```

Track outcomes (saved, purchased), not taps; taps without outcomes are noise.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell setprop debug.firebase.analytics.app com.example.app     # enables DebugView in the Firebase console
adb shell setprop log.tag.FA VERBOSE
adb shell setprop log.tag.FA-SVC VERBOSE
adb logcat -v time -s FA FA-SVC                                     # "Logging event: origin=app,name=note_created"
adb shell setprop debug.firebase.analytics.app .none.               # turn DebugView off afterwards
./gradlew :app:testDebugUnitTest --tests "*NoteEditorViewModelTest*"
```

Unit test:

```kotlin
@Test fun savingTracksNoteCreated() = runTest {
    val tracker = RecordingAnalyticsTracker()
    val vm = NoteEditorViewModel(FakeNoteRepository(), tracker)
    vm.save(Note("1", "t", "b", 0), source = "editor")
    advanceUntilIdle()
    assertEquals(listOf(AnalyticsEvent.NoteCreated("editor")), tracker.events)
}
```

Events reach the GA reports with a delay of up to a day; DebugView is the real-time check. Report "verified in DebugView" with the event names seen.

## Pitfalls

- Logging events before consent is set still queues them locally; with the manifest defaults above nothing is sent, which is the intent. Do not call `setAnalyticsCollectionEnabled(true)` unconditionally in `Application`.
- Event and parameter names with uppercase or dashes are silently dropped or renamed. Keep to the catalog.
- Free-text parameters (search queries, note titles) leak personal data into GA; send counts and categories instead.
- `screen_view` requires `screen_name` or `screen_class`; without them the event is logged but not reported as a screen.
- The `AD_ID` permission is added by the library; if you do not use advertising features, remove it and declare that in the Data safety form.
- User properties are limited to 25 and sticky; use them for segmentation (plan, theme), not state that changes per session.
- Debug builds in DebugView show your own usage; filter by a `debug_build` user property or use a separate Firebase project per build type.

## Sources

- https://firebase.google.com/docs/analytics/get-started?platform=android
- https://firebase.google.com/docs/analytics/events?platform=android
- https://firebase.google.com/docs/analytics/configure-data-collection?platform=android
- https://developers.google.com/tag-platform/security/guides/app-consent?platform=android
- https://firebase.google.com/docs/analytics/debugview
