# DataStore preferences

Key-value settings with Preferences DataStore 1.2.1: a typed settings repository exposing a `Flow`, a Hilt-provided singleton, atomic updates and a JVM test with a temporary file.

## When to use

- Small user settings: theme, notification toggles, onboarding-complete flags, last-synced timestamp, a selected account id.
- Replacing `SharedPreferences` in new code. DataStore is transactional, asynchronous and never blocks the main thread or throws from `apply()` at process death.
- For a strongly typed schema with many fields use Proto DataStore (same artifact family, `androidx.datastore:datastore` plus protobuf-lite or kotlinx.serialization with a custom `Serializer`). For relational data use [room-database](../room-database/README.md).
- Secrets (tokens, keys) do not belong in plain DataStore. Encrypt the value with an Android Keystore key first; `EncryptedSharedPreferences` is deprecated. See [biometric-unlock](../biometric-unlock/README.md) for a Keystore key example.

## Dependencies

`gradle/libs.versions.toml`:

```toml
[versions]
datastore = "1.2.1"

[libraries]
datastore-preferences = { group = "androidx.datastore", name = "datastore-preferences", version.ref = "datastore" }
```

`app/build.gradle.kts`:

```kotlin
dependencies {
    implementation(libs.datastore.preferences)
}
```

## Manifest and permissions

None. The file lives in `filesDir/datastore/<name>.preferences_pb`.

## Implementation

### Keys and model

```kotlin
package com.example.app.data.settings

import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey

enum class ThemeMode { SYSTEM, LIGHT, DARK }

data class UserSettings(
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val notificationsEnabled: Boolean = true,
    val onboardingComplete: Boolean = false,
    val lastSyncEpochMillis: Long = 0L,
)

internal object SettingsKeys {
    val THEME = stringPreferencesKey("theme_mode")
    val NOTIFICATIONS = booleanPreferencesKey("notifications_enabled")
    val ONBOARDING_DONE = booleanPreferencesKey("onboarding_complete")
    val LAST_SYNC = longPreferencesKey("last_sync_epoch_millis")
}
```

### Repository

```kotlin
package com.example.app.data.settings

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import java.io.IOException
import javax.inject.Inject

interface SettingsRepository {
    val settings: Flow<UserSettings>
    suspend fun setThemeMode(mode: ThemeMode)
    suspend fun setNotificationsEnabled(enabled: Boolean)
    suspend fun markOnboardingComplete()
    suspend fun recordSync(epochMillis: Long)
}

class DataStoreSettingsRepository @Inject constructor(
    private val dataStore: DataStore<Preferences>,
) : SettingsRepository {

    override val settings: Flow<UserSettings> = dataStore.data
        .catch { e ->
            // A corrupt or unreadable file should not crash the app; fall back to defaults.
            if (e is IOException) emit(emptyPreferences()) else throw e
        }
        .map { prefs ->
            UserSettings(
                themeMode = prefs[SettingsKeys.THEME]?.let { runCatching { ThemeMode.valueOf(it) }.getOrNull() }
                    ?: ThemeMode.SYSTEM,
                notificationsEnabled = prefs[SettingsKeys.NOTIFICATIONS] ?: true,
                onboardingComplete = prefs[SettingsKeys.ONBOARDING_DONE] ?: false,
                lastSyncEpochMillis = prefs[SettingsKeys.LAST_SYNC] ?: 0L,
            )
        }

    override suspend fun setThemeMode(mode: ThemeMode) {
        dataStore.edit { it[SettingsKeys.THEME] = mode.name }
    }

    override suspend fun setNotificationsEnabled(enabled: Boolean) {
        dataStore.edit { it[SettingsKeys.NOTIFICATIONS] = enabled }
    }

    override suspend fun markOnboardingComplete() {
        dataStore.edit { it[SettingsKeys.ONBOARDING_DONE] = true }
    }

    override suspend fun recordSync(epochMillis: Long) {
        dataStore.edit { it[SettingsKeys.LAST_SYNC] = epochMillis }
    }
}
```

