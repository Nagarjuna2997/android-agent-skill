# WorkManager background work

Deferrable, guaranteed background work with WorkManager 2.12.0: a Hilt-injected `CoroutineWorker`, one-time and periodic requests, constraints, expedited work, foreground (long-running) work with a notification, unique work policies, observing status from a ViewModel and a `TestListenableWorkerBuilder` test.

## When to use

- Work that must run even if the user leaves the app or the device restarts: syncing, uploading, cleaning caches, periodic refresh.
- Do not use it for work that must happen at an exact time (use `AlarmManager` with the exact-alarm permission policy) or for work that only matters while the UI is open (use `viewModelScope`).
- Expedited work is for short, user-visible tasks that should start as soon as possible (for example sending a message). Foreground work is for long tasks the user expects to see progress for (large uploads).

## Dependencies

`gradle/libs.versions.toml`:

```toml
[versions]
workmanager = "2.12.0"
androidx-hilt = "1.4.0"

[libraries]
work-runtime = { group = "androidx.work", name = "work-runtime-ktx", version.ref = "workmanager" }
work-testing = { group = "androidx.work", name = "work-testing", version.ref = "workmanager" }
androidx-hilt-work = { group = "androidx.hilt", name = "hilt-work", version.ref = "androidx-hilt" }
androidx-hilt-compiler = { group = "androidx.hilt", name = "hilt-compiler", version.ref = "androidx-hilt" }
```

`app/build.gradle.kts`:

```kotlin
dependencies {
    implementation(libs.work.runtime)
    implementation(libs.androidx.hilt.work)
    ksp(libs.androidx.hilt.compiler)
    androidTestImplementation(libs.work.testing)
}
```

## Manifest and permissions

Disable the default initializer so the Hilt worker factory is used, and declare the foreground service type if you run foreground work:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<application ...>
    <provider
        android:name="androidx.startup.InitializationProvider"
        android:authorities="${applicationId}.androidx-startup"
        android:exported="false"
        tools:node="merge">
        <meta-data
            android:name="androidx.work.WorkManagerInitializer"
            android:value="androidx.startup"
            tools:node="remove" />
    </provider>

    <service
        android:name="androidx.work.impl.foreground.SystemForegroundService"
        android:foregroundServiceType="dataSync"
        tools:node="merge" />
</application>
```

`FOREGROUND_SERVICE_DATA_SYNC` is the type for uploads and syncs on API 34+. Pick the type that matches the work; Play rejects apps whose declared type does not match the use.

## Implementation

### Worker

```kotlin
package com.example.app.work

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.example.app.data.SyncRepository
import com.example.app.notifications.SyncNotifications
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.coroutines.CancellationException
import java.io.IOException

@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val repository: SyncRepository,
    private val notifications: SyncNotifications,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val full = inputData.getBoolean(KEY_FULL, false)
        return try {
            val count = repository.sync(full = full) { progress ->
                setProgress(workDataOf(KEY_PROGRESS to progress))
            }
            Result.success(workDataOf(KEY_SYNCED to count))
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val notification = notifications.progressNotification(applicationContext)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val KEY_FULL = "full"
        const val KEY_PROGRESS = "progress"
        const val KEY_SYNCED = "synced"
        const val NOTIFICATION_ID = 1001
        private const val MAX_RETRIES = 3
    }
}
```

`getForegroundInfo()` is called when the request uses `setExpedited(...)` on API < 31, or when the worker calls `setForeground(...)` for long-running work. The notification channel must exist before this runs; see [notifications](../notifications/README.md).

### Hilt wiring

```kotlin
@HiltAndroidApp
class App : Application(), Configuration.Provider {
    @Inject lateinit var workerFactory: HiltWorkerFactory

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .setMinimumLoggingLevel(if (BuildConfig.DEBUG) Log.DEBUG else Log.ERROR)
            .build()
}
```

With Koin use `workManagerFactory()` and `workerOf(::SyncWorker)` as shown in [koin-di](../koin-di/README.md).

### Scheduler

```kotlin
package com.example.app.work

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SyncScheduler @Inject constructor(@ApplicationContext private val context: Context) {
    private val workManager get() = WorkManager.getInstance(context)

    /** User-triggered: start as soon as possible, fall back to a normal request if quota is exhausted. */
    fun syncNow() {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))
            .setInputData(workDataOf(SyncWorker.KEY_FULL to false))
            .build()
        workManager.enqueueUniqueWork(SYNC_NOW, ExistingWorkPolicy.KEEP, request)
    }

    /** Runs roughly every 6 hours on unmetered network while charging; survives reboot. */
    fun schedulePeriodic() {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(6, TimeUnit.HOURS, 30, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.UNMETERED)
                    .setRequiresBatteryNotLow(true)
                    .build()
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.MINUTES)
            .setInputData(workDataOf(SyncWorker.KEY_FULL to true))
            .build()
        workManager.enqueueUniquePeriodicWork(SYNC_PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    fun cancelAll() {
        workManager.cancelUniqueWork(SYNC_NOW)
        workManager.cancelUniqueWork(SYNC_PERIODIC)
    }

    val status: Flow<SyncStatus> = workManager.getWorkInfosForUniqueWorkFlow(SYNC_NOW).map { infos ->
        val info = infos.firstOrNull() ?: return@map SyncStatus.Idle
        when (info.state) {
            WorkInfo.State.RUNNING -> SyncStatus.Running(info.progress.getInt(SyncWorker.KEY_PROGRESS, 0))
            WorkInfo.State.ENQUEUED, WorkInfo.State.BLOCKED -> SyncStatus.Queued
            WorkInfo.State.SUCCEEDED -> SyncStatus.Done(info.outputData.getInt(SyncWorker.KEY_SYNCED, 0))
            WorkInfo.State.FAILED -> SyncStatus.Failed
            WorkInfo.State.CANCELLED -> SyncStatus.Idle
        }
    }

    private companion object {
        const val SYNC_NOW = "sync-now"
        const val SYNC_PERIODIC = "sync-periodic"
    }
}

