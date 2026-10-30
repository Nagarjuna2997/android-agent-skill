# Reference study: android/sunflower

Sunflower is Google's gardening app sample: a plant catalog seeded from a bundled JSON file, a "my garden" list built from a Room relation, a plant detail screen, and an Unsplash photo gallery through Retrofit and Paging. It was the canonical Architecture Components sample before Now in Android and is now in maintenance; its data layer is still the clearest small example of Room + WorkManager seeding and `@Relation` queries.

## Toolchain snapshot

Read from `gradle/libs.versions.toml` and `gradle/wrapper/gradle-wrapper.properties`, checkout dated 2024-08-02.

| Item | Sunflower | This repo (`data/versions.json`) | Verdict |
|---|---|---|---|
| AGP | 8.4.0 | 9.4.0 | lags a major version |
| Gradle wrapper | 8.6 | 9.6.0 (AGP-documented) | lags |
| Kotlin | 2.0.0 | 2.4.20 | lags |
| KSP | 2.0.0-1.0.21 | resolve from release page | n/a |
| Compose BOM | 2024.05.00 | 2026.09.00 | lags two years |
| Material 3 | 1.2.1 (pinned) | 1.4.0 | lags |
| compileSdk / minSdk / targetSdk | 34 / 24 / 34 | 37 / 24 / 36 | lags; Play requires 36 |
| Room | 2.6.1 | 2.8.5 | lags; `@Upsert` already available |
| WorkManager | 2.9.0 | 2.12.0 | lags |
| Lifecycle | 2.7.0 | 2.11.0 | lags; uses `LiveData` |
| Navigation | 2.7.7 | 2.10.2 | lags; string routes |
| Hilt | 2.51.1 | resolve from release page | n/a |
| Paging Compose | 3.3.0-rc01 | 3.5.1 | lags |
| Image loading | Glide Compose 1.0.0-beta01 | Coil 3 | different library |
| Retrofit | 2.11.0 with Gson converter | Retrofit with kotlinx.serialization | different converter |
| Accompanist systemuicontroller | 0.34.0 | not used | deprecated; `enableEdgeToEdge()` replaces it |

Everything in Sunflower lags this repository's baseline. Adopt the data-layer ideas, not the versions or the UI-layer plumbing.

## Techniques worth adopting

### Seeding Room from a bundled JSON asset on first run

Sunflower registers a `RoomDatabase.Callback` whose `onCreate` enqueues a `OneTimeWorkRequest` for `SeedDatabaseWorker`. The worker opens `assets/plants.json`, parses a `List<Plant>` with a streaming JSON reader, and calls `plantDao().upsertAll(...)`. Because `onCreate` only fires when the database file is created, the seed runs exactly once per install; because it runs in WorkManager, it survives the process being killed before parsing finishes and does not block the first query.

Original re-implementation (kotlinx.serialization instead of Gson, Hilt-injected DAO instead of a static singleton):

```kotlin
// Technique from android/sunflower (Apache-2.0): seed on RoomDatabase.Callback.onCreate via WorkManager.
@HiltWorker
class SeedDatabaseWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val plantDao: PlantDao,
    private val json: Json,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val fileName = inputData.getString(KEY_FILENAME) ?: return Result.failure()
        val plants = applicationContext.assets.open(fileName).use { stream ->
            json.decodeFromStream<List<PlantEntity>>(stream)
        }
        plantDao.upsertAll(plants)
        return Result.success()
    }
    companion object { const val KEY_FILENAME = "seed_file" }
}
```

The complete version, including the `Callback`, the Hilt wiring that avoids the database-inside-the-worker cycle, and the test, is in [../patterns/repository.md](../patterns/repository.md) ("Seeding the database from bundled assets").

### `@Transaction` + `@Relation` for one-to-many reads as `Flow`

`PlantAndGardenPlantings` embeds a `Plant` and declares `@Relation(parentColumn = "id", entityColumn = "plant_id") val gardenPlantings: List<GardenPlanting>`. The DAO query selects plants whose id appears in `garden_plantings` and is annotated `@Transaction` so Room runs the parent query and the per-parent child queries atomically. The return type `Flow<List<PlantAndGardenPlantings>>` re-emits when either table changes.

```kotlin
// Technique from android/sunflower (Apache-2.0): parent entity + @Relation children, read in one transaction.
data class PlantWithPlantings(
    @Embedded val plant: PlantEntity,
    @Relation(parentColumn = "id", entityColumn = "plant_id") val plantings: List<PlantingEntity>,
)

@Transaction
@Query("SELECT * FROM plants WHERE id IN (SELECT DISTINCT plant_id FROM plantings)")
fun observeGarden(): Flow<List<PlantWithPlantings>>
```