`edit` is a read-modify-write transaction; concurrent edits are serialized by DataStore. `runCatching` around `ThemeMode.valueOf` is for a value written by an older build, not for coroutine cancellation, so it does not need a `CancellationException` rethrow (`valueOf` never throws one).

### Hilt module

```kotlin
package com.example.app.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStoreFile
import com.example.app.data.settings.DataStoreSettingsRepository
import com.example.app.data.settings.SettingsRepository
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DataStoreModule {
    @Provides
    @Singleton
    fun provideSettingsDataStore(@ApplicationContext context: Context): DataStore<Preferences> =
        PreferenceDataStoreFactory.create(
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
            produceFile = { context.preferencesDataStoreFile("user_settings") },
        )
}

@Module
@InstallIn(SingletonComponent::class)
abstract class SettingsBindings {
    @Binds abstract fun bindSettings(impl: DataStoreSettingsRepository): SettingsRepository
}
```

Exactly one `DataStore` instance may exist per file; creating two for the same file throws at runtime. The `@Singleton` scope guarantees that. The `preferencesDataStore` property delegate (`val Context.dataStore by preferencesDataStore("user_settings")`) is the alternative when the project does not use DI; do not combine both for the same file.

### ViewModel and UI

```kotlin
@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val repository: SettingsRepository,
) : ViewModel() {
    val uiState: StateFlow<UserSettings> = repository.settings
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), UserSettings())

    fun onThemeSelected(mode: ThemeMode) = viewModelScope.launch { repository.setThemeMode(mode) }
    fun onNotificationsToggled(enabled: Boolean) =
        viewModelScope.launch { repository.setNotificationsEnabled(enabled) }
}
```

For the theme, collect `settings` once at the top of the app and feed `ThemeMode` into `MaterialTheme(colorScheme = ...)`; see [settings-screen](../settings-screen/README.md) for the full screen.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*SettingsRepositoryTest*"
adb shell run-as com.example.app ls files/datastore/      # user_settings.preferences_pb after first write
```

JVM unit test using a temp folder (no Android dependency needed for Preferences DataStore core):

```kotlin
class SettingsRepositoryTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun themeRoundTrips() = runTest {
        val scope = CoroutineScope(SupervisorJob() + UnconfinedTestDispatcher(testScheduler))
        val store = PreferenceDataStoreFactory.create(scope = scope) {
            File(tmp.root, "test.preferences_pb")
        }
        val repo = DataStoreSettingsRepository(store)

        repo.setThemeMode(ThemeMode.DARK)

        repo.settings.test {
            assertEquals(ThemeMode.DARK, awaitItem().themeMode)
            cancelAndIgnoreRemainingEvents()
        }
        scope.cancel()
    }
}
```

## Pitfalls

- Never block on `dataStore.data.first()` from the main thread with `runBlocking`. Read the stream in the ViewModel and model a loading state while the first value arrives.
- Two `DataStore` objects for the same file crash with `IllegalStateException: There are multiple DataStores active for the same file`. One singleton per file.
- `edit` runs on `Dispatchers.IO` and is suspending; do not wrap it in `withContext(Dispatchers.Main)`.
- Keys are typed; writing a `String` to a `booleanPreferencesKey` of the same name throws at read time. Keep keys in one object.
- `SharedPreferences` migration: pass `migrations = listOf(SharedPreferencesMigration(context, "old_prefs"))` to the factory once, then delete the migration code in a later release after the data has moved.
- Plain DataStore is not encrypted. Tokens go in Keystore-wrapped storage, not here.

## Sources

- https://developer.android.com/topic/libraries/architecture/datastore
- https://developer.android.com/jetpack/androidx/releases/datastore
- https://developer.android.com/codelabs/android-preferences-datastore
