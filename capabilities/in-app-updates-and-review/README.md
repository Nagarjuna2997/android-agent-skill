# In-app updates and in-app review

Play In-App Updates (flexible and immediate) and the In-App Review prompt through the Play Core split libraries: an `UpdateManager` wrapped behind an interface, `AppUpdateManager` checks on launch with an `ActivityResultLauncher`, flexible download progress and install prompt, immediate updates for critical releases, a `ReviewManager` request gated on a usage heuristic, and testing with the fake managers and internal app sharing.

## When to use

- The app is distributed on Google Play and you want users on a supported version without nagging them to visit the store.
- In-app review asks for a Play rating from inside the app. Play controls when the dialog is actually shown (quota), so the request is a hint, not a guarantee, and must never be tied to a reward or a "rate us" button that promises a dialog.
- Neither API works on sideloaded builds, on devices without Play, or on other stores.

## Dependencies

Play Core libraries are versioned independently and not in `data/versions.json`; resolve from the release pages.

```toml
[versions]
play-app-update = "<version>"   # https://developer.android.com/reference/com/google/android/play/core/release-notes-in_app_updates
play-review = "<version>"       # https://developer.android.com/reference/com/google/android/play/core/release-notes-in_app_reviews

[libraries]
play-app-update-ktx = { group = "com.google.android.play", name = "app-update-ktx", version.ref = "play-app-update" }
play-review-ktx = { group = "com.google.android.play", name = "review-ktx", version.ref = "play-review" }
```

```kotlin
dependencies {
    implementation(libs.play.app.update.ktx)
    implementation(libs.play.review.ktx)
}
```

The monolithic `com.google.android.play:core` artifact is retired; use the split artifacts above.

## Manifest and permissions

None. Flexible updates need the app to have been installed from Play with the same signing key; internal app sharing builds satisfy that for testing.

## Implementation

### Update manager

```kotlin
package com.example.app.updates

import android.content.Context
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import com.google.android.play.core.ktx.requestAppUpdateInfo
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

sealed interface UpdateState {
    data object None : UpdateState
    data class Available(val immediate: Boolean, val stalenessDays: Int?) : UpdateState
    data class Downloading(val percent: Int) : UpdateState
    data object Downloaded : UpdateState          // flexible: prompt to complete
    data object Failed : UpdateState
}

interface UpdateRepository {
    suspend fun check(): UpdateState
    fun start(launcher: ActivityResultLauncher<IntentSenderRequest>, immediate: Boolean): Boolean
    fun installState(): Flow<UpdateState>
    fun completeFlexible()
}

@Singleton
class PlayUpdateRepository @Inject constructor(@ApplicationContext context: Context) : UpdateRepository {
    private val manager: AppUpdateManager = AppUpdateManagerFactory.create(context)

    override suspend fun check(): UpdateState {
        val info = try { manager.requestAppUpdateInfo() } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (e: Exception) { return UpdateState.None }
        return when {
            info.installStatus() == InstallStatus.DOWNLOADED -> UpdateState.Downloaded
            info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS ->
                UpdateState.Available(immediate = true, stalenessDays = null)
            info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE -> {
                val immediate = info.updatePriority() >= 4 && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)
                UpdateState.Available(immediate, info.clientVersionStalenessDays())
            }
            else -> UpdateState.None
        }
    }

    override fun start(launcher: ActivityResultLauncher<IntentSenderRequest>, immediate: Boolean): Boolean {
        val info = manager.appUpdateInfo.result ?: return false
        val type = if (immediate) AppUpdateType.IMMEDIATE else AppUpdateType.FLEXIBLE
        return manager.startUpdateFlowForResult(info, launcher, AppUpdateOptions.newBuilder(type).build())
    }

    override fun installState(): Flow<UpdateState> = callbackFlow {
        val listener = InstallStateUpdatedListener { state ->
            when (state.installStatus()) {
                InstallStatus.DOWNLOADING -> {
                    val total = state.totalBytesToDownload()
                    val pct = if (total > 0) (state.bytesDownloaded() * 100 / total).toInt() else 0
                    trySend(UpdateState.Downloading(pct))
                }
                InstallStatus.DOWNLOADED -> trySend(UpdateState.Downloaded)
                InstallStatus.FAILED, InstallStatus.CANCELED -> trySend(UpdateState.Failed)
                else -> Unit
            }
        }
        manager.registerListener(listener)
        awaitClose { manager.unregisterListener(listener) }
    }

    override fun completeFlexible() { manager.completeUpdate() }
}
```

`updatePriority` (0 to 5) is set per release through the Play Developer API; the recipe treats 4 and above as immediate. `clientVersionStalenessDays` lets you escalate a flexible update to immediate after, say, 14 days.

### Review manager