sealed interface SyncStatus {
    data object Idle : SyncStatus
    data object Queued : SyncStatus
    data class Running(val percent: Int) : SyncStatus
    data class Done(val count: Int) : SyncStatus
    data object Failed : SyncStatus
}
```

`ExistingPeriodicWorkPolicy.UPDATE` keeps the existing schedule and swaps in new constraints; `KEEP` ignores the new request if one exists; `REPLACE` cancels and restarts the timer. Minimum periodic interval is 15 minutes and the OS may delay execution; it is not a precise timer.

Call `schedulePeriodic()` from `Application.onCreate` or after sign-in; it is idempotent with `UPDATE`.

### ViewModel

```kotlin
@HiltViewModel
class SyncViewModel @Inject constructor(private val scheduler: SyncScheduler) : ViewModel() {
    val status: StateFlow<SyncStatus> = scheduler.status
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SyncStatus.Idle)

    fun onSyncClicked() = scheduler.syncNow()
}
```

The UI shows a button in `Idle`/`Done`/`Failed`, a disabled button with a spinner in `Queued`, and a `LinearProgressIndicator(progress = { percent / 100f })` in `Running`.

### Long-running foreground work

For a task longer than ten minutes (the expedited and normal-work limit), call `setForeground(getForegroundInfo())` at the top of `doWork()`. On API 34+ the service type declared in the manifest must match the `ForegroundInfo` type.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:connectedDebugAndroidTest --tests "*SyncWorkerTest*"
adb shell dumpsys jobscheduler | grep -A3 com.example.app     # shows pending WorkManager jobs
adb shell cmd jobscheduler run -f com.example.app <jobId>     # force a job to run now
```

Worker test with `work-testing`:

```kotlin
@RunWith(AndroidJUnit4::class)
class SyncWorkerTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test fun successReturnsSyncedCount() = runTest {
        val fakeRepo = FakeSyncRepository(itemsToSync = 3)
        val worker = TestListenableWorkerBuilder<SyncWorker>(context)
            .setWorkerFactory(object : WorkerFactory() {
                override fun createWorker(ctx: Context, cls: String, params: WorkerParameters) =
                    SyncWorker(ctx, params, fakeRepo, FakeSyncNotifications())
            })
            .setInputData(workDataOf(SyncWorker.KEY_FULL to true))
            .build()

        val result = worker.doWork()

        assertEquals(ListenableWorker.Result.success(workDataOf(SyncWorker.KEY_SYNCED to 3)), result)
    }
}
```

For end-to-end scheduling, initialize `WorkManagerTestInitHelper.initializeTestWorkManager(context)` in `@Before`, enqueue through `SyncScheduler`, then drive constraints with `testDriver.setAllConstraintsMet(id)` and assert `WorkInfo.State.SUCCEEDED`.

## Pitfalls

- Forgetting to remove `WorkManagerInitializer` while providing a custom `Configuration` throws `IllegalStateException: WorkManager is already initialized` at startup.
- Catching `Exception` in `doWork` without rethrowing `CancellationException` turns a cancelled worker into a reported failure and may keep running after `cancelUniqueWork`.
- `Result.retry()` honors the backoff policy, which defaults to 30 seconds exponential; set it explicitly and cap attempts with `runAttemptCount`.
- Expedited work on API 31+ has a system quota; use `RUN_AS_NON_EXPEDITED_WORK_REQUEST` so the request still runs when quota is exhausted.
- A `CoroutineWorker` is killed after about ten minutes. Longer tasks must call `setForeground`, and the notification requires `POST_NOTIFICATIONS` on API 33+ to be visible; the service still runs without it.
- Do not store large payloads in `Data`; it is limited to 10 KB. Pass ids and read from the database.
- Periodic work is not for exact timing; the first run can be delayed by up to the flex interval plus Doze.
- Enqueueing from `Application.onCreate` on every start is fine with `KEEP` or `UPDATE`; with `REPLACE` the periodic timer resets on every launch and the work may never run.

## Sources

- https://developer.android.com/develop/background-work/background-tasks/persistent
- https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work
- https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running
- https://developer.android.com/develop/background-work/background-tasks/testing/persistent
- https://developer.android.com/jetpack/androidx/releases/work
- https://developer.android.com/develop/background-work/services/fgs/service-types
