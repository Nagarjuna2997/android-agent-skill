# Offline-first sync

Pull-based synchronization of several Room tables from a server with change-list versioning, the way Now in Android does it (see [../../references/nowinandroid.md](../../references/nowinandroid.md)): a `Synchronizer` / `Syncable` contract, a generic `changeListSync` helper that reads the last-applied version from Proto DataStore and applies deletes and updates to Room, a `@HiltWorker` `CoroutineWorker` that runs every syncable repository in parallel with WorkManager 2.12.0, a `SyncManager` exposing `isSyncing: Flow<Boolean>` for the UI, a conflict strategy for local edits, and tests.

## When to use

- The server can answer "what changed since version N" for each resource. Without a change list you are left with full snapshots, which [../../patterns/repository.md](../../patterns/repository.md) already covers with `refresh()` and `applyServerSnapshot`.
- Several tables need to sync as one unit on app start, on a periodic schedule and on user request, with one place that knows whether a sync is running.
- Reads must always come from Room; the network only writes into Room. This recipe assumes that, and the pending-flag push from [../../patterns/repository.md](../../patterns/repository.md) handles the upload direction.
- Not for real-time data (use a socket or Firestore listeners), not for user-generated content that must be visible to other users within seconds, and not when the backend is Firestore, whose SDK already syncs.

## Dependencies

`gradle/libs.versions.toml`:

```toml
[versions]
workmanager = "2.12.0"
androidxHilt = "1.4.0"
room = "2.8.5"
datastore = "1.2.1"

[libraries]
androidx-work-runtime = { group = "androidx.work", name = "work-runtime-ktx", version.ref = "workmanager" }
androidx-work-testing = { group = "androidx.work", name = "work-testing", version.ref = "workmanager" }
androidx-hilt-work = { group = "androidx.hilt", name = "hilt-work", version.ref = "androidxHilt" }
androidx-hilt-compiler = { group = "androidx.hilt", name = "hilt-compiler", version.ref = "androidxHilt" }
androidx-tracing = { group = "androidx.tracing", name = "tracing-ktx", version = "<version>" }   # androidx releases page
```

`sync/work/build.gradle.kts` (or `app` in a single-module project):

```kotlin
plugins {
    id("com.example.android.library")
    id("com.example.android.library.hilt")
}
android { namespace = "com.example.app.sync" }
dependencies {
    implementation(project(":core:data"))
    implementation(project(":core:datastore"))
    implementation(project(":core:common"))
    implementation(libs.androidx.work.runtime)
    implementation(libs.androidx.hilt.work)
    implementation(libs.androidx.tracing)
    ksp(libs.androidx.hilt.compiler)
    androidTestImplementation(libs.androidx.work.testing)
}
```

The `Synchronizer`/`Syncable` interfaces and `changeListSync` live in `:core:data` next to the repositories; only the worker and `SyncManager` implementation live in `:sync:work`. `:app` depends on `:sync:work` and nothing else does, which keeps WorkManager out of feature modules.

## Manifest and permissions

`INTERNET`. Hilt's `HiltWorkerFactory` must be installed in `Application` (the `Configuration.Provider` setup from [../work-manager/README.md](../work-manager/README.md), with the default `WorkManagerInitializer` removed from `AndroidManifest.xml`). If the worker runs as foreground work on API 33+, `POST_NOTIFICATIONS` for its notification; `FOREGROUND_SERVICE_DATA_SYNC` and `foregroundServiceType="dataSync"` on API 34+.

## Implementation

### Server contract

```kotlin
package com.example.app.core.network.model

import kotlinx.serialization.Serializable

/** One entry of GET /changelist/notes?after={version}: ordered by changeListVersion ascending. */
@Serializable
data class NetworkChangeList(
    val id: String,
    val changeListVersion: Int,
    val isDelete: Boolean,
)
```

```kotlin
interface AppApi {
    suspend fun getNotesChangeList(after: Int): List<NetworkChangeList>
    suspend fun getNotes(ids: List<String>): List<NetworkNote>
    suspend fun getTagsChangeList(after: Int): List<NetworkChangeList>
    suspend fun getTags(ids: List<String>): List<NetworkTag>
}
```

