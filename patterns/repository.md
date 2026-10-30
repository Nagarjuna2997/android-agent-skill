# Repository Pattern (offline-first with Room and a remote source)

A repository hides where data comes from. The ViewModel sees `Flow<List<TodoItem>>` and a few suspend functions; whether an item came from Room, the network, or a pending local write is the repository's business. This file builds a complete offline-first repository with Room 2.8.5 as the single source of truth.

```
ViewModel ──observeAll()──▶ Repository ──▶ Room DAO (Flow)  ◀── single source of truth
                               │                 ▲
                               │ refresh()       │ upsert
                               ▼                 │
                        Remote source (Retrofit) ─┘
                               ▲
                               │ push pending
                        Sync (WorkManager) ◀── local writes flagged pending
```

The principle: reads always come from Room. The network only ever writes into Room. Local writes go to Room first with a pending flag and are pushed later. The UI never waits on the network to show data.

## Domain contract

```kotlin
package com.example.app.domain.todo

import kotlinx.coroutines.flow.Flow

data class TodoItem(val id: String, val title: String, val isCompleted: Boolean, val updatedAtMs: Long)

interface TodoRepository {
    /** Emits from the local cache immediately and on every change. Never throws. */
    fun observeAll(): Flow<List<TodoItem>>

    /** Pulls the latest from the server into the cache. Returns a typed failure instead of throwing. */
    suspend fun refresh(): Result<Unit>

    suspend fun add(title: String)
    suspend fun setCompleted(id: String, completed: Boolean)
    suspend fun delete(id: String)

    /** Pushes pending local changes. Called by the sync worker. */
    suspend fun pushPending(): Result<Unit>
}
```

`Result<Unit>` here is a sealed type from `:core:common` (see [error-handling.md](error-handling.md)), not `kotlin.Result`, so callers get a closed set of failure causes.

## Local source: Room

```kotlin
package com.example.app.core.database

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "todos")
data class TodoEntity(
    @PrimaryKey val id: String,
    val title: String,
    val completed: Boolean,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    /** 0 = synced, 1 = upsert pending, 2 = delete pending. */
    @ColumnInfo(name = "sync_state") val syncState: Int = SYNCED,
) {
    companion object {
        const val SYNCED = 0
        const val PENDING_UPSERT = 1
        const val PENDING_DELETE = 2
    }
}

@Dao
interface TodoDao {
    // Rows with a pending delete are hidden from the UI immediately.
    @Query("SELECT * FROM todos WHERE sync_state != 2 ORDER BY updated_at DESC")
    fun observeAll(): Flow<List<TodoEntity>>

    @Query("SELECT * FROM todos WHERE sync_state != 0")
    suspend fun pending(): List<TodoEntity>

    @Query("SELECT * FROM todos WHERE id = :id")
    suspend fun byId(id: String): TodoEntity?

    @Upsert
    suspend fun upsert(items: List<TodoEntity>)

    @Upsert
    suspend fun upsert(item: TodoEntity)

    @Query("UPDATE todos SET sync_state = 2, updated_at = :now WHERE id = :id")
    suspend fun markDeleted(id: String, now: Long)

    @Query("DELETE FROM todos WHERE id = :id")
    suspend fun hardDelete(id: String)

    @Query("DELETE FROM todos WHERE sync_state = 0 AND id NOT IN (:keep)")
    suspend fun deleteSyncedNotIn(keep: List<String>)

    /**
     * Replace synced rows with the server's list, but never overwrite a row
     * that has a pending local change; the push will reconcile it.
     */
    @Transaction
    suspend fun applyServerSnapshot(server: List<TodoEntity>) {
        val pendingIds = pending().map { it.id }.toSet()
        upsert(server.filterNot { it.id in pendingIds })
        deleteSyncedNotIn(server.map { it.id })
    }
}

@Database(entities = [TodoEntity::class], version = 1, exportSchema = true)
abstract class AppDatabase : RoomDatabase() {
    abstract fun todoDao(): TodoDao
}
```

