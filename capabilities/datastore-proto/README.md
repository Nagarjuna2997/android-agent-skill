# Proto DataStore

Typed, schema-versioned user preferences with Proto DataStore 1.2.1: a `.proto` schema compiled by the protobuf Gradle plugin into lite Kotlin classes in a JVM-only module, a `Serializer`, `DataMigration`s guarded by flags in the schema, a repository exposing `Flow<UserPreferences>` of domain types, a Hilt module, a migration path from Preferences DataStore, and a JVM test.

## When to use

- Settings with more than a handful of fields, nested structure, enums, or collections (followed ids, dismissed tips, per-account flags). Preferences DataStore ([datastore-preferences](../datastore-preferences/README.md)) is untyped key-value storage and gets error-prone past ten keys.
- When the schema will evolve. Protobuf field numbers give forward and backward compatibility for free; a Preferences key rename needs hand-written migration code.
- When a sync layer needs small bits of state next to the preferences (last-synced versions per table, see [offline-first-sync](../offline-first-sync/README.md)).
- Not for relational or large data (Room), not for secrets (Keystore-wrapped storage; see [biometric-unlock](../biometric-unlock/README.md)), and not when the team will not accept a code-generation step in the build. The alternative with no `.proto` file is `DataStore<T>` with a `kotlinx.serialization` `Serializer`; it is simpler but has no field numbers, so removing or renaming a field breaks reads of old files unless every field has a default.

The module split taught here follows Now in Android (see [../../references/nowinandroid.md](../../references/nowinandroid.md)): the generated classes live in a JVM module (`:core:datastore-proto`), the Android `DataStore` wrapper in another (`:core:datastore`). In a single-module app both halves go in `app` and the protobuf plugin is applied there.

## Dependencies

`gradle/libs.versions.toml`:

```toml
[versions]
datastore = "1.2.1"
protobuf = "<version>"            # https://github.com/protocolbuffers/protobuf/releases (protobuf-kotlin-lite and protoc share it)
protobufPlugin = "<version>"      # https://github.com/google/protobuf-gradle-plugin/releases

[libraries]
androidx-datastore = { group = "androidx.datastore", name = "datastore", version.ref = "datastore" }
androidx-datastore-core = { group = "androidx.datastore", name = "datastore-core", version.ref = "datastore" }
protobuf-kotlin-lite = { group = "com.google.protobuf", name = "protobuf-kotlin-lite", version.ref = "protobuf" }
protobuf-protoc = { group = "com.google.protobuf", name = "protoc", version.ref = "protobuf" }

[plugins]
protobuf = { id = "com.google.protobuf", version.ref = "protobufPlugin" }
```

`core/datastore-proto/build.gradle.kts` (JVM only, no Android plugin):

```kotlin
plugins {
    id("com.example.jvm.library")          // or org.jetbrains.kotlin.jvm directly
    alias(libs.plugins.protobuf)
}

protobuf {
    protoc { artifact = libs.protobuf.protoc.get().toString() }
    generateProtoTasks {
        all().configureEach {
            builtins {
                named("java") { option("lite") }      // lite runtime: no reflection, small APK
                register("kotlin") { option("lite") } // Kotlin DSL builders: userPreferences { ... }, copy { ... }
            }
        }
    }
}

dependencies {
    api(libs.protobuf.kotlin.lite)                  // generated classes extend GeneratedMessageLite; consumers need it
}
```

`core/datastore/build.gradle.kts` (Android, Hilt):

```kotlin
plugins {
    id("com.example.android.library")
    id("com.example.android.library.hilt")
}
android { namespace = "com.example.app.core.datastore" }
dependencies {
    api(libs.androidx.datastore)
    api(project(":core:datastore-proto"))
    implementation(project(":core:model"))
    implementation(project(":core:common"))
    testImplementation(libs.kotlinx.coroutines.test)
}
```

`androidx.datastore:datastore` (not `-preferences`) is the artifact for typed DataStore. Its `DataStoreFactory` lives in `datastore-core` and works on the JVM, which is what makes the test below possible without Robolectric.

## Manifest and permissions

None. The file is `filesDir/datastore/user_preferences.pb`. Add `consumer-proguard-rules.pro` in `:core:datastore` with the protobuf-lite keep rules if R8 strips generated fields (`-keep class * extends com.google.protobuf.GeneratedMessageLite { *; }`), and check `app/build/outputs/mapping/release/` after the first release build.

## Implementation

### Schema

