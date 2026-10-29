# Crash reporting

Firebase Crashlytics through the Firebase BoM 34.18.0: the Gradle plugin for mapping-file upload, a `CrashReporter` interface so the app never calls Crashlytics directly, non-fatal reporting from the error-handling layer with keys and breadcrumbs, user-consented collection toggled at runtime, a coroutine exception handler, and a forced test crash to confirm the pipeline.

## When to use

- Any app on Play; unhandled exceptions and ANRs are otherwise invisible. Crashlytics is free and integrates with Play's vitals.
- Report non-fatals for errors you catch and recover from (network failure after retries, data corruption) so they show up in dashboards without crashing.
- Treat collection as personal data: default it on only if the privacy policy and the Play Data safety form say so; otherwise ask during onboarding and persist the choice.

## Dependencies

Plugin versions are not in `data/versions.json`; resolve from the Firebase setup page.

```toml
[versions]
firebase-bom = "34.18.0"
google-services = "<version>"          # https://firebase.google.com/docs/android/setup
firebase-crashlytics-plugin = "<version>"   # https://firebase.google.com/docs/crashlytics/get-started?platform=android

[libraries]
firebase-bom = { group = "com.google.firebase", name = "firebase-bom", version.ref = "firebase-bom" }
firebase-crashlytics = { group = "com.google.firebase", name = "firebase-crashlytics" }
firebase-crashlytics-ndk = { group = "com.google.firebase", name = "firebase-crashlytics-ndk" }   # only with native code

[plugins]
google-services = { id = "com.google.gms.google-services", version.ref = "google-services" }
firebase-crashlytics = { id = "com.google.firebase.crashlytics", version.ref = "firebase-crashlytics-plugin" }
```

`app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.google.services)
    alias(libs.plugins.firebase.crashlytics)
}

android {
    buildTypes {
        release {
            isMinifyEnabled = true
            configure<com.google.firebase.crashlytics.buildtools.gradle.CrashlyticsExtension> {
                mappingFileUploadEnabled = true     // de-obfuscated stack traces
            }
        }
        debug {
            configure<com.google.firebase.crashlytics.buildtools.gradle.CrashlyticsExtension> {
                mappingFileUploadEnabled = false
            }
        }
    }
}

dependencies {
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.crashlytics)
}
```

## Manifest and permissions

`INTERNET`. To stop automatic collection until the user consents:

```xml
<meta-data
    android:name="firebase_crashlytics_collection_enabled"
    android:value="false" />
```

Then enable at runtime as shown below. `google-services.json` in `app/`.

## Implementation

### Reporter abstraction

```kotlin
package com.example.app.diagnostics

interface CrashReporter {
    fun setCollectionEnabled(enabled: Boolean)
    fun setUserId(id: String?)
    fun setKey(key: String, value: String)
    fun log(message: String)                   // breadcrumb attached to the next report
    fun recordNonFatal(throwable: Throwable, keys: Map<String, String> = emptyMap())
}

class FirebaseCrashReporter @Inject constructor() : CrashReporter {
    private val crashlytics = com.google.firebase.Firebase.crashlytics

    override fun setCollectionEnabled(enabled: Boolean) {
        crashlytics.isCrashlyticsCollectionEnabled = enabled
        if (!enabled) crashlytics.deleteUnsentReports()
    }
    override fun setUserId(id: String?) = crashlytics.setUserId(id ?: "")
    override fun setKey(key: String, value: String) = crashlytics.setCustomKey(key, value)
    override fun log(message: String) = crashlytics.log(message)
    override fun recordNonFatal(throwable: Throwable, keys: Map<String, String>) {
        keys.forEach { (k, v) -> crashlytics.setCustomKey(k, v) }
        crashlytics.recordException(throwable)
    }
}

/** For debug builds and tests: prints instead of sending. */
class LogcatCrashReporter @Inject constructor() : CrashReporter {
    override fun setCollectionEnabled(enabled: Boolean) = Unit
    override fun setUserId(id: String?) = Unit
    override fun setKey(key: String, value: String) = android.util.Log.d("Crash", "$key=$value")
    override fun log(message: String) = android.util.Log.d("Crash", message)
    override fun recordNonFatal(throwable: Throwable, keys: Map<String, String>) = android.util.Log.w("Crash", keys.toString(), throwable)
}
```

`com.google.firebase.crashlytics.crashlytics` is the accessor import. Use an opaque, app-generated user id, never an email.

### Hilt binding per build type

