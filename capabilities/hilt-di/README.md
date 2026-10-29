# Hilt dependency injection

Dagger Hilt wiring for a Compose app: Gradle plugin and KSP, `@HiltAndroidApp`, `@AndroidEntryPoint`, modules for bindings and provisions, dispatcher qualifiers, `hiltViewModel()` in navigation, AndroidX Hilt integrations (WorkManager, Navigation Compose) and a test that swaps a module.

## When to use

- The default DI choice for Android apps in this repository. Compile-time validation, generated components for Android lifecycle classes, and first-party integrations with ViewModel, WorkManager and Compose navigation.
- Use [koin-di](../koin-di/README.md) when the project already uses Koin, is Kotlin Multiplatform, or the user wants no annotation processing.

## Dependencies

Dagger Hilt's version is not in `data/versions.json` (only AndroidX Hilt 1.4.0 is). Resolve the Dagger version from the release page and use it for the plugin, `hilt-android` and `hilt-compiler` together.

`gradle/libs.versions.toml`:

```toml
[versions]
hilt = "<version>"           # https://github.com/google/dagger/releases
androidx-hilt = "1.4.0"
ksp = "<version>"            # https://github.com/google/ksp/releases ; matches Kotlin 2.4.20

[libraries]
hilt-android = { group = "com.google.dagger", name = "hilt-android", version.ref = "hilt" }
hilt-compiler = { group = "com.google.dagger", name = "hilt-android-compiler", version.ref = "hilt" }
hilt-android-testing = { group = "com.google.dagger", name = "hilt-android-testing", version.ref = "hilt" }
androidx-hilt-navigation-compose = { group = "androidx.hilt", name = "hilt-navigation-compose", version.ref = "androidx-hilt" }
androidx-hilt-work = { group = "androidx.hilt", name = "hilt-work", version.ref = "androidx-hilt" }
androidx-hilt-compiler = { group = "androidx.hilt", name = "hilt-compiler", version.ref = "androidx-hilt" }

[plugins]
hilt = { id = "com.google.dagger.hilt.android", version.ref = "hilt" }
ksp = { id = "com.google.devtools.ksp", version.ref = "ksp" }
```

Root `build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.ksp) apply false
}
```

`app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.hilt)
    alias(libs.plugins.ksp)
}

dependencies {
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.androidx.hilt.navigation.compose)
    implementation(libs.androidx.hilt.work)        // only with WorkManager
    ksp(libs.androidx.hilt.compiler)               // only with hilt-work or other androidx.hilt processors
    androidTestImplementation(libs.hilt.android.testing)
    kspAndroidTest(libs.hilt.compiler)
}
```

## Manifest and permissions

The `Application` subclass must be registered:

```xml
<application android:name=".App" ...>
```

No permissions.

## Implementation

### Application and entry points

```kotlin
package com.example.app

import android.app.Application
import dagger.hilt.android.HiltAndroidApp

@HiltAndroidApp
class App : Application()
```

```kotlin
package com.example.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { AppRoot() }
    }
}
```

Every Activity, Fragment, Service or BroadcastReceiver that receives injected fields needs `@AndroidEntryPoint`. Composables do not; they obtain ViewModels through `hiltViewModel()`.

### Qualifiers and dispatchers

```kotlin
package com.example.app.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import javax.inject.Qualifier
import javax.inject.Singleton

@Qualifier @Retention(AnnotationRetention.BINARY) annotation class IoDispatcher
@Qualifier @Retention(AnnotationRetention.BINARY) annotation class DefaultDispatcher
@Qualifier @Retention(AnnotationRetention.BINARY) annotation class ApplicationScope

@Module
@InstallIn(SingletonComponent::class)
object CoroutinesModule {
    @Provides @IoDispatcher fun io(): CoroutineDispatcher = Dispatchers.IO
    @Provides @DefaultDispatcher fun default(): CoroutineDispatcher = Dispatchers.Default

    @Provides @Singleton @ApplicationScope
    fun applicationScope(@DefaultDispatcher dispatcher: CoroutineDispatcher): CoroutineScope =
        CoroutineScope(SupervisorJob() + dispatcher)
}
```

Inject dispatchers rather than referencing `Dispatchers.IO` inline so tests can pass `StandardTestDispatcher`. The application scope is for work that must outlive a ViewModel (for example, writing a cache after the screen closes); it is not a replacement for WorkManager.

### Binding interfaces

```kotlin
package com.example.app.di

import com.example.app.data.NoteRepository
import com.example.app.data.RoomNoteRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class RepositoryModule {
    @Binds @Singleton
    abstract fun bindNoteRepository(impl: RoomNoteRepository): NoteRepository
}
```

Use `@Binds` for interface-to-implementation; use `@Provides` only when you must call a builder (Room, Retrofit, DataStore). Constructor-inject everything else with `@Inject constructor`.