```proto
// core/datastore-proto/src/main/proto/com/example/app/data/user_preferences.proto
syntax = "proto3";

option java_package = "com.example.app.core.datastore";
option java_multiple_files = true;

enum ThemeModeProto {
  THEME_MODE_UNSPECIFIED = 0;   // proto3 default; map it to the app default, never to an error
  THEME_MODE_SYSTEM = 1;
  THEME_MODE_LIGHT = 2;
  THEME_MODE_DARK = 3;
}

message UserPreferences {
  reserved 2;                              // removed field; never reuse the number
  ThemeModeProto theme_mode = 1;
  bool use_dynamic_color = 3;
  bool onboarding_complete = 4;

  // proto3 has no set type; a map with a meaningless bool value is the idiom.
  map<string, bool> followed_tag_ids = 5;

  // Versions of remote change lists already applied locally (see offline-first-sync).
  int32 notes_change_list_version = 6;

  // Migration flags: each one-time data fix records that it ran.
  bool has_done_list_to_map_migration = 7;
  repeated string deprecated_followed_tag_ids = 8;   // kept so the migration can read old data; cleared by it

  // NEXT AVAILABLE ID: 9
}
```

Rules that keep old files readable: never change a field's number or type, mark removed numbers `reserved`, give every enum a zero `UNSPECIFIED` value, and keep a `NEXT AVAILABLE ID` comment so two branches do not pick the same number.

### Serializer

```kotlin
package com.example.app.core.datastore

import androidx.datastore.core.CorruptionException
import androidx.datastore.core.Serializer
import com.google.protobuf.InvalidProtocolBufferException
import java.io.InputStream
import java.io.OutputStream
import javax.inject.Inject

class UserPreferencesSerializer @Inject constructor() : Serializer<UserPreferences> {
    override val defaultValue: UserPreferences = UserPreferences.getDefaultInstance()

    // Both methods are called on DataStore's own background dispatcher; no withContext needed.
    override suspend fun readFrom(input: InputStream): UserPreferences = try {
        UserPreferences.parseFrom(input)
    } catch (e: InvalidProtocolBufferException) {
        throw CorruptionException("Cannot read user_preferences.pb", e)
    }

    override suspend fun writeTo(t: UserPreferences, output: OutputStream) = t.writeTo(output)
}
```

`CorruptionException` is the hook for `ReplaceFileCorruptionHandler` in the factory below; without a handler a corrupt file makes every read fail.

### Migrations

A `DataMigration<T>` runs before the first read. Guard each with a flag stored in the proto so it runs once per install, and leave the deprecated field in the schema until a release after every user has migrated.

```kotlin
package com.example.app.core.datastore

import androidx.datastore.core.DataMigration

/** Moves followed ids from the repeated field (v1 schema) into the map (v2 schema). */
internal object ListToMapMigration : DataMigration<UserPreferences> {
    override suspend fun shouldMigrate(currentData: UserPreferences): Boolean =
        !currentData.hasDoneListToMapMigration

    override suspend fun migrate(currentData: UserPreferences): UserPreferences = currentData.copy {
        followedTagIds.clear()
        followedTagIds.putAll(currentData.deprecatedFollowedTagIdsList.associateWith { true })
        deprecatedFollowedTagIds.clear()
        hasDoneListToMapMigration = true
    }

    override suspend fun cleanUp() = Unit
}
```

`copy { }` and the `followedTagIds` map DSL come from the `kotlin` protoc builtin; without it you would write `currentData.toBuilder().putAllFollowedTagIds(...).build()`.

### Preferences data source

Maps proto types to domain types in one place. Nothing outside `:core:datastore` sees a generated class.

```kotlin
package com.example.app.core.datastore

import androidx.datastore.core.DataStore
import com.example.app.core.model.ThemeMode
import com.example.app.core.model.UserData
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import javax.inject.Inject

class UserPreferencesDataSource @Inject constructor(
    private val store: DataStore<UserPreferences>,
) {
    val userData: Flow<UserData> = store.data.map { prefs ->
        UserData(
            themeMode = when (prefs.themeMode) {
                ThemeModeProto.THEME_MODE_LIGHT -> ThemeMode.LIGHT
                ThemeModeProto.THEME_MODE_DARK -> ThemeMode.DARK
                // UNSPECIFIED, SYSTEM, UNRECOGNIZED (a value written by a newer build) all mean "system"
                else -> ThemeMode.SYSTEM
            },
            useDynamicColor = prefs.useDynamicColor,
            onboardingComplete = prefs.onboardingComplete,
            followedTagIds = prefs.followedTagIdsMap.keys,
        )
    }

    suspend fun setThemeMode(mode: ThemeMode) = store.updateData {
        it.copy {
            themeMode = when (mode) {
                ThemeMode.SYSTEM -> ThemeModeProto.THEME_MODE_SYSTEM
                ThemeMode.LIGHT -> ThemeModeProto.THEME_MODE_LIGHT
                ThemeMode.DARK -> ThemeModeProto.THEME_MODE_DARK
            }
        }
    }

    suspend fun setDynamicColor(enabled: Boolean) = store.updateData { it.copy { useDynamicColor = enabled } }

    suspend fun setOnboardingComplete() = store.updateData { it.copy { onboardingComplete = true } }

    suspend fun setTagFollowed(tagId: String, followed: Boolean) = store.updateData {
        it.copy { if (followed) followedTagIds.put(tagId, true) else followedTagIds.remove(tagId) }
    }

    /** Used by the sync layer; read once, not observed. */
    suspend fun getNotesChangeListVersion(): Int = store.data.map { it.notesChangeListVersion }.first()

    suspend fun setNotesChangeListVersion(version: Int) = store.updateData { it.copy { notesChangeListVersion = version } }
}
```