```kotlin
@Module @InstallIn(SingletonComponent::class)
object DiagnosticsModule {
    @Provides @Singleton
    fun crashReporter(firebase: FirebaseCrashReporter, logcat: LogcatCrashReporter): CrashReporter =
        if (BuildConfig.DEBUG) logcat else firebase
}
```

### Consent wiring

```kotlin
class DiagnosticsConsentObserver @Inject constructor(
    private val settings: SettingsRepository,
    private val reporter: CrashReporter,
    @ApplicationScope private val scope: CoroutineScope,
) {
    fun start() {
        scope.launch {
            settings.settings.map { it.crashReportingEnabled }.distinctUntilChanged().collect { reporter.setCollectionEnabled(it) }
        }
    }
}
```

Call `start()` from `Application.onCreate`. The consent default lives in DataStore; see [analytics-events](../analytics-events/README.md) for the same pattern with Analytics and a combined consent screen.

### Reporting from the error layer

```kotlin
class RemoteArticleRepository @Inject constructor(
    private val api: ArticleApi,
    private val reporter: CrashReporter,
) : ArticleRepository {
    override suspend fun articles(page: Int): NetworkResult<List<Article>> {
        reporter.log("articles page=$page")
        return safeCall { api.list(page).map { it.toDomain() } }.also { result ->
            if (result is NetworkResult.Unexpected) reporter.recordNonFatal(result.cause, mapOf("endpoint" to "articles", "page" to "$page"))
        }
    }
}
```

Do not report `Offline` or expected HTTP errors; they drown real signals. Report parsing failures, invariant violations and anything that forced a fallback.

### Coroutine exception handler

Uncaught exceptions in `viewModelScope` crash the app and reach Crashlytics automatically. For an application scope where you prefer to log and continue:

```kotlin
@Provides @Singleton @ApplicationScope
fun applicationScope(reporter: CrashReporter, @DefaultDispatcher dispatcher: CoroutineDispatcher): CoroutineScope =
    CoroutineScope(SupervisorJob() + dispatcher + CoroutineExceptionHandler { _, t -> reporter.recordNonFatal(t) })
```

## Verify

```sh
./gradlew :app:assembleRelease
./gradlew :app:uploadCrashlyticsMappingFileRelease   # normally runs as part of assembleRelease; explicit to confirm
adb shell setprop log.tag.FirebaseCrashlytics DEBUG
adb logcat -s FirebaseCrashlytics                     # "Crashlytics report upload complete" after relaunch
```

Force a crash from a debug-only menu item to confirm the pipeline end to end:

```kotlin
TextButton(onClick = { throw RuntimeException("Crashlytics test crash") }) { Text("Test crash") }
```

Crashlytics sends reports on the next launch; relaunch the app and watch the console within a few minutes. Non-fatal path unit test:

```kotlin
@Test fun unexpectedErrorsAreRecorded() = runTest {
    val reporter = RecordingCrashReporter()
    val repo = RemoteArticleRepository(api = FailingApi(SerializationException("bad json")), reporter = reporter)
    repo.articles(1)
    assertEquals(1, reporter.nonFatals.size)
    assertEquals("articles", reporter.lastKeys["endpoint"])
}
```

Report "pipeline verified" only after a test crash appears in the Firebase console for the build in question.

## Pitfalls

- Missing mapping-file upload shows obfuscated traces; confirm `mappingFileUploadEnabled` for release and that the plugin task ran.
- Calling `recordException` for every caught error, including cancellations and offline, makes the dashboard useless. Filter.
- Setting the user id to an email or name is a privacy issue; use an internal id and document it in the Data safety form.
- Crash reports are sent at next launch, so a crash loop on startup can suppress uploads; the SDK handles this partly, but fix startup crashes first.
- The `firebase_crashlytics_collection_enabled=false` meta-data without a runtime enable means you collect nothing in production; the consent observer must run.
- `deleteUnsentReports()` discards queued reports when the user opts out; call it, do not just stop future collection.
- Debug builds flood the project with developer crashes; the `BuildConfig.DEBUG` switch keeps them local.

## Sources

- https://firebase.google.com/docs/crashlytics/get-started?platform=android
- https://firebase.google.com/docs/crashlytics/customize-crash-reports?platform=android
- https://firebase.google.com/docs/crashlytics/get-deobfuscated-reports?platform=android
- https://firebase.google.com/docs/crashlytics/test-implementation?platform=android
- https://firebase.google.com/support/release-notes/android
