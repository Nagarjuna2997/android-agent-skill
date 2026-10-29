# Dependency Injection: Hilt, Koin, and manual

Hilt is the default for new Android apps: compile-time validation, first-class ViewModel and WorkManager support, and a test story that swaps modules per test class. Koin is the lighter alternative when you want no annotation processing. Manual DI is right for an app with a handful of classes.

## Hilt

### Gradle setup

Hilt's version is not in `data/versions.json`; resolve `com.google.dagger:hilt-android` from the Dagger release page and use the same version for the plugin and the compiler. AndroidX Hilt integrations (`hilt-navigation-compose`, `hilt-work`) are 1.4.0.

```kotlin
// build.gradle.kts (project)
plugins {
    id("com.android.application") version "9.4.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20" apply false
    id("com.google.devtools.ksp") version "<version>" apply false
    id("com.google.dagger.hilt.android") version "<version>" apply false
}
```

```kotlin
// app/build.gradle.kts
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
    id("com.google.dagger.hilt.android")
}

dependencies {
    implementation("com.google.dagger:hilt-android:<version>")
    ksp("com.google.dagger:hilt-android-compiler:<version>")
    implementation("androidx.hilt:hilt-navigation-compose:1.4.0")
    implementation("androidx.hilt:hilt-work:1.4.0")
    ksp("androidx.hilt:hilt-compiler:1.4.0")

    androidTestImplementation("com.google.dagger:hilt-android-testing:<version>")
    kspAndroidTest("com.google.dagger:hilt-android-compiler:<version>")
    testImplementation("com.google.dagger:hilt-android-testing:<version>")
    kspTest("com.google.dagger:hilt-android-compiler:<version>")
}
```

### Application and entry points

```kotlin
package com.example.app

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class App : Application(), Configuration.Provider {
    @Inject lateinit var workerFactory: HiltWorkerFactory

    // Required so @HiltWorker workers get their dependencies.
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(workerFactory).build()
}
```

Also remove WorkManager's default initializer in the manifest when providing a custom configuration:

```xml
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
        setContent { AppTheme { AppNavHost() } }
    }
}
```

`@AndroidEntryPoint` goes on every Activity, Fragment, Service, BroadcastReceiver and View that needs field injection. With a single-Activity Compose app that is usually just `MainActivity` plus any services.

### Constructor injection

Most classes need no module at all. Annotate the constructor and Hilt builds it.

```kotlin
@Singleton
class TokenStore @Inject constructor(
    @ApplicationContext private val context: Context,
    private val keystore: KeystoreWrapper,
)
```

### Modules: @Binds vs @Provides

- `@Binds`: an abstract function that maps an interface to an implementation Hilt can already construct. Zero runtime cost; preferred.
- `@Provides`: a concrete function body, for third-party types (Retrofit, Room, OkHttp) or anything that needs builder logic.

```kotlin
package com.example.app.di

import android.content.Context
import androidx.room.Room
import com.example.app.core.database.AppDatabase
import com.example.app.core.database.TodoDao
import com.example.app.core.network.TodoApi
import com.example.app.data.todo.TodoRepositoryImpl
import com.example.app.domain.todo.TodoRepository
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class RepositoryModule {
    @Binds
    @Singleton
    abstract fun bindTodoRepository(impl: TodoRepositoryImpl): TodoRepository
}

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {
    @Provides @Singleton
    fun okHttp(): OkHttpClient = OkHttpClient.Builder().build()

    @Provides @Singleton
    fun json(): Json = Json { ignoreUnknownKeys = true }

    @Provides @Singleton
    fun retrofit(client: OkHttpClient, json: Json): Retrofit = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL)
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    @Provides @Singleton
    fun todoApi(retrofit: Retrofit): TodoApi = retrofit.create(TodoApi::class.java)
}

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {
    @Provides @Singleton
    fun database(@ApplicationContext context: Context): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, "app.db").build()

    @Provides
    fun todoDao(db: AppDatabase): TodoDao = db.todoDao()
}
```