Room's `Flow` return type re-emits whenever the `todos` table changes, which is what makes "write to Room, UI updates itself" work. `@Upsert` (Room 2.5+) replaces the old insert-with-REPLACE pattern and does not trigger foreign-key cascades on update. Set `exportSchema = true` and commit the schema JSON so migrations can be tested.

Gradle for the database module:

```kotlin
plugins {
    id("com.example.android.library")
    id("com.google.devtools.ksp")
    id("androidx.room")           // room-gradle-plugin, same version as room
}
room { schemaDirectory("$projectDir/schemas") }
dependencies {
    implementation("androidx.room:room-runtime:2.8.5")
    implementation("androidx.room:room-ktx:2.8.5")
    ksp("androidx.room:room-compiler:2.8.5")
}
```

## Remote source: Retrofit

```kotlin
package com.example.app.core.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PUT
import retrofit2.http.Path

@Serializable
data class TodoDto(
    val id: String,
    val title: String,
    @SerialName("is_done") val isDone: Boolean,
    @SerialName("updated_at") val updatedAt: Long,
)

interface TodoApi {
    @GET("todos") suspend fun list(): List<TodoDto>
    @PUT("todos/{id}") suspend fun put(@Path("id") id: String, @Body body: TodoDto): TodoDto
    @DELETE("todos/{id}") suspend fun delete(@Path("id") id: String)
}
```

Retrofit's suspend functions throw `IOException` for transport failures and `HttpException` for non-2xx responses. The repository is the boundary where those become domain failures.

## Repository implementation

```kotlin
package com.example.app.data.todo

import com.example.app.core.common.AppError
import com.example.app.core.common.Result
import com.example.app.core.common.IoDispatcher
import com.example.app.core.database.TodoDao
import com.example.app.core.database.TodoEntity
import com.example.app.core.network.TodoApi
import com.example.app.core.network.TodoDto
import com.example.app.domain.todo.TodoItem
import com.example.app.domain.todo.TodoRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import retrofit2.HttpException
import java.io.IOException
import java.time.Clock
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
internal class TodoRepositoryImpl @Inject constructor(
    private val dao: TodoDao,
    private val api: TodoApi,
    private val clock: Clock,
    private val syncScheduler: SyncScheduler,
    @IoDispatcher private val io: CoroutineDispatcher,
) : TodoRepository {

    // Room runs the query on its own executor; map runs per emission and is cheap.
    override fun observeAll(): Flow<List<TodoItem>> =
        dao.observeAll().map { rows -> rows.map(TodoEntity::toDomain) }

    override suspend fun refresh(): Result<Unit> = withContext(io) {
        try {
            val remote = api.list().map(TodoDto::toEntity)
            dao.applyServerSnapshot(remote)
            Result.Success(Unit)
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            Result.Failure(AppError.Network(e))
        } catch (e: HttpException) {
            Result.Failure(e.toAppError())
        }
    }

    override suspend fun add(title: String) = withContext(io) {
        val entity = TodoEntity(
            id = UUID.randomUUID().toString(),
            title = title,
            completed = false,
            updatedAt = clock.millis(),
            syncState = TodoEntity.PENDING_UPSERT,
        )
        dao.upsert(entity)
        syncScheduler.requestPush()
    }

    override suspend fun setCompleted(id: String, completed: Boolean) = withContext(io) {
        val current = dao.byId(id) ?: return@withContext
        dao.upsert(
            current.copy(completed = completed, updatedAt = clock.millis(), syncState = TodoEntity.PENDING_UPSERT),
        )
        syncScheduler.requestPush()
    }

    override suspend fun delete(id: String) = withContext(io) {
        dao.byId(id) ?: return@withContext
        // Always tombstone; if the row never reached the server the push gets a 404,
        // which pushPending treats as success. Simpler than tracking "exists remotely".
        dao.markDeleted(id, clock.millis())
        syncScheduler.requestPush()
    }

    override suspend fun pushPending(): Result<Unit> = withContext(io) {
        val pending = dao.pending()
        for (row in pending) {
            try {
                when (row.syncState) {
                    TodoEntity.PENDING_UPSERT -> {
                        val saved = api.put(row.id, row.toDto())
                        dao.upsert(saved.toEntity())              // server timestamp wins
                    }
                    TodoEntity.PENDING_DELETE -> {
                        api.delete(row.id)
                        dao.hardDelete(row.id)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                return@withContext Result.Failure(AppError.Network(e))   // stop; retry later
            } catch (e: HttpException) {
                if (e.code() == 404 && row.syncState == TodoEntity.PENDING_DELETE) {
                    dao.hardDelete(row.id)                              // already gone; fine
                } else if (e.code() in 400..499) {
                    dao.upsert(row.copy(syncState = TodoEntity.SYNCED))  // unrecoverable; stop retrying
                } else {
                    return@withContext Result.Failure(e.toAppError())
                }
            }
        }
        Result.Success(Unit)
    }
}

internal fun HttpException.toAppError(): AppError = when (code()) {
    401, 403 -> AppError.Unauthorized
    in 500..599 -> AppError.Server(code())
    else -> AppError.Http(code())
}
```