```kotlin
package com.example.app.review

import android.app.Activity
import android.content.Context
import com.google.android.play.core.review.ReviewManager
import com.google.android.play.core.review.ReviewManagerFactory
import com.google.android.play.core.ktx.requestReview
import com.google.android.play.core.ktx.launchReview
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

interface ReviewRepository {
    suspend fun maybeAskForReview(activity: Activity)
}

@Singleton
class PlayReviewRepository @Inject constructor(
    @ApplicationContext context: Context,
    private val settings: SettingsRepository,   // DataStore: launch count, last prompt time
) : ReviewRepository {
    private val manager: ReviewManager = ReviewManagerFactory.create(context)

    override suspend fun maybeAskForReview(activity: Activity) {
        val s = settings.settings.first()
        val eligible = s.completedTasks >= 5 && System.currentTimeMillis() - s.lastReviewPromptMillis > 60L * 24 * 3600 * 1000
        if (!eligible) return
        try {
            val info = manager.requestReview()
            manager.launchReview(activity, info)   // returns when the flow ends; the dialog may not have been shown
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // Review not available (no Play, quota). Nothing to show the user.
        } finally {
            settings.recordReviewPrompt(System.currentTimeMillis())
        }
    }
}
```

Trigger from a positive moment (after the user completes something), never from a button labelled "Rate us" that implies a dialog. Do not ask the user a question before the flow ("Do you like the app?"); Play policy forbids pre-filtering.

### ViewModel and Activity wiring

```kotlin
@HiltViewModel
class MainViewModel @Inject constructor(private val updates: UpdateRepository) : ViewModel() {
    private val _update = MutableStateFlow<UpdateState>(UpdateState.None)
    val update: StateFlow<UpdateState> = _update.asStateFlow()

    init {
        viewModelScope.launch { _update.value = updates.check() }
        viewModelScope.launch { updates.installState().collect { _update.value = it } }
    }

    fun start(launcher: ActivityResultLauncher<IntentSenderRequest>) {
        val s = _update.value as? UpdateState.Available ?: return
        updates.start(launcher, immediate = s.immediate)
    }

    fun complete() = updates.completeFlexible()
}

@Composable
fun UpdateBanner(viewModel: MainViewModel) {
    val state by viewModel.update.collectAsStateWithLifecycle()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) { /* user declined; for immediate updates re-check on resume */ }
    }
    when (val s = state) {
        is UpdateState.Available -> if (s.immediate) LaunchedEffect(Unit) { viewModel.start(launcher) }
            else Banner("An update is available", action = "Update" to { viewModel.start(launcher) })
        is UpdateState.Downloading -> LinearProgressIndicator(progress = { s.percent / 100f })
        UpdateState.Downloaded -> Banner("Update downloaded", action = "Restart" to viewModel::complete)
        else -> Unit
    }
}
```

For immediate updates also call `check()` in `onResume`; if the state is `DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS` restart the flow so the user cannot bypass it.

## Verify

```sh
./gradlew :app:bundleRelease
# Upload a lower versionCode to Internal app sharing, install it, then upload a higher one:
# https://play.google.com/console -> Internal app sharing. Open the lower build; the update banner should appear.
adb logcat -s PlayCore
./gradlew :app:testDebugUnitTest --tests "*MainViewModelTest*"
```

Unit tests use the fake managers that ship with the libraries (`FakeAppUpdateManager`, `FakeReviewManager`) through the repository interfaces:

```kotlin
@Test fun availableUpdateIsExposed() = runTest {
    val fake = FakeAppUpdateManager(ApplicationProvider.getApplicationContext()).apply {
        setUpdateAvailable(42, AppUpdateType.FLEXIBLE)
    }
    val repo = PlayUpdateRepository(fake)      // make the constructor accept AppUpdateManager for tests
    assertTrue(repo.check() is UpdateState.Available)
}
```

Run with Robolectric. The real behavior needs a Play-installed build; report "verified with fake manager" versus "verified via internal app sharing" separately.

## Pitfalls

- Calling `startUpdateFlowForResult` with a stale `AppUpdateInfo` (older than the current process) fails; re-request before starting.
- Flexible updates that are downloaded but never completed waste storage; prompt on next launch when `InstallStatus.DOWNLOADED`.
- Immediate updates must not be used for every release; reserve priority 4 and 5 for security or breaking-backend changes.
- The review dialog appearing is not guaranteed; never block the flow or show a "thank you" assuming it was shown.
- Requesting review too often or with incentives violates Play policy and can get the prompt disabled.
- Both APIs throw `InstallException`/`ReviewException` on non-Play installs; always catch and degrade silently.
- `FakeAppUpdateManager` does not drive `InstallStateUpdatedListener` unless you call its `downloadStarts()`, `setBytesDownloaded()` and `downloadCompletes()` helpers.

## Sources

- https://developer.android.com/guide/playcore/in-app-updates
- https://developer.android.com/guide/playcore/in-app-updates/kotlin-java
- https://developer.android.com/guide/playcore/in-app-updates/test
- https://developer.android.com/guide/playcore/in-app-review
- https://developer.android.com/guide/playcore/in-app-review/test