`updateData` is a read-modify-write transaction serialized by DataStore, so two concurrent `setTagFollowed` calls cannot lose an update. It throws `IOException` if the write fails; let it propagate to the repository, which maps it to the app's error type (see [../../patterns/error-handling.md](../../patterns/error-handling.md)). Do not catch and log inside the data source; a full disk must reach the user.

The functions return `UserPreferences` (what `updateData` returns); callers ignore it. Declare them `suspend fun ...: Unit` with `{ store.updateData { } }` bodies if the leaked type bothers the API surface check.

### Repository

```kotlin
package com.example.app.core.data

import com.example.app.core.datastore.UserPreferencesDataSource
import com.example.app.core.model.ThemeMode
import com.example.app.core.model.UserData
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject

interface UserDataRepository {
    val userData: Flow<UserData>
    suspend fun setThemeMode(mode: ThemeMode)
    suspend fun setDynamicColor(enabled: Boolean)
    suspend fun setTagFollowed(tagId: String, followed: Boolean)
    suspend fun completeOnboarding()
}

internal class OfflineFirstUserDataRepository @Inject constructor(
    private val preferences: UserPreferencesDataSource,
) : UserDataRepository {
    override val userData: Flow<UserData> = preferences.userData
    override suspend fun setThemeMode(mode: ThemeMode) { preferences.setThemeMode(mode) }
    override suspend fun setDynamicColor(enabled: Boolean) { preferences.setDynamicColor(enabled) }
    override suspend fun setTagFollowed(tagId: String, followed: Boolean) { preferences.setTagFollowed(tagId, followed) }
    override suspend fun completeOnboarding() { preferences.setOnboardingComplete() }
}
```

A ViewModel collects `userData` with `stateIn(viewModelScope, WhileSubscribed(5_000), initial)` exactly as in [datastore-preferences](../datastore-preferences/README.md); the theme is read once at the app root and passed into `MaterialTheme`.

### Hilt module

```kotlin
package com.example.app.core.datastore.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.core.DataStoreFactory
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.dataStoreFile
import com.example.app.core.common.ApplicationScope
import com.example.app.core.common.IoDispatcher
import com.example.app.core.datastore.ListToMapMigration
import com.example.app.core.datastore.UserPreferences
import com.example.app.core.datastore.UserPreferencesSerializer
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DataStoreModule {
    @Provides
    @Singleton
    fun provideUserPreferencesDataStore(
        @ApplicationContext context: Context,
        @IoDispatcher io: CoroutineDispatcher,
        @ApplicationScope appScope: CoroutineScope,
        serializer: UserPreferencesSerializer,
    ): DataStore<UserPreferences> = DataStoreFactory.create(
        serializer = serializer,
        scope = CoroutineScope(appScope.coroutineContext + io),
        corruptionHandler = ReplaceFileCorruptionHandler { UserPreferences.getDefaultInstance() },
        migrations = listOf(ListToMapMigration),
    ) { context.dataStoreFile("user_preferences.pb") }
}
```

Exactly one `DataStore` per file; `@Singleton` guarantees it. The `ReplaceFileCorruptionHandler` resets to defaults instead of failing forever on a truncated file; log the event through the analytics interface in the repository if you want to know how often it happens.

### Migrating from Preferences DataStore

If the app already ships Preferences DataStore (or `SharedPreferences`), move the data once with a `DataMigration` that reads the old store and clears it. Install it in the proto store's `migrations` list before the schema migrations.