Key decisions:

- `observeAll()` never throws. A Room query failure is a programming error, not a runtime condition to show the user.
- `refresh()` and `pushPending()` return `Result`, mapping exceptions at this boundary. Nothing above this layer sees `HttpException`.
- Local writes set `PENDING_UPSERT` and schedule a push. The UI updates instantly from the Room flow.
- `applyServerSnapshot` skips rows with pending changes so a refresh cannot clobber an unsynced edit. Conflict resolution here is "last write wins by server timestamp" once the push happens; if your domain needs merging, do it in `pushPending` with the server's returned record.
- 4xx on push (other than 404-on-delete) marks the row synced to stop infinite retries. Log it.

## Mappers

```kotlin
package com.example.app.data.todo

import com.example.app.core.database.TodoEntity
import com.example.app.core.network.TodoDto
import com.example.app.domain.todo.TodoItem

internal fun TodoEntity.toDomain() = TodoItem(id, title, completed, updatedAt)
internal fun TodoEntity.toDto() = TodoDto(id, title, completed, updatedAt)
internal fun TodoDto.toEntity() = TodoEntity(id, title, isDone, updatedAt, TodoEntity.SYNCED)
```

## Sync with WorkManager

```kotlin
package com.example.app.data.todo

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.example.app.core.common.Result
import com.example.app.domain.todo.TodoRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import javax.inject.Inject
import javax.inject.Singleton

interface SyncScheduler { fun requestPush() }

@Singleton
internal class WorkManagerSyncScheduler @Inject constructor(
    private val workManager: WorkManager,
) : SyncScheduler {
    override fun requestPush() {
        val request = OneTimeWorkRequestBuilder<PushWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        // KEEP: if a push is already queued, do not enqueue a second one.
        workManager.enqueueUniqueWork("todo-push", ExistingWorkPolicy.KEEP, request)
    }
}

@HiltWorker
internal class PushWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val repository: TodoRepository,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = when (repository.pushPending()) {
        is com.example.app.core.common.Result.Success -> Result.success()
        is com.example.app.core.common.Result.Failure ->
            if (runAttemptCount < 5) Result.retry() else Result.failure()
    }
}
```

WorkManager 2.12.0 with `androidx.hilt:hilt-work:1.4.0` for `@HiltWorker`. The `WorkManager` instance is provided by a Hilt module with `WorkManager.getInstance(context)`; see [dependency-injection.md](dependency-injection.md). Pull-to-refresh and app start call `repository.refresh()` directly from the ViewModel; the worker only handles pushes.

## Seeding the database from bundled assets

Some apps ship a starter dataset (a plant catalog, a list of exercises, currency codes) that must exist before the first network refresh. Google's Sunflower sample does this with a `RoomDatabase.Callback` whose `onCreate` enqueues a WorkManager job that parses `assets/<file>.json` and upserts the rows. The shape has three properties worth keeping: it runs exactly once per install (the database file is created once), it survives process death mid-parse (WorkManager retries), and it never blocks the first query (the UI shows an empty state, then rows appear through the DAO `Flow`).