The version is a monotonically increasing integer per resource type. `after = -1` (or `0`) returns everything, which is the first-install path.

### Versions in Proto DataStore

Add one `int32 <table>_change_list_version` field per synced table to the `UserPreferences` schema from [../datastore-proto/README.md](../datastore-proto/README.md) and expose them as one value:

```kotlin
package com.example.app.core.datastore

/** Last change-list version applied locally, per synced table. -1 means never synced. */
data class ChangeListVersions(
    val notesVersion: Int = -1,
    val tagsVersion: Int = -1,
)

// In UserPreferencesDataSource:
suspend fun getChangeListVersions(): ChangeListVersions = store.data
    .map { ChangeListVersions(notesVersion = it.notesChangeListVersion, tagsVersion = it.tagsChangeListVersion) }
    .first()

suspend fun updateChangeListVersions(update: ChangeListVersions.() -> ChangeListVersions) {
    store.updateData { current ->
        val next = ChangeListVersions(current.notesChangeListVersion, current.tagsChangeListVersion).update()
        current.copy {
            notesChangeListVersion = next.notesVersion
            tagsChangeListVersion = next.tagsVersion
        }
    }
}
```

Storing versions next to the user's preferences (not in Room) means clearing the database on logout also needs `updateChangeListVersions { ChangeListVersions() }`; put both in the same `clearLocalData()` function.

### Synchronizer and Syncable

```kotlin
package com.example.app.core.data.sync

import com.example.app.core.datastore.ChangeListVersions
import com.example.app.core.network.model.NetworkChangeList
import kotlin.coroutines.cancellation.CancellationException

/** Owns the version store and guarantees that syncables run one at a time per table. */
interface Synchronizer {
    suspend fun getChangeListVersions(): ChangeListVersions
    suspend fun updateChangeListVersions(update: ChangeListVersions.() -> ChangeListVersions)

    /** Lets the worker write `repository.sync()` instead of `repository.syncWith(this)`. */
    suspend fun Syncable.sync(): Boolean = syncWith(this@Synchronizer)
}

/** A repository that mirrors a remote table. Returns false when the sync should be retried. */
interface Syncable {
    suspend fun syncWith(synchronizer: Synchronizer): Boolean
}

/**
 * Generic pull: read the local version, fetch the change list after it, delete what the server deleted,
 * upsert what changed, then record the newest version. Blocks are never run concurrently for one table.
 */
suspend fun Synchronizer.changeListSync(
    versionReader: (ChangeListVersions) -> Int,
    changeListFetcher: suspend (after: Int) -> List<NetworkChangeList>,
    versionUpdater: ChangeListVersions.(latest: Int) -> ChangeListVersions,
    modelDeleter: suspend (ids: List<String>) -> Unit,
    modelUpdater: suspend (ids: List<String>) -> Unit,
): Boolean = suspendRunCatching {
    val current = versionReader(getChangeListVersions())
    val changes = changeListFetcher(current)
    if (changes.isEmpty()) return@suspendRunCatching

    val (deleted, updated) = changes.partition(NetworkChangeList::isDelete)
    modelDeleter(deleted.map(NetworkChangeList::id))
    modelUpdater(updated.map(NetworkChangeList::id))

    // Only after both writes succeeded; a crash before this line replays the same change list next time.
    updateChangeListVersions { versionUpdater(changes.last().changeListVersion) }
}.isSuccess

/** runCatching that keeps structured concurrency intact. */
private suspend fun <T> suspendRunCatching(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    Result.failure(e)
}
```

The pattern is "fetch then pull", as with git: the change list says what moved, the batched `getNotes(ids)` call brings the bodies. For a server that sends bodies inside the change list, make `modelUpdater` take the entries directly.

### A syncable repository

