# Koin dependency injection

Koin as the no-codegen alternative to Hilt: module DSL, `startKoin` in `Application`, `koinViewModel()` in Compose navigation, qualifiers for dispatchers, WorkManager worker factory, a `checkModules`-style verification test and module overrides in tests.

## When to use

- The project already uses Koin, is Kotlin Multiplatform, or the user explicitly wants a runtime DI container without annotation processing.
- Otherwise use [hilt-di](../hilt-di/README.md). Compile-time graph validation catches missing bindings before you run the app; Koin catches them at resolution time unless you run the verification test below.

## Dependencies

Koin's version is not in `data/versions.json`; resolve it from the release page. All Koin artifacts use one version through the Koin BOM.

`gradle/libs.versions.toml`:

```toml
[versions]
koin = "<version>"     # https://github.com/InsertKoinIO/koin/releases

[libraries]
koin-bom = { group = "io.insert-koin", name = "koin-bom", version.ref = "koin" }
koin-android = { group = "io.insert-koin", name = "koin-android" }
koin-androidx-compose = { group = "io.insert-koin", name = "koin-androidx-compose" }
koin-androidx-compose-navigation = { group = "io.insert-koin", name = "koin-androidx-compose-navigation" }
koin-androidx-workmanager = { group = "io.insert-koin", name = "koin-androidx-workmanager" }
koin-test = { group = "io.insert-koin", name = "koin-test" }
koin-test-junit4 = { group = "io.insert-koin", name = "koin-test-junit4" }
```

`app/build.gradle.kts`:

```kotlin
dependencies {
    implementation(platform(libs.koin.bom))
    implementation(libs.koin.android)
    implementation(libs.koin.androidx.compose)
    implementation(libs.koin.androidx.compose.navigation)
    implementation(libs.koin.androidx.workmanager)   // only with WorkManager
    testImplementation(libs.koin.test)
    testImplementation(libs.koin.test.junit4)
}
```

## Manifest and permissions

Register the `Application` subclass. If you use Koin's WorkManager factory, also remove the default WorkManager initializer (see [work-manager](../work-manager/README.md)).

```xml
<application android:name=".App" ...>
```

## Implementation

### Qualifiers and modules

```kotlin
package com.example.app.di

import com.example.app.data.NoteRepository
import com.example.app.data.RoomNoteRepository
import com.example.app.data.local.AppDatabase
import com.example.app.ui.detail.NoteDetailViewModel
import com.example.app.ui.notes.NotesViewModel
import androidx.room.Room
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.koin.android.ext.koin.androidContext
import org.koin.core.module.dsl.viewModel
import org.koin.core.qualifier.named
import org.koin.dsl.bind
import org.koin.dsl.module

val IO = named("io")
val DEFAULT = named("default")
val APP_SCOPE = named("appScope")

val coroutinesModule = module {
    single<CoroutineDispatcher>(IO) { Dispatchers.IO }
    single<CoroutineDispatcher>(DEFAULT) { Dispatchers.Default }
    single<CoroutineScope>(APP_SCOPE) { CoroutineScope(SupervisorJob() + get<CoroutineDispatcher>(DEFAULT)) }
}

val dataModule = module {
    single {
        Room.databaseBuilder(androidContext(), AppDatabase::class.java, "app.db").build()
    }
    single { get<AppDatabase>().noteDao() }
    single { RoomNoteRepository(get()) } bind NoteRepository::class
}

val viewModelModule = module {
    viewModel { NotesViewModel(get()) }
    viewModel { params -> NoteDetailViewModel(savedStateHandle = params.get(), repository = get()) }
}

val appModules = listOf(coroutinesModule, dataModule, viewModelModule)
```

`single` is one instance for the whole container; `factory` creates a new one each call; `viewModel` ties the instance to the Android `ViewModelStore`. Prefer `single` for repositories and clients, `viewModel` for ViewModels, and reserve `factory` for stateless helpers.

Koin Annotations (`koin-annotations` + KSP) generate these modules from `@Single`, `@Factory` and `@KoinViewModel` if the team prefers; the DSL is the baseline here because it has no processor.

### Application start

```kotlin
package com.example.app

import android.app.Application
import com.example.app.di.appModules
import org.koin.android.ext.koin.androidContext
import org.koin.android.ext.koin.androidLogger
import org.koin.androidx.workmanager.koin.workManagerFactory
import org.koin.core.context.startKoin
import org.koin.core.logger.Level

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        startKoin {
            androidLogger(if (BuildConfig.DEBUG) Level.DEBUG else Level.NONE)
            androidContext(this@App)
            workManagerFactory()        // registers KoinWorkerFactory; drop when not using WorkManager
            modules(appModules)
        }
    }
}
```