A mixed module (abstract class with `@Binds` plus a `companion object` with `@Provides`) is legal but harder to read; keep them separate.

### Qualifiers

When two bindings share a type, disambiguate with a qualifier annotation. Dispatchers are the canonical case (shown in [mvvm.md](mvvm.md)); another is two `OkHttpClient`s.

```kotlin
@Qualifier @Retention(AnnotationRetention.RUNTIME) annotation class AuthenticatedClient
@Qualifier @Retention(AnnotationRetention.RUNTIME) annotation class PlainClient

@Provides @Singleton @PlainClient
fun plainClient(): OkHttpClient = OkHttpClient()

@Provides @Singleton @AuthenticatedClient
fun authClient(@PlainClient base: OkHttpClient, auth: AuthInterceptor): OkHttpClient =
    base.newBuilder().addInterceptor(auth).build()
```

Prefer a custom qualifier over `@Named("io")`: a typo in a string is a runtime failure, a typo in an annotation name is a compile error.

### Scopes and components

| Component | Scope annotation | Lifetime |
|---|---|---|
| `SingletonComponent` | `@Singleton` | Application |
| `ActivityRetainedComponent` | `@ActivityRetainedScoped` | Activity, survives config change |
| `ViewModelComponent` | `@ViewModelScoped` | One ViewModel |
| `ActivityComponent` | `@ActivityScoped` | Activity instance |
| `ServiceComponent` | `@ServiceScoped` | Service |

Unscoped bindings are created every time they are injected. Scope only what must be shared (database, HTTP client, repository with a cache) or is expensive. A scoped binding lives as long as its component, so a `@Singleton` holding an Activity reference is a leak.

### ViewModels

```kotlin
@HiltViewModel
class TodoViewModel @Inject constructor(
    private val repository: TodoRepository,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel()
```

In Compose, `hiltViewModel()` from `androidx.hilt:hilt-navigation-compose` scopes the ViewModel to the current `NavBackStackEntry`:

```kotlin
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun TodoRoute(viewModel: TodoViewModel = hiltViewModel()) { ... }
```

To share a ViewModel across a nested graph, pass the parent entry:

```kotlin
composable<CheckoutRoute.Address> { entry ->
    val parent = remember(entry) { navController.getBackStackEntry<CheckoutRoute>() }
    val vm: CheckoutViewModel = hiltViewModel(parent)
}
```

For ViewModels that need a runtime argument not available from `SavedStateHandle`, use `@HiltViewModel(assistedFactory = ...)` with an `@AssistedFactory` and `hiltViewModel(creationCallback = { factory -> factory.create(arg) })`. Prefer passing the argument as a navigation route field, which arrives in `SavedStateHandle` for free.

### Testing with Hilt

Instrumented tests replace production modules with fakes.

```kotlin
package com.example.app

import dagger.hilt.android.testing.CustomTestApplication

// Generates HiltTestApplication_Application; point the runner at it.
@CustomTestApplication(BaseTestApplication::class)
interface HiltTestApp

open class BaseTestApplication : android.app.Application()
```

```kotlin
package com.example.app

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import dagger.hilt.android.testing.HiltTestApplication

class HiltTestRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader?, name: String?, context: Context?): Application =
        super.newApplication(cl, HiltTestApplication::class.java.name, context)
}
```

Set `testInstrumentationRunner = "com.example.app.HiltTestRunner"` in `defaultConfig`.

```kotlin
package com.example.app.di

import com.example.app.domain.todo.TodoRepository
import com.example.app.testing.FakeTodoRepository
import dagger.Module
import dagger.Provides
import dagger.hilt.components.SingletonComponent
import dagger.hilt.testing.TestInstallIn
import javax.inject.Singleton

// Replaces RepositoryModule in every test in the androidTest source set.
@Module
@TestInstallIn(components = [SingletonComponent::class], replaces = [RepositoryModule::class])
object FakeRepositoryModule {
    @Provides @Singleton
    fun fakeTodoRepository(): TodoRepository = FakeTodoRepository()
}
```