### ViewModel with SavedStateHandle

```kotlin
package com.example.app.ui.detail

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.toRoute
import com.example.app.data.NoteRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.serialization.Serializable
import javax.inject.Inject

@Serializable data class NoteDetailRoute(val id: String)

sealed interface DetailUiState {
    data object Loading : DetailUiState
    data object NotFound : DetailUiState
    data class Content(val title: String, val body: String) : DetailUiState
}

@HiltViewModel
class NoteDetailViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    repository: NoteRepository,
) : ViewModel() {
    private val route = savedStateHandle.toRoute<NoteDetailRoute>()

    val uiState = repository.observeNote(route.id)
        .map { note -> note?.let { DetailUiState.Content(it.title, it.body) } ?: DetailUiState.NotFound }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), DetailUiState.Loading)
}
```

In Navigation Compose:

```kotlin
composable<NoteDetailRoute> {
    val viewModel: NoteDetailViewModel = hiltViewModel()
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    NoteDetailScreen(state)
}
```

`hiltViewModel()` comes from `androidx.hilt.navigation.compose`. It scopes the ViewModel to the back-stack entry, so each destination instance gets its own.

For runtime parameters that are not navigation arguments, use `@AssistedInject` with `@HiltViewModel(assistedFactory = ...)` and `hiltViewModel(creationCallback = { factory -> factory.create(param) })`.

### WorkManager integration

```kotlin
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val repository: NoteRepository,
) : CoroutineWorker(appContext, params) { /* ... */ }

@HiltAndroidApp
class App : Application(), Configuration.Provider {
    @Inject lateinit var workerFactory: HiltWorkerFactory
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(workerFactory).build()
}
```

Remove the default `WorkManagerInitializer` from the manifest as shown in [work-manager](../work-manager/README.md).

### Entry points for non-Android classes

When a class that Hilt cannot inject (for example a `ContentProvider` or a Glance widget receiver) needs a dependency:

```kotlin
@EntryPoint
@InstallIn(SingletonComponent::class)
interface WidgetEntryPoint { fun noteRepository(): NoteRepository }

val repo = EntryPointAccessors.fromApplication(context, WidgetEntryPoint::class.java).noteRepository()
```

## Verify

```sh
./gradlew :app:assembleDebug           # Hilt validation fails the build on a missing binding
./gradlew :app:testDebugUnitTest
./gradlew :app:connectedDebugAndroidTest --tests "*HiltSmokeTest*"
```

A Hilt instrumented test that replaces a module:

```kotlin
@UninstallModules(RepositoryModule::class)
@HiltAndroidTest
class HiltSmokeTest {
    @get:Rule(order = 0) val hiltRule = HiltAndroidRule(this)
    @get:Rule(order = 1) val composeRule = createAndroidComposeRule<MainActivity>()

    @Module @InstallIn(SingletonComponent::class)
    object FakeRepositoryModule {
        @Provides @Singleton fun repo(): NoteRepository = FakeNoteRepository(listOf(Note("1", "Hello", "", 0)))
    }

    @Test fun showsNotesFromFakeRepository() {
        hiltRule.inject()
        composeRule.onNodeWithText("Hello").assertIsDisplayed()
    }
}
```

Set `testInstrumentationRunner` to a `HiltTestApplication`-based runner (`CustomTestRunner` that overrides `newApplication` to return `HiltTestApplication`).

ViewModel unit tests do not need Hilt at all: construct the ViewModel directly with fakes and a test dispatcher.

## Pitfalls

- Hilt plugin, `hilt-android` and `hilt-android-compiler` must share one version. AndroidX Hilt (`androidx.hilt:*`, 1.4.0) is a separate line; do not set it to the Dagger version.
- Use KSP for Hilt. If the project still has `kapt` for anything, migrate it; mixing processors slows builds and the Hilt kapt path is legacy.
- `@Singleton` on an `@Provides` in a non-`SingletonComponent` module is a compile error. Match scope to component.
- `@AndroidEntryPoint` on a base Activity class requires the subclass to be annotated too.
- Injecting `Activity` context into a `@Singleton` leaks the Activity. Inject `@ApplicationContext`.
- ViewModels obtained with `viewModel()` (not `hiltViewModel()`) bypass Hilt and crash with a missing-factory error.
- Hilt does not inject into `BroadcastReceiver` field members registered dynamically; use `@AndroidEntryPoint` only for manifest-registered receivers, or use entry points.

## Sources

- https://developer.android.com/training/dependency-injection/hilt-android
- https://developer.android.com/training/dependency-injection/hilt-jetpack
- https://developer.android.com/training/dependency-injection/hilt-testing
- https://developer.android.com/jetpack/androidx/releases/hilt
- https://dagger.dev/hilt/
