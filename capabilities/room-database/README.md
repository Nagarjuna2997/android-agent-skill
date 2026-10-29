# Room database

Local relational storage with Room 2.8.5: entities, DAOs exposing `Flow`, a `RoomDatabase` singleton provided through Hilt, migrations and an in-memory test.

## When to use

- The app needs structured local data that survives process death: lists, caches of remote data, offline edits, anything you would query or join.
- You want the single source of truth for a screen to be a database `Flow` so remote refreshes and local writes reach the UI through one path.
- Do not use Room for a handful of flags or user preferences; use [datastore-preferences](../datastore-preferences/README.md). Do not use it for files or blobs; store those on disk and keep paths in Room.

Room 3 (`androidx.room3`, 3.0.3 in `data/versions.json`) is the Kotlin Multiplatform rewrite. Pick it only when the project is already KMP or the user asks for it; this recipe targets Room 2.8.5, which is what most existing Android projects use.

## Dependencies

`gradle/libs.versions.toml`:

```toml
[versions]
room = "2.8.5"
ksp = "<version>"   # https://github.com/google/ksp/releases ; must match Kotlin 2.4.20

[libraries]
room-runtime = { group = "androidx.room", name = "room-runtime", version.ref = "room" }
room-ktx = { group = "androidx.room", name = "room-ktx", version.ref = "room" }
room-compiler = { group = "androidx.room", name = "room-compiler", version.ref = "room" }
room-testing = { group = "androidx.room", name = "room-testing", version.ref = "room" }

[plugins]
ksp = { id = "com.google.devtools.ksp", version.ref = "ksp" }
room = { id = "androidx.room", version.ref = "room" }
```

`app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.ksp)
    alias(libs.plugins.room)
}

room {
    schemaDirectory("$projectDir/schemas")   // exported schemas, commit them for migration tests
}

dependencies {
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    androidTestImplementation(libs.room.testing)
}
```

Use KSP, not kapt. The `androidx.room` Gradle plugin replaces the old `arguments["room.schemaLocation"]` KSP argument.

## Manifest and permissions

None. The database file lives in the app's private storage (`context.getDatabasePath(name)`), which is included in Auto Backup unless excluded; see [auto-backup-and-data-extraction-rules](../auto-backup-and-data-extraction-rules/README.md) if the data is sensitive.

## Implementation

### Entity and DAO

```kotlin
package com.example.app.data.local

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "notes", indices = [Index("updated_at")])
data class NoteEntity(
    @PrimaryKey val id: String,
    val title: String,
    val body: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    @ColumnInfo(defaultValue = "0") val archived: Boolean = false,
)

@Dao
interface NoteDao {
    @Query("SELECT * FROM notes WHERE archived = 0 ORDER BY updated_at DESC")
    fun observeActive(): Flow<List<NoteEntity>>

    @Query("SELECT * FROM notes WHERE id = :id")
    fun observeById(id: String): Flow<NoteEntity?>

    @Upsert
    suspend fun upsert(note: NoteEntity)

    @Upsert
    suspend fun upsertAll(notes: List<NoteEntity>)

    @Query("UPDATE notes SET archived = 1 WHERE id = :id")
    suspend fun archive(id: String)

    @Delete
    suspend fun delete(note: NoteEntity)

    @Query("DELETE FROM notes")
    suspend fun clear()
}
```

DAO methods that return `Flow` run on Room's query executor and re-emit on every change to the tables they touch. `suspend` methods run off the main thread automatically; never call a blocking DAO method from the main thread (Room throws unless `allowMainThreadQueries()` is set, which you must not do).

### Database

```kotlin
package com.example.app.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import java.time.Instant

class Converters {
    @TypeConverter fun toInstant(epochMillis: Long?): Instant? = epochMillis?.let(Instant::ofEpochMilli)
    @TypeConverter fun fromInstant(instant: Instant?): Long? = instant?.toEpochMilli()
}

@Database(
    entities = [NoteEntity::class],
    version = 2,
    exportSchema = true,
    autoMigrations = [
        AutoMigration(from = 1, to = 2),   // added the `archived` column with a default
    ],
)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase() {
    abstract fun noteDao(): NoteDao
}
```

Auto migrations work for added columns and tables when the exported schema for the previous version is in `schemas/`. For renames or data moves write a `Migration` object and pass it to `addMigrations(...)`.

### Hilt module

```kotlin
package com.example.app.di

import android.content.Context
import androidx.room.Room
import com.example.app.data.local.AppDatabase
import com.example.app.data.local.NoteDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {
    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, "app.db")
            // .addMigrations(MIGRATION_2_3)  for manual migrations
            .build()

    @Provides
    fun provideNoteDao(db: AppDatabase): NoteDao = db.noteDao()
}
```