```kotlin
package com.example.app.core.data.repository

import com.example.app.core.data.sync.Synchronizer
import com.example.app.core.data.sync.changeListSync
import com.example.app.core.database.NoteDao
import com.example.app.core.database.NoteEntity
import com.example.app.core.datastore.ChangeListVersions
import com.example.app.core.model.Note
import com.example.app.core.network.AppApi
import com.example.app.core.network.model.NetworkNote
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject

internal class OfflineFirstNotesRepository @Inject constructor(
    private val dao: NoteDao,
    private val api: AppApi,
) : NotesRepository {

    override fun observeAll(): Flow<List<Note>> = dao.observeAll().map { rows -> rows.map(NoteEntity::toDomain) }

    override suspend fun syncWith(synchronizer: Synchronizer): Boolean = synchronizer.changeListSync(
        versionReader = ChangeListVersions::notesVersion,
        changeListFetcher = { after -> api.getNotesChangeList(after) },
        versionUpdater = { latest -> copy(notesVersion = latest) },
        modelDeleter = { ids ->
            val pending = dao.pendingIds().toSet()
            dao.deleteByIds(ids.filterNot { it in pending })
        },
        modelUpdater = { ids ->
            val pending = dao.pendingIds().toSet()
            // Chunk so a first install with thousands of ids does not build one giant URL.
            ids.chunked(100).forEach { chunk ->
                val notes = api.getNotes(chunk).filterNot { it.id in pending }
                dao.upsertAll(notes.map(NetworkNote::toEntity))
            }
        },
    )
}
```

`NotesRepository` extends `Syncable`, so the interface the ViewModel sees is unchanged and the worker can hold a `NotesRepository` and call `sync()` on it.

### Conflict strategy

The server is the source of truth for everything it has acknowledged; local unsynced edits win until pushed. Concretely:

1. Rows with a pending local change (the `pending` column from [../../patterns/repository.md](../../patterns/repository.md)) are excluded from both the delete and the upsert in the syncable above, so a pull cannot clobber an edit the user has not uploaded yet.
2. The push (`pushPending()`) runs first in the worker. After a successful push the server's change list includes the row again at a newer version, and the next pull writes the server's canonical copy, including any server-side normalization.
3. If the push fails with a conflict (HTTP 409), the repository keeps the local row pending and records the server's version of the row in a `conflict` column; the UI offers "keep mine" or "take theirs". Do not resolve silently by timestamp unless the domain is genuinely last-write-wins (a toggle, a read marker).
4. A delete the server reports for a row the user edited offline is deferred until the push resolves; the row stays visible with its pending flag. This is the one case where the user sees stale data on purpose.

Tables with no local writes (reference data such as tags) skip all of this; their syncable uses `dao::deleteByIds` and `dao::upsertAll` directly.

### Sync worker

```kotlin
package com.example.app.sync.workers

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.tracing.traceAsync
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkerParameters
import com.example.app.core.common.IoDispatcher
import com.example.app.core.data.repository.NotesRepository
import com.example.app.core.data.repository.TagsRepository
import com.example.app.core.data.sync.Synchronizer
import com.example.app.core.datastore.ChangeListVersions
import com.example.app.core.datastore.UserPreferencesDataSource
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/** The one place that knows every syncable. Implements Synchronizer so repositories can read and write versions. */
@HiltWorker
internal class SyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val preferences: UserPreferencesDataSource,
    private val notes: NotesRepository,
    private val tags: TagsRepository,
    @IoDispatcher private val io: CoroutineDispatcher,
) : CoroutineWorker(appContext, params), Synchronizer {

    override suspend fun doWork(): Result = withContext(io) {
        traceAsync("Sync", 0) {
            // Upload first so the pull below sees the server's acknowledged versions.
            val pushed = notes.pushPending().isSuccess
            // Independent tables in parallel; each syncable serializes its own table.
            val pulled = awaitAll(
                async { tags.sync() },
                async { notes.sync() },
            ).all { it }
            if (pushed && pulled) Result.success()
            else if (runAttemptCount < MAX_ATTEMPTS) Result.retry()
            else Result.failure()
        }
    }

    override suspend fun getChangeListVersions(): ChangeListVersions = preferences.getChangeListVersions()

    override suspend fun updateChangeListVersions(update: ChangeListVersions.() -> ChangeListVersions) =
        preferences.updateChangeListVersions(update)

    companion object {
        const val UNIQUE_NAME = "app-sync"            // changing this allows two syncs to run concurrently; do not
        const val PERIODIC_NAME = "app-sync-periodic"
        private const val MAX_ATTEMPTS = 5

        private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Expedited on app start and on pull-to-refresh; falls back to normal work when quota is exhausted. */
        fun startUpSyncWork() = OneTimeWorkRequestBuilder<SyncWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(constraints)
            .build()

        fun periodicSyncWork() = PeriodicWorkRequestBuilder<SyncWorker>(6, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build()
    }
}
```