Two things change from the sample: kotlinx.serialization instead of Gson, and Hilt instead of a static `AppDatabase.getInstance`. The second needs care, because the worker must not construct the database that is being created; it receives the DAO from the graph, which resolves lazily after `build()` returns.

```kotlin
package com.example.app.data.seed

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.example.app.core.database.PlantDao
import com.example.app.core.database.PlantEntity
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream

/**
 * Technique from android/sunflower (Apache-2.0): enqueue the seed from onCreate so it runs once
 * per database file. KEEP makes a second enqueue (process killed between onCreate and the
 * worker start) a no-op.
 */
class SeedOnCreateCallback(private val context: Context) : RoomDatabase.Callback() {
    override fun onCreate(db: SupportSQLiteDatabase) {
        super.onCreate(db)
        val request = OneTimeWorkRequestBuilder<SeedDatabaseWorker>()
            .setInputData(workDataOf(SeedDatabaseWorker.KEY_FILENAME to "plants.json"))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("seed-database", ExistingWorkPolicy.KEEP, request)
    }
}

@HiltWorker
class SeedDatabaseWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val plantDao: PlantDao,
    private val json: Json,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val fileName = inputData.getString(KEY_FILENAME) ?: return Result.failure()
        return try {
            val rows = applicationContext.assets.open(fileName).use { stream ->
                json.decodeFromStream<List<PlantEntity>>(stream)
            }
            plantDao.upsertAll(rows)          // idempotent: a retry after a partial write is safe
            Result.success()
        } catch (e: CancellationException) {
            throw e
        } catch (e: java.io.IOException) {
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        } catch (e: kotlinx.serialization.SerializationException) {
            Result.failure()                  // a malformed bundled file is a build bug, not transient
        }
    }

    companion object { const val KEY_FILENAME = "seed_file" }
}
```

Wiring in the database module (compare the plain `provideDatabase` in [../capabilities/room-database/README.md](../capabilities/room-database/README.md)):

```kotlin
@Provides
@Singleton
fun provideDatabase(@ApplicationContext context: Context): AppDatabase =
    Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
        .addCallback(SeedOnCreateCallback(context))
        .build()
```

`WorkManager.getInstance(context)` inside the callback requires WorkManager to be initialized with the Hilt `HiltWorkerFactory` (the `Configuration.Provider` setup in [../capabilities/hilt-di/README.md](../capabilities/hilt-di/README.md)); without it the `@HiltWorker` cannot be constructed and the job fails silently in logcat.

Alternatives, and when to pick them:

- `createFromAsset("database/seed.db")` on the builder, when the dataset is large (thousands of rows) or static: a prebuilt SQLite file copied at creation, no parsing, no worker. The schema in the file must match the entities exactly and every version bump needs a new file or a migration.
- A one-time `refresh()` on first launch, when the data is already on the server and a network round trip at install time is acceptable. Offline-first apps usually want the bundled seed and the refresh.

Test the worker on the JVM with Robolectric and WorkManager's testing helpers:

```kotlin
@RunWith(RobolectricTestRunner::class)
class SeedDatabaseWorkerTest {
    @Test fun seedsRowsFromAsset() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).allowMainThreadQueries().build()
        val worker = TestListenableWorkerBuilder<SeedDatabaseWorker>(
            context = context,
            inputData = workDataOf(SeedDatabaseWorker.KEY_FILENAME to "plants.json"),
        ).setWorkerFactory(object : WorkerFactory() {
            override fun createWorker(appContext: Context, workerClassName: String, params: WorkerParameters) =
                SeedDatabaseWorker(appContext, params, db.plantDao(), Json { ignoreUnknownKeys = true })
        }).build()

        assertEquals(ListenableWorker.Result.success(), worker.doWork())
        assertTrue(db.plantDao().count() > 0)
        db.close()
    }
}
```