Do not add `fallbackToDestructiveMigration()` in production code; it silently deletes user data when a migration is missing.

### Repository

```kotlin
package com.example.app.data

import com.example.app.data.local.NoteDao
import com.example.app.data.local.NoteEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject

data class Note(val id: String, val title: String, val body: String, val updatedAt: Long)

interface NoteRepository {
    fun observeNotes(): Flow<List<Note>>
    suspend fun save(note: Note)
    suspend fun archive(id: String)
}

class RoomNoteRepository @Inject constructor(private val dao: NoteDao) : NoteRepository {
    override fun observeNotes(): Flow<List<Note>> =
        dao.observeActive().map { rows -> rows.map { it.toDomain() } }

    override suspend fun save(note: Note) = dao.upsert(note.toEntity())
    override suspend fun archive(id: String) = dao.archive(id)
}

private fun NoteEntity.toDomain() = Note(id, title, body, updatedAt)
private fun Note.toEntity() = NoteEntity(id, title, body, updatedAt)
```

Bind the interface in an abstract module (`@Binds abstract fun bind(impl: RoomNoteRepository): NoteRepository`), and keep a `FakeNoteRepository` backed by `MutableStateFlow` for previews and ViewModel tests.

### ViewModel

```kotlin
package com.example.app.ui.notes

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.app.data.Note
import com.example.app.data.NoteRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

sealed interface NotesUiState {
    data object Loading : NotesUiState
    data object Empty : NotesUiState
    data class Content(val notes: List<Note>) : NotesUiState
}

@HiltViewModel
class NotesViewModel @Inject constructor(private val repository: NoteRepository) : ViewModel() {
    val uiState: StateFlow<NotesUiState> = repository.observeNotes()
        .map { if (it.isEmpty()) NotesUiState.Empty else NotesUiState.Content(it) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), NotesUiState.Loading)

    fun archive(id: String) {
        viewModelScope.launch { repository.archive(id) }
    }
}
```

Collect in Compose with `viewModel.uiState.collectAsStateWithLifecycle()` from `androidx.lifecycle.compose`.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
./gradlew :app:connectedDebugAndroidTest     # runs the DAO test below on a device or emulator
ls app/schemas/com.example.app.data.local.AppDatabase/   # 1.json, 2.json must exist after a build
```

Instrumented DAO test (`app/src/androidTest/.../NoteDaoTest.kt`):

```kotlin
@RunWith(AndroidJUnit4::class)
class NoteDaoTest {
    private lateinit var db: AppDatabase
    private lateinit var dao: NoteDao

    @Before fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        dao = db.noteDao()
    }

    @After fun tearDown() = db.close()

    @Test fun archivedNotesAreHiddenFromActiveList() = runTest {
        dao.upsert(NoteEntity("a", "A", "", 1))
        dao.upsert(NoteEntity("b", "B", "", 2))
        dao.archive("a")
        dao.observeActive().test {
            assertEquals(listOf("b"), awaitItem().map { it.id })
            cancelAndIgnoreRemainingEvents()
        }
    }
}
```

Migration test with `MigrationTestHelper` from `room-testing` is required whenever `version` is bumped; it reads the JSON schemas, so keep `schemas/` committed. The same DAO test runs on the JVM with Robolectric if the project prefers that.

## Pitfalls

- Bumping `version` without a migration crashes the app at open time with `IllegalStateException: A migration from X to Y was required`. Export schemas and test every bump.
- A DAO `Flow` emits for any write to the table, including no-op writes. Use `distinctUntilChanged()` in the repository when the mapped result is what matters.
- Returning entities straight to the UI couples screens to the schema. Map to domain models in the repository.
- `@Insert(onConflict = REPLACE)` deletes and re-inserts the row, which fires foreign-key cascades. Prefer `@Upsert`.
- Large `Flow<List<...>>` results re-serialize the entire list on every change. For long lists use [paging](../paging/README.md) with `PagingSource` from Room.
- Do not hold a `Cursor` or run queries inside `withContext(Dispatchers.Main)`; Room's suspend DAOs already pick the right thread.
- Room 2.8 defaults to the bundled SQLite driver only when `setDriver` is used; the default Android framework SQLite varies by OS version. If you rely on SQL features newer than the device's SQLite (for example `RETURNING`), add `androidx.sqlite:sqlite-bundled` and `setDriver(BundledSQLiteDriver())`.

## Sources

- https://developer.android.com/training/data-storage/room
- https://developer.android.com/training/data-storage/room/migrating-db-versions
- https://developer.android.com/training/data-storage/room/testing-db
- https://developer.android.com/jetpack/androidx/releases/room
- https://github.com/google/ksp/releases