```kotlin
package com.example.app.core.datastore

import androidx.datastore.core.DataMigration
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.first

/** One-shot move from the Preferences DataStore file "user_settings" into the proto store. */
internal class PreferencesToProtoMigration(
    private val legacy: DataStore<Preferences>,
) : DataMigration<UserPreferences> {
    private val legacyTheme = stringPreferencesKey("theme_mode")
    private val legacyOnboarding = booleanPreferencesKey("onboarding_complete")

    override suspend fun shouldMigrate(currentData: UserPreferences): Boolean =
        legacy.data.first().asMap().isNotEmpty()

    override suspend fun migrate(currentData: UserPreferences): UserPreferences {
        val old = legacy.data.first()
        return currentData.copy {
            themeMode = when (old[legacyTheme]) {
                "LIGHT" -> ThemeModeProto.THEME_MODE_LIGHT
                "DARK" -> ThemeModeProto.THEME_MODE_DARK
                else -> ThemeModeProto.THEME_MODE_SYSTEM
            }
            onboardingComplete = old[legacyOnboarding] ?: false
        }
    }

    override suspend fun cleanUp() {
        legacy.edit { it.clear() }    // leaves an empty file; delete the file in a later release
    }
}
```

For `SharedPreferences` the library ships `SharedPreferencesMigration(context, "old_prefs") { prefs, current -> ... }` with the same shape. Keep the migration for two or three releases, then remove it together with the legacy keys.

## Verify

```sh
./gradlew :core:datastore-proto:build                     # protoc ran; generated sources in build/generated/source/proto
./gradlew :core:datastore:testDebugUnitTest --tests "*UserPreferencesDataSourceTest*"
./gradlew :app:assembleDebug
adb shell run-as com.example.app ls files/datastore/      # user_preferences.pb after the first write
```

JVM test with a temporary file; `DataStoreFactory` does not need Android:

```kotlin
package com.example.app.core.datastore

import androidx.datastore.core.DataStoreFactory
import app.cash.turbine.test
import com.example.app.core.model.ThemeMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class UserPreferencesDataSourceTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun themeRoundTripsAndListMigrationRuns() = runTest {
        val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
        val store = DataStoreFactory.create(
            serializer = UserPreferencesSerializer(),
            scope = scope,
            migrations = listOf(ListToMapMigration),
        ) { File(tmp.root, "test.pb") }
        val source = UserPreferencesDataSource(store)

        source.setThemeMode(ThemeMode.DARK)
        source.setTagFollowed("kotlin", true)

        source.userData.test {
            val data = awaitItem()
            assertEquals(ThemeMode.DARK, data.themeMode)
            assertEquals(setOf("kotlin"), data.followedTagIds)
            cancelAndIgnoreRemainingEvents()
        }
        assertTrue(store.data.first().hasDoneListToMapMigration)
        scope.cancel()
    }
}
```

A second test should write a `UserPreferences` with `deprecatedFollowedTagIds` through the raw `store.updateData`, create a new store on the same file with the migration, and assert the ids appear in `followedTagIdsMap`.

## Pitfalls

- Two `DataStore` instances for one file throw `IllegalStateException` at runtime. One `@Singleton` provider per file, and tests must `scope.cancel()` before the next test opens the same path.
- `UNRECOGNIZED` enum values arrive when a newer build wrote a value the current build does not know (downgrade, or a staged rollout). Always have an `else` branch mapping to the default.
- Reusing a field number after deleting a field silently reinterprets old bytes. `reserved` it.
- Do not put the protobuf plugin on an Android module that has `isolated-projects` on unless the plugin version supports it; the JVM-only `:core:datastore-proto` sidesteps this.
- `protobuf-java` (full runtime) instead of `-lite` adds megabytes and uses reflection that R8 strips. Lite everywhere on Android.
- `store.data.first()` on the main thread with `runBlocking` blocks the UI during the first disk read. Observe the flow; model a loading state.
- A `DataMigration` that throws aborts every read until fixed. Keep migrations total: handle missing or malformed legacy values with defaults.
- Generated Kotlin DSL names: a proto field `followed_tag_ids` becomes `followedTagIds` in `copy { }`, `followedTagIdsMap` on the message and `followedTagIdsList` for a repeated field. Mixing them up fails at compile time, which is the point of the proto approach.

## Sources

- https://developer.android.com/topic/libraries/architecture/datastore
- https://developer.android.com/jetpack/androidx/releases/datastore
- https://developer.android.com/codelabs/android-proto-datastore
- https://protobuf.dev/programming-guides/proto3/
- https://protobuf.dev/reference/kotlin/kotlin-generated/
- https://github.com/google/protobuf-gradle-plugin