`traceAsync` puts a "Sync" slice in Perfetto traces so sync time shows up in startup profiling. `Result.retry()` uses WorkManager's exponential backoff (30 s default, doubling); cap attempts so a broken server does not retry forever.

### SyncManager

The UI never touches WorkManager. It sees an interface in `:core:data`:

```kotlin
package com.example.app.core.data.sync

import kotlinx.coroutines.flow.Flow

interface SyncManager {
    /** True while a sync worker is RUNNING. Drives the refresh indicator. */
    val isSyncing: Flow<Boolean>
    fun requestSync()
}
```

```kotlin
package com.example.app.sync.status

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.example.app.core.data.sync.SyncManager
import com.example.app.sync.workers.SyncWorker
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.map
import javax.inject.Inject

internal class WorkManagerSyncManager @Inject constructor(
    @ApplicationContext private val context: Context,
) : SyncManager {
    private val workManager get() = WorkManager.getInstance(context)

    override val isSyncing: Flow<Boolean> =
        workManager.getWorkInfosForUniqueWorkFlow(SyncWorker.UNIQUE_NAME)
            .map { infos -> infos.any { it.state == WorkInfo.State.RUNNING } }
            .conflate()

    override fun requestSync() {
        // KEEP: a request while one is queued or running is a no-op, so pull-to-refresh cannot stack syncs.
        workManager.enqueueUniqueWork(SyncWorker.UNIQUE_NAME, ExistingWorkPolicy.KEEP, SyncWorker.startUpSyncWork())
    }

    /** Called once from Application.onCreate. */
    fun initialize() {
        requestSync()
        workManager.enqueueUniquePeriodicWork(
            SyncWorker.PERIODIC_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            SyncWorker.periodicSyncWork(),
        )
    }
}
```

```kotlin
// sync/work/src/main/kotlin/com/example/app/sync/di/SyncModule.kt
@Module
@InstallIn(SingletonComponent::class)
internal abstract class SyncModule {
    @Binds abstract fun bindSyncManager(impl: WorkManagerSyncManager): SyncManager
}
```

`Application.onCreate` injects `SyncManager`, casts nothing, and calls `requestSync()`; the periodic enqueue can go in an `androidx.startup` initializer or the same `onCreate`. With `ExistingWorkPolicy.KEEP` and a stable unique name there is never more than one sync worker in flight.

### ViewModel and UI

```kotlin
@HiltViewModel
class NotesViewModel @Inject constructor(
    notes: NotesRepository,
    private val syncManager: SyncManager,
) : ViewModel() {
    val uiState: StateFlow<NotesUiState> = combine(notes.observeAll(), syncManager.isSyncing) { items, syncing ->
        NotesUiState(items = items, isSyncing = syncing)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), NotesUiState())

    fun onRefresh() = syncManager.requestSync()
}
```

In Compose, `PullToRefreshBox(isRefreshing = state.isSyncing, onRefresh = onRefresh) { LazyColumn { ... } }` (Material 3 1.4.0). The indicator reflects the real worker state, so a refresh triggered by the periodic schedule shows too.

## Verify

```sh
./gradlew :core:data:testDebugUnitTest --tests "*ChangeListSyncTest*"
./gradlew :sync:work:connectedDebugAndroidTest --tests "*SyncWorkerTest*"
./gradlew :app:assembleDebug
adb shell dumpsys jobscheduler | grep -A3 com.example.app        # scheduled sync job and constraints
adb shell cmd jobscheduler run -f com.example.app <jobId>        # force the periodic job now
```