```kotlin
@HiltAndroidTest
class TodoScreenTest {
    @get:Rule(order = 0) val hiltRule = HiltAndroidRule(this)
    @get:Rule(order = 1) val composeRule = createAndroidComposeRule<MainActivity>()

    @Inject lateinit var repository: TodoRepository   // the fake

    @Before fun setUp() = hiltRule.inject()

    @Test fun showsItems() {
        (repository as FakeTodoRepository).seed(listOf(TodoItem("1", "Milk", false, 0)))
        composeRule.onNodeWithText("Milk").assertIsDisplayed()
    }
}
```

For one test that needs a different binding than the rest, use `@UninstallModules(RepositoryModule::class)` on the test class plus an inner `@Module @InstallIn` object. `@TestInstallIn` is for the common case and compiles faster because it does not generate a per-test component.

Unit tests (the `test` source set) should not use Hilt at all. Construct the ViewModel directly with fakes, as in [mvvm.md](mvvm.md).

## Koin

Koin resolves dependencies at runtime from a DSL. No annotation processing, faster builds, less ceremony; the cost is that a missing binding is a runtime crash, not a compile error. Resolve the version from the Koin release page; it is not in `data/versions.json`.

```kotlin
dependencies {
    implementation("io.insert-koin:koin-android:<version>")
    implementation("io.insert-koin:koin-androidx-compose:<version>")
    implementation("io.insert-koin:koin-androidx-workmanager:<version>")
    testImplementation("io.insert-koin:koin-test-junit4:<version>")
}
```

```kotlin
package com.example.app.di

import androidx.room.Room
import com.example.app.core.database.AppDatabase
import com.example.app.data.todo.TodoRepositoryImpl
import com.example.app.domain.todo.TodoRepository
import com.example.app.todo.TodoViewModel
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import org.koin.android.ext.koin.androidContext
import org.koin.androidx.workmanager.dsl.workerOf
import org.koin.core.module.dsl.singleOf
import org.koin.core.module.dsl.viewModelOf
import org.koin.core.qualifier.named
import org.koin.dsl.bind
import org.koin.dsl.module

val appModule = module {
    single<CoroutineDispatcher>(named("io")) { Dispatchers.IO }
    single { Room.databaseBuilder(androidContext(), AppDatabase::class.java, "app.db").build() }
    single { get<AppDatabase>().todoDao() }
    single { OkHttpClient.Builder().build() }
    single { Retrofit.Builder().baseUrl(BuildConfig.API_BASE_URL).client(get()).build() }
    single { get<Retrofit>().create(TodoApi::class.java) }

    // singleOf uses constructor reference; `bind` maps the interface.
    singleOf(::TodoRepositoryImpl) bind TodoRepository::class

    viewModelOf(::TodoViewModel)
    workerOf(::PushWorker)
}
```

Note the `TodoRepositoryImpl` constructor's `io` dispatcher parameter needs a qualifier; with `singleOf` that requires the explicit form: `single<TodoRepository> { TodoRepositoryImpl(get(), get(), get(), get(), get(named("io"))) }`.

```kotlin
package com.example.app

import android.app.Application
import org.koin.android.ext.koin.androidContext
import org.koin.android.ext.koin.androidLogger
import org.koin.androidx.workmanager.koin.workManagerFactory
import org.koin.core.context.startKoin

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        startKoin {
            androidLogger()
            androidContext(this@App)
            workManagerFactory()
            modules(appModule)
        }
    }
}
```

Compose:

```kotlin
import org.koin.androidx.compose.koinViewModel

@Composable
fun TodoRoute(viewModel: TodoViewModel = koinViewModel()) { ... }
```