### ViewModel with SavedStateHandle

```kotlin
package com.example.app.ui.detail

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation.toRoute
import com.example.app.data.NoteRepository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.serialization.Serializable

@Serializable data class NoteDetailRoute(val id: String)

sealed interface DetailUiState {
    data object Loading : DetailUiState
    data object NotFound : DetailUiState
    data class Content(val title: String, val body: String) : DetailUiState
}

class NoteDetailViewModel(
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
import org.koin.androidx.compose.koinViewModel

composable<NoteDetailRoute> {
    val viewModel: NoteDetailViewModel = koinViewModel()
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    NoteDetailScreen(state)
}
```

`koinViewModel()` passes the back-stack entry's `SavedStateHandle` automatically when the definition declares a `SavedStateHandle` parameter (`params.get()` or a direct `get()` resolves it). For extra runtime parameters use `koinViewModel { parametersOf(id) }`.

Inject non-ViewModel objects into composables with `koinInject<NoteRepository>()` sparingly; the ViewModel should own dependencies so composables stay previewable.

### WorkManager worker

```kotlin
import org.koin.androidx.workmanager.dsl.workerOf

class SyncWorker(
    appContext: Context,
    params: WorkerParameters,
    private val repository: NoteRepository,
) : CoroutineWorker(appContext, params) { /* ... */ }

val workerModule = module {
    workerOf(::SyncWorker)
}
```

Add `workerModule` to `appModules`.

### Previews and tests without Koin

Composables take state and lambdas, not Koin lookups, so `@Preview`s construct fake state directly. ViewModel unit tests construct the class with a `FakeNoteRepository`; no container needed.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*KoinModulesTest*"
adb logcat -s Koin     # debug build prints module loading and the time taken
```

Graph verification test (JVM). Koin's `verify()` checks that every constructor parameter in every definition is resolvable, including Android-provided types you declare as extras:

```kotlin
import org.koin.test.verify.verify
import org.koin.core.annotation.KoinExperimentalAPI

@OptIn(KoinExperimentalAPI::class)
class KoinModulesTest {
    @Test fun modulesResolve() {
        module { includes(appModules) }.verify(
            extraTypes = listOf(
                android.content.Context::class,
                androidx.lifecycle.SavedStateHandle::class,
                androidx.work.WorkerParameters::class,
            )
        )
    }
}
```

Note `verify()` is annotated `@KoinExperimentalAPI`; it is the documented way to check a graph on the JVM and has been stable in practice, but the opt-in makes that status explicit. The older `checkModules()` requires an Android context in the test and is deprecated.

Instrumented test overriding a module:

```kotlin
@Test fun showsFakeNotes() {
    loadKoinModules(module { single<NoteRepository>(override = true) { FakeNoteRepository(listOf(Note("1", "Hello", "", 0))) } })
    composeRule.setContent { AppRoot() }
    composeRule.onNodeWithText("Hello").assertIsDisplayed()
    unloadKoinModules(/* the same module */)
}
```

Enable overrides globally with `allowOverride(true)` inside `startKoin` for the test application, or use `KoinTestRule` from `koin-test-junit4`.

## Pitfalls

- Missing definitions surface at runtime as `NoDefinitionFoundException`. Run the `verify()` test in CI; it is the compile-time check Koin does not give you otherwise.
- Calling `startKoin` twice (for example in a test and the `Application`) throws `KoinApplicationAlreadyStartedException`. Use `KoinTestRule` or `stopKoin()` in `@After`.
- `androidLogger()` at `Level.DEBUG` in release slows startup and leaks class names; gate on `BuildConfig.DEBUG`.
- `single` with an Activity `Context` captured leaks the Activity. Resolve `androidContext()` (application) in modules.
- `get()` inside a composable body re-resolves on every recomposition; use `koinInject()` which remembers, or better, route through the ViewModel.
- Koin resolves lazily; a mis-scoped `viewModel` declared as `single` survives screen changes and shares state across destinations.

## Sources

- https://insert-koin.io/docs/reference/koin-android/start
- https://insert-koin.io/docs/reference/koin-android/viewmodel
- https://insert-koin.io/docs/reference/koin-compose/compose
- https://insert-koin.io/docs/reference/koin-android/workmanager
- https://insert-koin.io/docs/reference/koin-test/verify