JVM test of the helper with an in-memory synchronizer and a fake API:

```kotlin
class ChangeListSyncTest {
    private class InMemorySynchronizer : Synchronizer {
        var versions = ChangeListVersions()
        override suspend fun getChangeListVersions() = versions
        override suspend fun updateChangeListVersions(update: ChangeListVersions.() -> ChangeListVersions) { versions = versions.update() }
    }

    @Test
    fun appliesDeletesAndUpdatesThenRecordsLatestVersion() = runTest {
        val sync = InMemorySynchronizer()
        val deleted = mutableListOf<String>(); val updated = mutableListOf<String>()
        val ok = sync.changeListSync(
            versionReader = ChangeListVersions::notesVersion,
            changeListFetcher = { after ->
                assertEquals(-1, after)
                listOf(NetworkChangeList("a", 7, isDelete = true), NetworkChangeList("b", 9, isDelete = false))
            },
            versionUpdater = { latest -> copy(notesVersion = latest) },
            modelDeleter = { deleted += it },
            modelUpdater = { updated += it },
        )
        assertTrue(ok)
        assertEquals(listOf("a"), deleted)
        assertEquals(listOf("b"), updated)
        assertEquals(9, sync.versions.notesVersion)
    }

    @Test
    fun failedUpdaterLeavesVersionUntouchedAndReturnsFalse() = runTest {
        val sync = InMemorySynchronizer()
        val ok = sync.changeListSync(
            versionReader = ChangeListVersions::notesVersion,
            changeListFetcher = { listOf(NetworkChangeList("b", 9, isDelete = false)) },
            versionUpdater = { latest -> copy(notesVersion = latest) },
            modelDeleter = {},
            modelUpdater = { throw IOException("server down") },
        )
        assertFalse(ok)
        assertEquals(-1, sync.versions.notesVersion)
    }
}
```

Instrumented worker test with `TestListenableWorkerBuilder` and Hilt's `HiltWorkerFactory`, asserting `Result.success()` with fake repositories, follows [../work-manager/README.md](../work-manager/README.md). A sync that was only unit-tested is "built and unit-tested"; say so, and run the worker on an emulator with airplane mode toggled before claiming the constraints work.

## Pitfalls

- Recording the version before the writes finish. A crash between "version stored" and "rows upserted" loses those changes permanently. The helper updates the version last; keep that order.
- Two unique work names (one for startup, one for refresh) for the same worker let two syncs run at once and race on the same table. One `UNIQUE_NAME` with `KEEP`.
- `Result.retry()` without a cap plus a server bug equals a battery drain. Check `runAttemptCount`.
- Change lists that are not ordered by version make `changes.last().changeListVersion` wrong. Sort client-side if the contract does not promise ordering.
- `getWorkInfosForUniqueWorkFlow` emits on every state change including ENQUEUED and SUCCEEDED; map to RUNNING and `conflate()` or the refresh indicator flickers.
- Catching `Exception` in `suspendRunCatching` without rethrowing `CancellationException` turns worker cancellation (user swiped the app away, constraints lost) into a reported failure and a retry.
- A pull that upserts rows with pending local edits silently discards the user's work. Filter on the pending set as the syncable above does, and have a test for it.
- Expedited work on API 30 and below runs as a foreground service and requires `getForegroundInfo()`; without it WorkManager throws `IllegalStateException` on those devices. Implement it or drop `setExpedited`.
- `isolated-projects` and `WorkManager.getInstance(context)` are unrelated, but `WorkManager.getInstance` before `Configuration.Provider` is set up (an `androidx.startup` initializer that runs too early) throws. Initialize sync from `Application.onCreate` after Hilt injection.

## Sources

- https://developer.android.com/topic/architecture/data-layer/offline-first
- https://developer.android.com/topic/architecture/data-layer
- https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started
- https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work
- https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work
- https://developer.android.com/training/dependency-injection/hilt-jetpack#workmanager
- https://developer.android.com/jetpack/androidx/releases/work
- https://developer.android.com/topic/performance/tracing/custom-events