Also worth keeping: `@Query("SELECT EXISTS(SELECT 1 FROM garden_plantings WHERE plant_id = :plantId LIMIT 1)") fun isPlanted(plantId: String): Flow<Boolean>` as the cheap way to drive a toggle button from the database; a `ForeignKey` with an `Index` on the child column; `@ColumnInfo(name = ...)` so a Kotlin rename never forces a migration.

### Image loading in a list with a placeholder

`ImageListItem` gives the image a fixed height from a dimension resource and `ContentScale.Crop`, so the card does not change size when the bitmap arrives. The detail header keeps a colored placeholder `Box` under the image until a request listener reports success or failure. The idea (fixed size, visible placeholder, decorative `contentDescription = null` when the title carries the meaning) is library-independent and is already how `capabilities/image-loading` uses Coil 3.

### Instrumented worker and DAO tests

`SeedDatabaseWorkerTest` initializes WorkManager with `WorkManagerTestInitHelper` and a `SynchronousExecutor`, builds the worker with `TestListenableWorkerBuilder` and the real input data, and asserts `Result.success()`. `PlantDaoTest` uses `Room.inMemoryDatabaseBuilder` and inserts rows out of order to prove the `ORDER BY name` clause. Both shapes are reproduced in this repository.

## Techniques not to copy

- `LiveData` and `asLiveData()` in ViewModels, `observeAsState()` in Compose. This repository's rule is `StateFlow` + `collectAsStateWithLifecycle()`; Sunflower's `GardenPlantingListViewModel` already does this with `stateIn`, the other ViewModels do not.
- `AppDatabase.getInstance(context)` double-checked-locking singleton, and the repository `getInstance` companions. Let Hilt own the singleton; the worker must receive the DAO through injection rather than calling a static accessor.
- `exportSchema = false`. Export schemas and commit them so migrations can be tested.
- `Calendar` columns through a `TypeConverter`. Use `Instant`/epoch millis.
- `catch (ex: Exception)` in the worker that swallows `CancellationException` and returns `Result.failure()`. Rethrow cancellation; let other failures return `Result.retry()` for transient cases.
- Gson and `TypeToken`; use kotlinx.serialization.
- Glide Compose `1.0.0-beta01` with a `RequestListener` to track loading; Coil 3's `AsyncImage` has `placeholder`, `error` and `onState` built in.
- Accompanist `systemuicontroller`; call `enableEdgeToEdge()`.
- String-based Navigation routes and `NavType` arguments.
- Hardcoded `withContext(Dispatchers.IO)` in the worker; `CoroutineWorker.doWork` already runs off the main thread and Room's suspend DAOs are main-safe.

## Map to this repository

| Technique | File |
|---|---|
| Room + Retrofit + WorkManager seeding from assets on first run | [../patterns/repository.md](../patterns/repository.md) ("Seeding the database from bundled assets") |
| `@Transaction` relations, `Flow` joins, `EXISTS` flags, prepopulating | [../capabilities/room-database/README.md](../capabilities/room-database/README.md) ("Relations, joins and prepopulated data") |
| Placeholders in image lists; Glide note | [../capabilities/image-loading/README.md](../capabilities/image-loading/README.md) |
| WorkManager testing helpers | [../capabilities/work-manager/README.md](../capabilities/work-manager/README.md) (existing) |
| Paging from a network source | [../capabilities/paging/README.md](../capabilities/paging/README.md) (existing; Sunflower's `PagingSource` without Room is the simpler variant) |

## Verify

```sh
git clone --depth 1 https://github.com/android/sunflower /tmp/samples/sunflower
grep -E '^(androidGradlePlugin|kotlin|composeBom|room|work|targetSdk|compileSdk|glide|lifecycle)' /tmp/samples/sunflower/gradle/libs.versions.toml
grep distributionUrl /tmp/samples/sunflower/gradle/wrapper/gradle-wrapper.properties
```

The sample itself was inspected, not built. The re-implementations in the files above carry their own `## Verify` commands (in-memory Room DAO test, `TestListenableWorkerBuilder` worker test).

## Attribution

Studied: `android/sunflower`, https://github.com/android/sunflower, licensed under the Apache License, Version 2.0 (plant data and images under the sample's separate assets license, not reused). The Kotlin and Gradle code in this repository is an original re-implementation of the techniques in the `com.example.app` placeholder package; short excerpts are marked inline with a `Technique from android/sunflower` comment.

## Sources

- https://github.com/android/sunflower
- https://developer.android.com/training/data-storage/room/relationships
- https://developer.android.com/training/data-storage/room/prepopulate
- https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started
- https://developer.android.com/develop/background-work/background-tasks/testing/persistent
- https://developer.android.com/training/data-storage/room/testing-db