Verify the graph in a unit test so a missing binding fails in CI rather than on a user's phone:

```kotlin
class KoinModuleTest {
    @Test
    fun `module graph resolves`() {
        appModule.verify(extraTypes = listOf(android.content.Context::class, SavedStateHandle::class))
    }
}
```

Replace bindings in tests with `loadKoinModules(module { single<TodoRepository> { FakeTodoRepository() } })` after `startKoin`, or use `koinApplication { }` in a test rule.

## Manual DI

For a small app (a few screens, one repository) a hand-written container is honest and debuggable.

```kotlin
package com.example.app

class AppContainer(context: Context) {
    private val db = Room.databaseBuilder(context, AppDatabase::class.java, "app.db").build()
    private val api: TodoApi = Retrofit.Builder().baseUrl(BuildConfig.API_BASE_URL).build().create(TodoApi::class.java)
    val todoRepository: TodoRepository by lazy {
        TodoRepositoryImpl(db.todoDao(), api, Clock.systemUTC(), NoOpSyncScheduler, Dispatchers.IO)
    }
}

class App : Application() {
    lateinit var container: AppContainer
    override fun onCreate() { super.onCreate(); container = AppContainer(this) }
}
```

ViewModels get a factory via `viewModel(factory = ...)` or `CreationExtras`:

```kotlin
val TodoViewModelFactory = viewModelFactory {
    initializer {
        val app = this[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY] as App
        TodoViewModel(app.container.todoRepository, createSavedStateHandle(), Dispatchers.IO)
    }
}

@Composable
fun TodoRoute(viewModel: TodoViewModel = viewModel(factory = TodoViewModelFactory)) { ... }
```

Switch to Hilt when the container grows past about a dozen entries or when you add WorkManager, multiple modules, or instrumented tests that need substitution.

## Choosing

| Criterion | Hilt | Koin | Manual |
|---|---|---|---|
| Missing binding detected | Compile time | Runtime (or `verify()` test) | Compile time |
| Build cost | KSP pass | None | None |
| Multi-module | Strong | Fine | Painful |
| WorkManager, Navigation, Compose integration | Official AndroidX artifacts | Koin artifacts | Hand-rolled |
| Learning curve | Annotations and components | DSL | None |

Default to Hilt. Pick Koin if the team already uses it or build time dominates. Pick manual for prototypes and apps under ~10 classes.

## Avoid

```kotlin
// Anti-pattern: service locator reached from inside a class. Hides dependencies, untestable.
class TodoViewModel : ViewModel() {
    private val repo = EntryPointAccessors.fromApplication(ctx, RepoEntryPoint::class.java).repo()
}

// Anti-pattern: @Singleton on something that holds an Activity Context.
@Singleton class Toaster @Inject constructor(@ActivityContext private val context: Context)

// Anti-pattern: string-named qualifiers.
@Named("io") val dispatcher: CoroutineDispatcher

// Anti-pattern: Hilt in JVM unit tests. Construct the class directly.
@HiltAndroidTest class TodoViewModelTest
```

## Verify

```sh
./gradlew :app:assembleDebug            # Hilt validates the graph at compile time
./gradlew :app:testDebugUnitTest         # Koin: runs the verify() test
./gradlew :app:connectedDebugAndroidTest # @HiltAndroidTest classes
```

A Hilt graph error shows up as a `[Dagger/MissingBinding]` message in the compile output; read the full chain it prints, the root cause is at the bottom.

## Sources

- https://developer.android.com/training/dependency-injection
- https://developer.android.com/training/dependency-injection/hilt-android
- https://developer.android.com/training/dependency-injection/hilt-jetpack
- https://developer.android.com/training/dependency-injection/hilt-testing
- https://developer.android.com/training/dependency-injection/manual
- https://developer.android.com/jetpack/androidx/releases/hilt
- https://dagger.dev/hilt/
- https://insert-koin.io/docs/reference/koin-android/start