The fixture file lives in `src/main/assets/plants.json` so the test reads the real bundled data; a schema change that breaks parsing fails this test before it ships.

## Using it from a ViewModel

```kotlin
val uiState = repository.observeAll()
    .map { if (it.isEmpty()) Content.Empty else Content.Success(it) }
    .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), Content.Loading)

fun refresh() = viewModelScope.launch {
    isRefreshing.value = true
    when (val r = repository.refresh()) {
        is Result.Success -> Unit
        is Result.Failure -> showMessage(r.error.userMessage())
    }
    isRefreshing.value = false
}
```

Note that the list keeps showing cached data while refresh fails; the error is a banner, not a replacement for content. That is the whole point of offline-first.

## Fake for tests and previews

The fake implements the same interface in memory (the version in [mvvm.md](mvvm.md) is sufficient). Do not mock the DAO and the API separately when testing a ViewModel; test the ViewModel against the fake repository, and test the real repository against an in-memory Room database and a fake `TodoApi`:

```kotlin
@RunWith(RobolectricTestRunner::class)
class TodoRepositoryImplTest {
    private lateinit var db: AppDatabase
    private val api = FakeTodoApi()

    @Before fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }
    @After fun tearDown() = db.close()

    @Test fun `add writes pending row and schedules push`() = runTest {
        val scheduler = RecordingSyncScheduler()
        val repo = TodoRepositoryImpl(db.todoDao(), api, Clock.fixed(Instant.EPOCH, ZoneOffset.UTC), scheduler, UnconfinedTestDispatcher())
        repo.add("Milk")
        assertEquals(1, db.todoDao().pending().size)
        assertEquals(1, scheduler.requests)
    }

    @Test fun `refresh does not overwrite pending local edit`() = runTest {
        val repo = TodoRepositoryImpl(db.todoDao(), api, Clock.systemUTC(), RecordingSyncScheduler(), UnconfinedTestDispatcher())
        repo.add("Local")
        val localId = db.todoDao().pending().single().id
        api.items = listOf(TodoDto(localId, "Server", true, 0))
        repo.refresh()
        assertEquals("Local", db.todoDao().byId(localId)!!.title)
    }
}
```

See [testing/unit-testing.md](testing/unit-testing.md) for the Robolectric setup.

## Avoid

```kotlin
// Anti-pattern: network-first read. The screen is blank offline and flickers online.
override fun observeAll(): Flow<List<TodoItem>> = flow { emit(api.list().map { it.toDomain() }) }

// Anti-pattern: returning the DTO or entity to the ViewModel.
fun observeAll(): Flow<List<TodoEntity>>

// Anti-pattern: catching Exception (swallows CancellationException) and returning an empty list.
catch (e: Exception) { emptyList() }

// Anti-pattern: a MutableStateFlow cache in the repository alongside Room. Two sources of truth.
private val cache = MutableStateFlow<List<TodoItem>>(emptyList())

// Anti-pattern: Dispatchers.IO hardcoded; untestable.
withContext(Dispatchers.IO) { ... }
```

## Verify

```sh
./gradlew :data:todo:testDebugUnitTest      # Robolectric + in-memory Room
./gradlew :app:assembleDebug
# Offline behaviour on a device:
adb shell svc wifi disable && adb shell svc data disable
# add an item in the app, confirm it appears; then
adb shell svc wifi enable
adb shell dumpsys jobscheduler | grep -A3 "todo-push"   # WorkManager job queued/run
```

## Sources

- https://developer.android.com/topic/architecture/data-layer
- https://developer.android.com/topic/architecture/data-layer/offline-first
- https://developer.android.com/training/data-storage/room
- https://developer.android.com/training/data-storage/room/async-queries
- https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started
- https://developer.android.com/jetpack/androidx/releases/room
- https://developer.android.com/jetpack/androidx/releases/work
- https://developer.android.com/training/data-storage/room/prepopulate
- https://developer.android.com/develop/background-work/background-tasks/testing/persistent
- https://github.com/android/sunflower (see [../references/sunflower.md](../references/sunflower.md))
