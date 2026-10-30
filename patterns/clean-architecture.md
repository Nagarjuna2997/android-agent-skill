# Clean Architecture and Modularization

How to split an Android app into Gradle modules with clear dependency direction, where use cases earn their place, how to map between layers, and how to keep the build configuration from being copied into every module.

## Dependency direction

```
:app ──────────────────────────────────────────────────┐
  │ depends on every :feature:* and wires DI             │
  ▼                                                      │
:feature:todo  :feature:settings  :feature:checkout      │
  │ ViewModels, screens, navigation entries              │
  ▼                                                      ▼
:domain          ◀── :data:todo  :data:user   ◀── :core:network  :core:database
  │ models, repository interfaces, use cases      implementations    Retrofit/OkHttp   Room
  ▼
:core:common  :core:ui  :core:testing
  Result types, dispatchers, theme, test rules
```

Rules:

- `:domain` depends on nothing Android. Pure Kotlin (`kotlin("jvm")` plugin), so it compiles fast and its tests need no Robolectric.
- `:data:*` modules implement `:domain` interfaces and depend on `:core:network`, `:core:database`. Features never depend on `:data:*` directly; Hilt binds the implementation in `:app`.
- `:feature:*` modules depend on `:domain` and `:core:ui`, never on each other. Cross-feature navigation goes through routes defined in `:core:navigation` or passed in as lambdas from `:app`.
- `:app` is thin: `Application` class, `MainActivity`, the `NavHost` that assembles feature graphs, and DI modules that bind data implementations.

## Module layout

```
settings.gradle.kts
build-logic/
  convention/
    build.gradle.kts
    src/main/kotlin/
      AndroidApplicationConventionPlugin.kt
      AndroidLibraryConventionPlugin.kt
      AndroidLibraryComposeConventionPlugin.kt
      AndroidHiltConventionPlugin.kt
      JvmLibraryConventionPlugin.kt
app/
core/
  common/      Result, dispatcher qualifiers, Clock
  ui/          AppTheme, shared composables, preview providers
  network/     Retrofit, OkHttp, serializers, auth interceptor
  database/    Room database, DAOs, entities
  testing/     MainDispatcherRule, fakes shared across tests
domain/        models, repository interfaces, use cases
data/
  todo/        TodoRepositoryImpl, mappers, sync
  user/
feature/
  todo/
  settings/
```

`settings.gradle.kts`:

```kotlin
pluginManagement {
    includeBuild("build-logic")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "App"
include(":app")
include(":core:common", ":core:ui", ":core:network", ":core:database", ":core:testing")
include(":domain")
include(":data:todo", ":data:user")
include(":feature:todo", ":feature:settings")
```

## Domain layer

Models, repository interfaces and use cases. No `android.*` imports.

```kotlin
// domain/build.gradle.kts
plugins {
    id("com.example.jvm.library")   // convention plugin, see below
}
dependencies {
    implementation(project(":core:common"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:<version>")
    implementation("javax.inject:javax.inject:1")
}
```

```kotlin
package com.example.app.domain.todo

import kotlinx.coroutines.flow.Flow

data class TodoItem(val id: String, val title: String, val isCompleted: Boolean)

interface TodoRepository {
    fun observeAll(): Flow<List<TodoItem>>
    suspend fun add(title: String)
    suspend fun setCompleted(id: String, completed: Boolean)
}
```

### Use cases

A use case is a class with one public `operator fun invoke`. It exists to hold business logic that is reused by more than one ViewModel, or that combines more than one repository. A use case that just forwards one repository call is noise; call the repository from the ViewModel.

```kotlin
package com.example.app.domain.todo

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import javax.inject.Inject

/** Items that are due today for the current user, respecting their timezone preference. */
class ObserveTodaysTodosUseCase @Inject constructor(
    private val todos: TodoRepository,
    private val userPrefs: UserPreferencesRepository,
    private val clock: java.time.Clock,
) {
    operator fun invoke(): Flow<List<TodoItem>> =
        combine(todos.observeAll(), userPrefs.observeTimeZone()) { items, zone ->
            val today = java.time.LocalDate.now(clock.withZone(zone))
            items.filter { it.dueDate == today }
        }
}
```

Worth a use case: anything that combines sources, has a non-trivial rule, or runs in several screens. Not worth one: `GetTodosUseCase` wrapping `repository.observeAll()`.

Use cases are stateless and cheap to construct; do not scope them to `@Singleton`. Main-safe is the contract: a use case that does CPU work should take an injected dispatcher and `withContext` to it itself, so callers do not have to know.

## Data layer and mapping

Each layer has its own types. Mapping functions live in the data module, next to the type they convert from.

```kotlin
// data/todo/src/main/kotlin/.../TodoMappers.kt
package com.example.app.data.todo

import com.example.app.core.database.TodoEntity
import com.example.app.core.network.TodoDto
import com.example.app.domain.todo.TodoItem

internal fun TodoEntity.toDomain() = TodoItem(id = id, title = title, isCompleted = completed)

internal fun TodoDto.toEntity() = TodoEntity(
    id = id,
    title = title,
    completed = isDone,          // field names differ by layer; the mapper absorbs that
    updatedAt = updatedAtEpochMs,
)

internal fun TodoItem.toEntity(updatedAt: Long) = TodoEntity(id, title, isCompleted, updatedAt)
```

Mark mappers `internal` so a feature module cannot reach into entity types. The repository implementation (see [repository.md](repository.md)) is also `internal`; only the Hilt module in `:app` or in the data module itself sees it.

```kotlin
// data/todo/src/main/kotlin/.../di/TodoDataModule.kt
package com.example.app.data.todo.di

import com.example.app.data.todo.TodoRepositoryImpl
import com.example.app.domain.todo.TodoRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent

@Module
@InstallIn(SingletonComponent::class)
internal abstract class TodoDataModule {
    @Binds
    abstract fun bindTodoRepository(impl: TodoRepositoryImpl): TodoRepository
}
```

Putting the binding in the data module (rather than `:app`) means `:app` needs only `implementation(project(":data:todo"))` for Hilt to find it. Feature modules still never see the implementation because it is `internal`.

## Feature modules

A feature module exposes its navigation entry and nothing else.

```kotlin
// feature/todo/src/main/kotlin/.../TodoNavigation.kt
package com.example.app.feature.todo

import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import kotlinx.serialization.Serializable

@Serializable
data object TodoListRoute

fun NavGraphBuilder.todoListScreen(onOpenSettings: () -> Unit) {
    composable<TodoListRoute> {
        TodoRoute(onOpenSettings = onOpenSettings)
    }
}
```

`:app` composes the graph:

```kotlin
NavHost(navController, startDestination = TodoListRoute) {
    todoListScreen(onOpenSettings = { navController.navigate(SettingsRoute) })
    settingsScreen(onBack = { navController.popBackStack() })
}
```

Routes a feature navigates to but does not own go in `:core:navigation` (a tiny module with only `@Serializable` route classes), or are passed in as lambdas as above. See [navigation.md](navigation.md).

## Gradle convention plugins

Without convention plugins every `build.gradle.kts` repeats `compileSdk`, `minSdk`, Java/Kotlin targets and Compose setup, and they drift. Put the shared configuration in an included build.

```kotlin
// build-logic/settings.gradle.kts
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
    versionCatalogs { create("libs") { from(files("../gradle/libs.versions.toml")) } }
}
rootProject.name = "build-logic"
include(":convention")
```

```kotlin
// build-logic/convention/build.gradle.kts
plugins { `kotlin-dsl` }

dependencies {
    compileOnly(libs.android.gradlePlugin)       // com.android.tools.build:gradle:9.4.0
    compileOnly(libs.kotlin.gradlePlugin)        // org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.20
    compileOnly(libs.compose.gradlePlugin)       // org.jetbrains.kotlin:compose-compiler-gradle-plugin:2.4.20
    compileOnly(libs.ksp.gradlePlugin)
}

gradlePlugin {
    plugins {
        register("androidApplication") {
            id = "com.example.android.application"
            implementationClass = "AndroidApplicationConventionPlugin"
        }
        register("androidLibrary") {
            id = "com.example.android.library"
            implementationClass = "AndroidLibraryConventionPlugin"
        }
        register("androidLibraryCompose") {
            id = "com.example.android.library.compose"
            implementationClass = "AndroidLibraryComposeConventionPlugin"
        }
        register("androidHilt") {
            id = "com.example.android.hilt"
            implementationClass = "AndroidHiltConventionPlugin"
        }
        register("jvmLibrary") {
            id = "com.example.jvm.library"
            implementationClass = "JvmLibraryConventionPlugin"
        }
    }
}
```

```kotlin
// build-logic/convention/src/main/kotlin/AndroidLibraryConventionPlugin.kt
import com.android.build.api.dsl.LibraryExtension
import org.gradle.api.JavaVersion
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure

class AndroidLibraryConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply("com.android.library")
            pluginManager.apply("org.jetbrains.kotlin.android")

            extensions.configure<LibraryExtension> {
                compileSdk = 37
                defaultConfig {
                    minSdk = 26   // notification channels and adaptive icons without compat branches
                    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
                }
                compileOptions {
                    sourceCompatibility = JavaVersion.VERSION_17
                    targetCompatibility = JavaVersion.VERSION_17
                }
                testOptions.unitTests.isIncludeAndroidResources = true
            }
        }
    }
}
```

```kotlin
// build-logic/convention/src/main/kotlin/AndroidLibraryComposeConventionPlugin.kt
import com.android.build.api.dsl.LibraryExtension
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.dependencies
import org.gradle.kotlin.dsl.getByType

class AndroidLibraryComposeConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply("com.example.android.library")
            // Kotlin 2.x: the Compose compiler ships with the Kotlin plugin.
            pluginManager.apply("org.jetbrains.kotlin.plugin.compose")

            val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
            extensions.configure<LibraryExtension> { buildFeatures.compose = true }
            dependencies {
                val bom = libs.findLibrary("androidx-compose-bom").get()   // 2026.09.00
                "implementation"(platform(bom))
                "implementation"(libs.findLibrary("androidx-compose-material3").get())
                "implementation"(libs.findLibrary("androidx-compose-ui-tooling-preview").get())
                "debugImplementation"(libs.findLibrary("androidx-compose-ui-tooling").get())
                "androidTestImplementation"(platform(bom))
            }
        }
    }
}
```

```kotlin
// build-logic/convention/src/main/kotlin/AndroidHiltConventionPlugin.kt
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.kotlin.dsl.dependencies
import org.gradle.kotlin.dsl.getByType

class AndroidHiltConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply("com.google.devtools.ksp")
            pluginManager.apply("dagger.hilt.android.plugin")
            val libs = extensions.getByType<VersionCatalogsExtension>().named("libs")
            dependencies {
                "implementation"(libs.findLibrary("hilt-android").get())
                "ksp"(libs.findLibrary("hilt-compiler").get())
            }
        }
    }
}
```

A feature module's build file then shrinks to:

```kotlin
// feature/todo/build.gradle.kts
plugins {
    id("com.example.android.library.compose")
    id("com.example.android.hilt")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android { namespace = "com.example.app.feature.todo" }

dependencies {
    implementation(project(":domain"))
    implementation(project(":core:ui"))
    implementation(project(":core:common"))
    implementation(libs.androidx.navigation.compose)      // 2.10.2
    implementation(libs.androidx.lifecycle.runtime.compose) // 2.11.0
    implementation(libs.androidx.hilt.navigation.compose)   // 1.4.0
    testImplementation(project(":core:testing"))
}
```

## Feature api and impl modules

When several features navigate to each other, the layout above forces every cross-feature route into `:core:navigation` or into lambdas threaded through `:app`. The split used by Now in Android (see [../references/nowinandroid.md](../references/nowinandroid.md)) is to give each feature two modules:

```
feature/
  orders/
    api/     the navigation key(s) only; depends on :core:navigation; pure "what can be navigated to"
    impl/    screens, ViewModels, the entry provider; depends on :domain, :core:ui, :core:designsystem and other features' api
```

Rules:

- `:feature:x:api` contains `@Serializable` route/key classes and nothing else. It may depend on `:core:navigation` and `:core:model`. It never depends on Compose.
- `:feature:x:impl` depends on its own `api`, on other features' `api` modules, never on another `impl`.
- `:app` depends on every `impl` and wires them into the `NavHost` (Navigation Compose) or the entry provider (Navigation 3).
- Two convention plugins encode the allowed dependencies so a reviewer does not have to.

```kotlin
// feature/orders/api/src/main/kotlin/com/example/app/feature/orders/api/OrdersRoutes.kt
package com.example.app.feature.orders.api

import kotlinx.serialization.Serializable

@Serializable
data object OrderListRoute

@Serializable
data class OrderDetailRoute(val orderId: String)
```

```kotlin
// feature/orders/impl/src/main/kotlin/com/example/app/feature/orders/impl/OrdersNavigation.kt
package com.example.app.feature.orders.impl

import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.example.app.feature.orders.api.OrderDetailRoute
import com.example.app.feature.orders.api.OrderListRoute
import com.example.app.feature.customers.api.CustomerRoute   // another feature's api, never its impl

fun NavGraphBuilder.ordersGraph(
    onOpenOrder: (OrderDetailRoute) -> Unit,
    onOpenCustomer: (CustomerRoute) -> Unit,
    onBack: () -> Unit,
) {
    composable<OrderListRoute> {
        OrderListRoute(onOpenOrder = { id -> onOpenOrder(OrderDetailRoute(id)) })
    }
    composable<OrderDetailRoute> { entry ->
        val route = entry.toRoute<OrderDetailRoute>()
        OrderDetailRoute(orderId = route.orderId, onOpenCustomer = onOpenCustomer, onBack = onBack)
    }
}
```

With Navigation 3 (1.2.0) the `api` class implements `NavKey` and the `impl` exposes `fun EntryProviderScope<NavKey>.ordersEntries(navigator: Navigator)`; see [navigation.md](navigation.md). The module boundary is identical.

The convention plugins (registered in the build-logic example below):

```kotlin
// build-logic/convention/src/main/kotlin/AndroidFeatureApiConventionPlugin.kt
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.dependencies

class AndroidFeatureApiConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("com.example.android.library")
        pluginManager.apply("org.jetbrains.kotlin.plugin.serialization")
        dependencies {
            "api"(project(":core:navigation"))      // route base types are part of this module's API
            "implementation"(libs.findLibrary("kotlinx-serialization-core").get())
        }
    }
}
```

```kotlin
// build-logic/convention/src/main/kotlin/AndroidFeatureImplConventionPlugin.kt
import com.android.build.api.dsl.LibraryExtension
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.dependencies

class AndroidFeatureImplConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("com.example.android.library.compose")
        pluginManager.apply("com.example.android.library.hilt")
        extensions.configure<LibraryExtension> { testOptions.animationsDisabled = true }
        dependencies {
            "implementation"(project(":domain"))
            "implementation"(project(":core:ui"))
            "implementation"(project(":core:designsystem"))
            "implementation"(libs.findLibrary("androidx-lifecycle-runtime-compose").get())   // 2.11.0
            "implementation"(libs.findLibrary("androidx-navigation-compose").get())          // 2.10.2
            "implementation"(libs.findLibrary("androidx-hilt-navigation-compose").get())     // 1.4.0
            "testImplementation"(project(":core:testing"))
            "androidTestImplementation"(project(":core:testing"))
        }
    }
}
```

A feature module's build file is then two lines plus its own `api` dependency:

```kotlin
// feature/orders/impl/build.gradle.kts
plugins { id("com.example.android.feature.impl") }
android { namespace = "com.example.app.feature.orders.impl" }
dependencies {
    implementation(project(":feature:orders:api"))
    implementation(project(":feature:customers:api"))
}
```

Worth it when: three or more features navigate to each other, or teams own features and must not compile against each other's screens. Not worth it for a two-feature app; use the lambda approach from the "Feature modules" section.

## A core module taxonomy

The `:core:*` list earlier in this file is the minimum. The full taxonomy below is the one Now in Android settles on; adopt a module only when its responsibility exists in the product.

| Module | Holds | Depends on | Plugin |
|---|---|---|---|
| `:core:common` | `Result`, dispatcher qualifiers, `@ApplicationScope`, `Clock` provider | nothing | jvm library |
| `:core:model` | domain data classes only | nothing | jvm library |
| `:core:domain` | use cases combining repositories | `:core:data`, `:core:model` | jvm or android library |
| `:core:data` | repository interfaces and offline-first implementations, `Synchronizer` | `:core:database`, `:core:network`, `:core:datastore`, `:core:model`, `:core:common` | android library + hilt |
| `:core:database` | Room database, DAOs, entities | `:core:model` | android library + room + hilt |
| `:core:datastore-proto` | `.proto` files and generated lite classes | nothing | jvm library + protobuf |
| `:core:datastore` | `DataStore<UserPreferences>`, serializer, migrations, preferences data source | `:core:datastore-proto`, `:core:model` | android library + hilt |
| `:core:network` | Retrofit/Ktor API, DTOs, interceptors | `:core:model`, `:core:common` | android library + hilt |
| `:core:designsystem` | theme, typography, color schemes, component wrappers, icons; knows nothing about the app's data | nothing in the app | android library + compose |
| `:core:ui` | app-aware composables (a `NoteCard`), preview parameter providers, multipreview annotations | `:core:designsystem`, `:core:model` | android library + compose |
| `:core:navigation` | route/key base types shared by feature `api` modules | nothing | android library |
| `:core:analytics` | `AnalyticsHelper` interface, a no-op and a Firebase implementation | nothing | android library + hilt |
| `:core:notifications` | `Notifier` interface, channels, a no-op implementation | `:core:model` | android library + hilt |
| `:core:testing` | `MainDispatcherRule`, `Test*Repository` doubles, test data, `TestDispatcherModule`, custom test runner | `:core:data`, `:core:common`, `:core:model` | android library + hilt |
| `:core:data-test` | `@TestInstallIn` module replacing `:core:data` bindings with fakes | `:core:data` | android library + hilt |
| `:core:screenshot-testing` | Roborazzi helpers (`captureMultiDevice`) | `:core:designsystem` | android library + compose |

Two boundaries that pay for themselves immediately:

- `:core:designsystem` versus `:core:ui`. The design system must not import `:core:model`; the moment it does, a theme change recompiles the data layer's consumers and the catalog app (see [../capabilities/design-system-module/README.md](../capabilities/design-system-module/README.md)) drags the whole app in.
- `:core:datastore-proto` versus `:core:datastore`. Keeping generated protobuf classes in a JVM-only module keeps the protobuf plugin out of every Android module and makes the serializer unit-testable without Robolectric (see [../capabilities/datastore-proto/README.md](../capabilities/datastore-proto/README.md)).

The data layer binds its implementations in its own Hilt module (`DataModule` in `:core:data`), and `:core:data-test` replaces exactly that module in tests; see [testing/unit-testing.md](testing/unit-testing.md).

## Build logic the Now in Android way

The convention plugins earlier in this file are enough for a small project. At the scale of the taxonomy above they share more configuration than they differ by, and the shared parts belong in `internal fun Project.configureX()` helpers in a package inside `build-logic/convention`, with one thin `Plugin<Project>` per concern that calls the helpers. The complete layout:

```
build-logic/
  settings.gradle.kts
  gradle.properties                     org.gradle.configuration-cache=true, same JVM args as the root
  convention/
    build.gradle.kts                    kotlin-dsl, compileOnly on the plugins it configures, gradlePlugin { } registrations
    src/main/kotlin/
      RootPlugin.kt                     applied only to the root project
      AndroidApplicationConventionPlugin.kt
      AndroidApplicationComposeConventionPlugin.kt
      AndroidLibraryConventionPlugin.kt
      AndroidLibraryComposeConventionPlugin.kt
      AndroidLibraryHiltConventionPlugin.kt
      AndroidFeatureApiConventionPlugin.kt
      AndroidFeatureImplConventionPlugin.kt
      AndroidLintConventionPlugin.kt
      AndroidLibraryJacocoConventionPlugin.kt
      JvmLibraryConventionPlugin.kt
      com/example/app/buildlogic/
        ProjectExtensions.kt            val Project.libs
        KotlinAndroid.kt                configureKotlinAndroid, configureKotlinJvm
        AndroidCompose.kt               configureAndroidCompose
        Jacoco.kt                       configureJacoco
        Spotless.kt                     configureSpotless (see checklists/code-quality.md)
```

Root `settings.gradle.kts` includes the build before anything else and keeps repositories centralized:

```kotlin
// settings.gradle.kts (root)
pluginManagement {
    includeBuild("build-logic")
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
}
rootProject.name = "App"
enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")   // projects.core.ui instead of project(":core:ui")
include(":app")
include(":core:common", ":core:model", ":core:domain", ":core:data", ":core:database")
include(":core:datastore-proto", ":core:datastore", ":core:network")
include(":core:designsystem", ":core:ui", ":core:navigation", ":core:testing", ":core:data-test")
include(":feature:orders:api", ":feature:orders:impl")
include(":feature:customers:api", ":feature:customers:impl")
include(":lint")

check(JavaVersion.current().isCompatibleWith(JavaVersion.VERSION_17)) {
    "This build requires JDK 17 or newer; running on ${JavaVersion.current()}"
}
```

The content filters on `google()` keep Gradle from asking Google's repository for Maven Central artifacts (and vice versa), which measurably shortens dependency resolution.

```kotlin
// build-logic/settings.gradle.kts
pluginManagement {
    repositories { gradlePluginPortal(); google() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
    versionCatalogs { create("libs") { from(files("../gradle/libs.versions.toml")) } }
}
rootProject.name = "build-logic"
include(":convention")
```

Plugin ids are declared once in the catalog so the registrations and the consumers use the same alias:

```toml
# gradle/libs.versions.toml, [plugins] section
android-application = { id = "com.android.application", version.ref = "agp" }
android-library = { id = "com.android.library", version.ref = "agp" }
android-lint = { id = "com.android.lint", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
kotlin-compose = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
ksp = { id = "com.google.devtools.ksp", version = "<version>" }                 # KSP release page
hilt = { id = "com.google.dagger.hilt.android", version = "<version>" }         # Dagger release page

# Plugins defined by this project (no version: they come from the included build)
app-android-application = { id = "com.example.android.application" }
app-android-application-compose = { id = "com.example.android.application.compose" }
app-android-library = { id = "com.example.android.library" }
app-android-library-compose = { id = "com.example.android.library.compose" }
app-android-library-hilt = { id = "com.example.android.library.hilt" }
app-android-library-jacoco = { id = "com.example.android.library.jacoco" }
app-android-feature-api = { id = "com.example.android.feature.api" }
app-android-feature-impl = { id = "com.example.android.feature.impl" }
app-android-lint = { id = "com.example.android.lint" }
app-jvm-library = { id = "com.example.jvm.library" }
app-root = { id = "com.example.root" }
```

```kotlin
// build-logic/convention/build.gradle.kts
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    `kotlin-dsl`
    alias(libs.plugins.android.lint)      // lint the build logic itself
}

group = "com.example.app.buildlogic"

// The JDK that compiles build logic; unrelated to the app's minSdk or jvmTarget on device.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }

dependencies {
    compileOnly(libs.android.gradlePlugin)        // com.android.tools.build:gradle:9.4.0
    compileOnly(libs.android.tools.common)        // com.android.tools:common, same version line as AGP's tools
    compileOnly(libs.kotlin.gradlePlugin)         // 2.4.20
    compileOnly(libs.compose.gradlePlugin)        // org.jetbrains.kotlin:compose-compiler-gradle-plugin:2.4.20
    compileOnly(libs.ksp.gradlePlugin)            // <version> from the KSP release page
    compileOnly(libs.room.gradlePlugin)           // androidx.room:room-gradle-plugin:2.8.5
    lintChecks(libs.androidx.lint.gradle)         // androidx.lint:lint-gradle, flags deprecated Gradle API use
}

tasks.validatePlugins {
    enableStricterValidation = true
    failOnWarning = true
}

gradlePlugin {
    plugins {
        register("androidApplication") {
            id = libs.plugins.app.android.application.asProvider().get().pluginId
            implementationClass = "AndroidApplicationConventionPlugin"
        }
        register("androidApplicationCompose") {
            id = libs.plugins.app.android.application.compose.get().pluginId
            implementationClass = "AndroidApplicationComposeConventionPlugin"
        }
        register("androidLibrary") {
            id = libs.plugins.app.android.library.asProvider().get().pluginId
            implementationClass = "AndroidLibraryConventionPlugin"
        }
        register("androidLibraryCompose") {
            id = libs.plugins.app.android.library.compose.get().pluginId
            implementationClass = "AndroidLibraryComposeConventionPlugin"
        }
        register("androidLibraryHilt") {
            id = libs.plugins.app.android.library.hilt.get().pluginId
            implementationClass = "AndroidLibraryHiltConventionPlugin"
        }
        register("androidLibraryJacoco") {
            id = libs.plugins.app.android.library.jacoco.get().pluginId
            implementationClass = "AndroidLibraryJacocoConventionPlugin"
        }
        register("androidFeatureApi") {
            id = libs.plugins.app.android.feature.api.get().pluginId
            implementationClass = "AndroidFeatureApiConventionPlugin"
        }
        register("androidFeatureImpl") {
            id = libs.plugins.app.android.feature.impl.get().pluginId
            implementationClass = "AndroidFeatureImplConventionPlugin"
        }
        register("androidLint") {
            id = libs.plugins.app.android.lint.get().pluginId
            implementationClass = "AndroidLintConventionPlugin"
        }
        register("jvmLibrary") {
            id = libs.plugins.app.jvm.library.get().pluginId
            implementationClass = "JvmLibraryConventionPlugin"
        }
        register("root") {
            id = libs.plugins.app.root.get().pluginId
            implementationClass = "RootPlugin"
        }
    }
}
```

`asProvider()` is needed for an alias that is also a prefix of other aliases (`app-android-application` and `app-android-application-compose`).

The shared helper every Android plugin calls:

```kotlin
// build-logic/convention/src/main/kotlin/com/example/app/buildlogic/ProjectExtensions.kt
package com.example.app.buildlogic

import org.gradle.api.Project
import org.gradle.api.artifacts.VersionCatalog
import org.gradle.api.artifacts.VersionCatalogsExtension
import org.gradle.kotlin.dsl.getByType

val Project.libs: VersionCatalog
    get() = extensions.getByType<VersionCatalogsExtension>().named("libs")
```

```kotlin
// build-logic/convention/src/main/kotlin/com/example/app/buildlogic/KotlinAndroid.kt
package com.example.app.buildlogic

import com.android.build.api.dsl.CommonExtension
import org.gradle.api.JavaVersion
import org.gradle.api.Project
import org.gradle.api.plugins.JavaPluginExtension
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.dependencies
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension

/** Android-side settings every application and library module shares. */
internal fun Project.configureKotlinAndroid(extension: CommonExtension) {
    extension.apply {
        compileSdk = 37
        defaultConfig.minSdk = 26        // notification channels and adaptive icons without compat branches
        compileOptions {
            sourceCompatibility = JavaVersion.VERSION_17
            targetCompatibility = JavaVersion.VERSION_17
            // Lets minSdk 26 code use java.time and other newer JDK APIs.
            isCoreLibraryDesugaringEnabled = true
        }
    }
    configure<KotlinAndroidProjectExtension> { compilerOptions { configureKotlinCompiler(this@configureKotlinAndroid) } }
    dependencies {
        "coreLibraryDesugaring"(libs.findLibrary("android-desugar-jdk-libs").get())   // <version>, desugar_jdk_libs release page
    }
}

/** JVM-only modules (:core:model, :domain) share the same compiler settings without AGP. */
internal fun Project.configureKotlinJvm() {
    configure<JavaPluginExtension> {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    configure<KotlinJvmProjectExtension> { compilerOptions { configureKotlinCompiler(this@configureKotlinJvm) } }
}

private fun org.jetbrains.kotlin.gradle.dsl.KotlinJvmCompilerOptions.configureKotlinCompiler(project: Project) {
    jvmTarget.set(JvmTarget.JVM_17)
    // Opt in per module with -PwarningsAsErrors=true (CI does); default off so a new Kotlin release does not block local work.
    allWarningsAsErrors.set(project.providers.gradleProperty("warningsAsErrors").map(String::toBoolean).orElse(false))
}
```

```kotlin
// build-logic/convention/src/main/kotlin/com/example/app/buildlogic/AndroidCompose.kt
package com.example.app.buildlogic

import com.android.build.api.dsl.CommonExtension
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.dependencies
import org.jetbrains.kotlin.compose.compiler.gradle.ComposeCompilerGradlePluginExtension

/** Compose settings shared by application and library modules; the caller applies the Compose plugin. */
internal fun Project.configureAndroidCompose(extension: CommonExtension) {
    extension.buildFeatures.compose = true
    dependencies {
        val bom = libs.findLibrary("androidx-compose-bom").get()          // 2026.09.00
        "implementation"(platform(bom))
        "androidTestImplementation"(platform(bom))
        "implementation"(libs.findLibrary("androidx-compose-ui-tooling-preview").get())
        "debugImplementation"(libs.findLibrary("androidx-compose-ui-tooling").get())
    }
    configure<ComposeCompilerGradlePluginExtension> {
        // One stability file for the whole build; see docs/compose/performance.md.
        stabilityConfigurationFiles.add(isolated.rootProject.projectDirectory.file("compose_compiler_config.conf"))
        // Reports only when asked for, so the normal build stays fast.
        val reportDir = isolated.rootProject.projectDirectory.dir("build/compose-reports").dir(path.replace(':', '_'))
        if (providers.gradleProperty("enableComposeCompilerReports").map(String::toBoolean).getOrElse(false)) {
            reportsDestination.set(reportDir)
            metricsDestination.set(reportDir)
        }
    }
}
```

The two plugins the task above combined. First, application plus Compose:

```kotlin
// build-logic/convention/src/main/kotlin/AndroidApplicationConventionPlugin.kt
import com.android.build.api.dsl.ApplicationExtension
import com.example.app.buildlogic.configureKotlinAndroid
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure

class AndroidApplicationConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("com.android.application")
        pluginManager.apply("org.jetbrains.kotlin.android")
        pluginManager.apply("com.example.android.lint")
        extensions.configure<ApplicationExtension> {
            configureKotlinAndroid(this)
            defaultConfig.targetSdk = 36          // Play policy row in data/versions.json
            testOptions.animationsDisabled = true
        }
    }
}
```

```kotlin
// build-logic/convention/src/main/kotlin/AndroidApplicationComposeConventionPlugin.kt
import com.android.build.api.dsl.ApplicationExtension
import com.example.app.buildlogic.configureAndroidCompose
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.getByType

/** Apply to :app and to a component catalog app. Expects com.example.android.application to be applied too. */
class AndroidApplicationComposeConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("com.android.application")
        pluginManager.apply("org.jetbrains.kotlin.plugin.compose")
        configureAndroidCompose(extensions.getByType<ApplicationExtension>())
    }
}
```

Second, library plus Hilt (the Hilt plugin is written so it also works on a JVM module, which is what makes `:core:testing`-style modules possible):

```kotlin
// build-logic/convention/src/main/kotlin/AndroidLibraryConventionPlugin.kt
import com.android.build.api.dsl.LibraryExtension
import com.example.app.buildlogic.configureKotlinAndroid
import com.example.app.buildlogic.libs
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.dependencies

class AndroidLibraryConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("com.android.library")
        pluginManager.apply("org.jetbrains.kotlin.android")
        pluginManager.apply("com.example.android.lint")
        extensions.configure<LibraryExtension> {
            configureKotlinAndroid(this)
            testOptions.targetSdk = 36
            lint.targetSdk = 36
            defaultConfig.testInstrumentationRunner = "com.example.app.core.testing.AppTestRunner"
            testOptions.animationsDisabled = true
            testOptions.unitTests.isIncludeAndroidResources = true
            // ":core:designsystem" -> "core_designsystem_"; resource names cannot collide across modules.
            resourcePrefix = path.split(Regex("\\W")).drop(1).joinToString("_").lowercase() + "_"
        }
        dependencies {
            "testImplementation"(libs.findLibrary("junit").get())
            "testImplementation"(libs.findLibrary("kotlinx-coroutines-test").get())
        }
    }
}
```

```kotlin
// build-logic/convention/src/main/kotlin/AndroidLibraryHiltConventionPlugin.kt
import com.example.app.buildlogic.libs
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.dependencies

/**
 * Hilt for any module: KSP plus the compiler always; the Android Gradle plugin and hilt-android only
 * when AGP is present, hilt-core when the module is JVM-only.
 */
class AndroidLibraryHiltConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("com.google.devtools.ksp")
        dependencies { "ksp"(libs.findLibrary("hilt-compiler").get()) }

        pluginManager.withPlugin("org.jetbrains.kotlin.jvm") {
            dependencies { "implementation"(libs.findLibrary("hilt-core").get()) }
        }
        pluginManager.withPlugin("com.android.base") {
            pluginManager.apply("dagger.hilt.android.plugin")
            dependencies { "implementation"(libs.findLibrary("hilt-android").get()) }
        }
    }
}
```

`pluginManager.withPlugin` runs the block immediately if the plugin is already applied and later if it is applied afterwards, so plugin order in a module's `plugins { }` block does not matter.

The lint convention normalizes report formats so CI can upload SARIF for every module:

```kotlin
// build-logic/convention/src/main/kotlin/AndroidLintConventionPlugin.kt
import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.dsl.LibraryExtension
import com.android.build.api.dsl.Lint
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure

class AndroidLintConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        when {
            pluginManager.hasPlugin("com.android.application") -> configure<ApplicationExtension> { lint(Lint::configure) }
            pluginManager.hasPlugin("com.android.library") -> configure<LibraryExtension> { lint(Lint::configure) }
            else -> {                       // JVM module such as :lint or :core:model
                pluginManager.apply("com.android.lint")
                configure<Lint>(Lint::configure)
            }
        }
    }
}

private fun Lint.configure() {
    xmlReport = true
    sarifReport = true
    checkDependencies = true            // the app's lint run also inspects library modules
    disable += "GradleDependency"       // version bumps are a dependency-update job, not a lint error
}
```

The Jacoco convention registers one combined report per variant from unit-test `.exec` and instrumented `.ec` files, excluding generated classes:

```kotlin
// build-logic/convention/src/main/kotlin/com/example/app/buildlogic/Jacoco.kt
package com.example.app.buildlogic

import com.android.build.api.artifact.ScopedArtifact
import com.android.build.api.dsl.CommonExtension
import com.android.build.api.variant.AndroidComponentsExtension
import com.android.build.api.variant.ScopedArtifacts
import org.gradle.api.Project
import org.gradle.api.file.Directory
import org.gradle.api.file.RegularFile
import org.gradle.api.tasks.testing.Test
import org.gradle.kotlin.dsl.configure
import org.gradle.kotlin.dsl.register
import org.gradle.kotlin.dsl.withType
import org.gradle.testing.jacoco.plugins.JacocoPluginExtension
import org.gradle.testing.jacoco.plugins.JacocoTaskExtension
import org.gradle.testing.jacoco.tasks.JacocoReport

private val coverageExclusions = listOf(
    "**/R.class", "**/R\$*.class", "**/BuildConfig.*", "**/Manifest*.*",
    "**/*_Hilt*.class", "**/Hilt_*.class", "**/*_Factory.class", "**/*Module_*.class",
)

internal fun Project.configureJacoco(
    commonExtension: CommonExtension,
    androidComponents: AndroidComponentsExtension<*, *, *>,
) {
    // Only debug: enabling coverage on release forces debuggable instrumentation into the shipped build.
    commonExtension.buildTypes.named("debug") {
        enableUnitTestCoverage = true
        enableAndroidTestCoverage = true
    }
    configure<JacocoPluginExtension> { toolVersion = libs.findVersion("jacoco").get().toString() }   // <version>

    androidComponents.onVariants { variant ->
        val jars = objects.listProperty(RegularFile::class.java)
        val dirs = objects.listProperty(Directory::class.java)
        val report = tasks.register<JacocoReport>("create${variant.name.replaceFirstChar(Char::uppercase)}CombinedCoverageReport") {
            classDirectories.setFrom(jars, dirs.map { list -> list.map { fileTree(it).exclude(coverageExclusions) } })
            sourceDirectories.setFrom(files(variant.sources.kotlin?.all, variant.sources.java?.all))
            executionData.setFrom(
                fileTree(layout.buildDirectory.dir("outputs/unit_test_code_coverage/${variant.name}UnitTest")) { include("**/*.exec") },
                fileTree(layout.buildDirectory.dir("outputs/code_coverage/${variant.name}AndroidTest")) { include("**/*.ec") },
            )
            reports { xml.required.set(true); html.required.set(true) }
        }
        variant.artifacts.forScope(ScopedArtifacts.Scope.PROJECT).use(report)
            .toGet(ScopedArtifact.CLASSES, { jars }, { dirs })
    }

    tasks.withType<Test>().configureEach {
        configure<JacocoTaskExtension> {
            isIncludeNoLocationClasses = true     // needed for Robolectric tests
            excludes = listOf("jdk.internal.*")
        }
    }
}
```

```kotlin
// build-logic/convention/src/main/kotlin/AndroidLibraryJacocoConventionPlugin.kt
import com.android.build.api.dsl.LibraryExtension
import com.android.build.api.variant.LibraryAndroidComponentsExtension
import com.example.app.buildlogic.configureJacoco
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.apply
import org.gradle.kotlin.dsl.getByType
import org.gradle.testing.jacoco.plugins.JacocoPlugin

class AndroidLibraryJacocoConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        apply<JacocoPlugin>()
        configureJacoco(extensions.getByType<LibraryExtension>(), extensions.getByType<LibraryAndroidComponentsExtension>())
    }
}
```

Finally the root plugin, applied only to `:` from the root `build.gradle.kts`, hosts whole-build concerns (the root Spotless configuration from [../checklists/code-quality.md](../checklists/code-quality.md), a `printModuleGraph` task, a JDK check):

```kotlin
// build-logic/convention/src/main/kotlin/RootPlugin.kt
import com.example.app.buildlogic.configureSpotlessForRoot
import org.gradle.api.Plugin
import org.gradle.api.Project

class RootPlugin : Plugin<Project> {
    override fun apply(target: Project) {
        require(target.path == ":") { "com.example.root is for the root project only" }
        target.configureSpotlessForRoot()
    }
}
```

```kotlin
// build.gradle.kts (root): list every plugin once, apply none, so all modules share one plugin classpath.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.android.lint) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.app.root)
}
```

Listing a plugin with `apply false` in the root puts it on the classpath for every subproject at the same version; a subproject that applies a plugin not listed here gets it appended to its own classpath, which is how version mismatches between transitive plugin dependencies arise.

`gradle.properties` settings that make this build logic pay off (each is the default in a Now in Android checkout):

```properties
org.gradle.caching=true
org.gradle.parallel=true
org.gradle.configuration-cache=true
org.gradle.configuration-cache.problems=fail    # a plugin that breaks the cache fails the build instead of silently disabling it
org.gradle.isolated-projects=true               # only once every plugin passes; the RootPlugin above is written to tolerate it
ksp.project.isolation.enabled=true
android.defaults.buildfeatures.resvalues=false  # most modules do not use resValue; turn it on per module
```

Verify the build logic on its own before touching modules:

```sh
./gradlew :build-logic:convention:check          # validatePlugins + lint on the plugins
./gradlew :build-logic:convention:validatePlugins
./gradlew help --configuration-cache             # must report "Configuration cache entry stored"
```

## Version catalog entries

```toml
# gradle/libs.versions.toml (versions from data/versions.json, verified 2026-09-29)
[versions]
agp = "9.4.0"
kotlin = "2.4.20"
composeBom = "2026.09.00"
navigation = "2.10.2"
lifecycle = "2.11.0"
room = "2.8.5"
androidxHilt = "1.4.0"

[libraries]
android-gradlePlugin = { module = "com.android.tools.build:gradle", version.ref = "agp" }
kotlin-gradlePlugin = { module = "org.jetbrains.kotlin:kotlin-gradle-plugin", version.ref = "kotlin" }
compose-gradlePlugin = { module = "org.jetbrains.kotlin:compose-compiler-gradle-plugin", version.ref = "kotlin" }
androidx-compose-bom = { module = "androidx.compose:compose-bom", version.ref = "composeBom" }
androidx-compose-material3 = { module = "androidx.compose.material3:material3" }
androidx-compose-ui-tooling = { module = "androidx.compose.ui:ui-tooling" }
androidx-compose-ui-tooling-preview = { module = "androidx.compose.ui:ui-tooling-preview" }
androidx-navigation-compose = { module = "androidx.navigation:navigation-compose", version.ref = "navigation" }
androidx-lifecycle-runtime-compose = { module = "androidx.lifecycle:lifecycle-runtime-compose", version.ref = "lifecycle" }
androidx-hilt-navigation-compose = { module = "androidx.hilt:hilt-navigation-compose", version.ref = "androidxHilt" }
androidx-room-runtime = { module = "androidx.room:room-runtime", version.ref = "room" }
androidx-room-ktx = { module = "androidx.room:room-ktx", version.ref = "room" }
androidx-room-compiler = { module = "androidx.room:room-compiler", version.ref = "room" }
```

Hilt, KSP, Retrofit, OkHttp and kotlinx.serialization are not in `data/versions.json`; resolve them from their release pages when generating a catalog and never invent a number.

## When not to over-modularize

Modules cost build configuration, a slower configuration phase, and friction every time a type needs to move. Split only when a boundary pays for itself.

| Project | Recommended split |
|---|---|
| One developer, under ~30 screens | Single `:app` module with packages `ui/`, `data/`, `domain/`. Keep the dependency rule by package and by review. |
| Small team, shared UI kit, slow builds | `:app`, `:core:ui`, `:core:common`, `:data`, `:domain`. Features stay in `:app` packages. |
| Several teams or many features, CI build time matters | The full layout above, with one `:feature:*` and `:data:*` per bounded context. |

Signs you went too far: a `:core:util` module with three files, modules whose only consumer is one other module, a `:domain` with one interface per module, or a release that touches eight `build.gradle.kts` files to add a dependency.

Signs you should split: a change to the network client recompiles every screen; two teams keep conflicting in the same package; a feature cannot be unit tested without the whole app's Hilt graph.

## Avoid

```kotlin
// Anti-pattern: feature depends on data implementation. Breaks substitutability and recompiles the feature on every DAO change.
// feature/todo/build.gradle.kts
implementation(project(":data:todo"))

// Anti-pattern: domain model annotated for Room or JSON. Now the domain carries two frameworks.
@Entity data class TodoItem(@PrimaryKey val id: String, @SerialName("done") val isCompleted: Boolean)

// Anti-pattern: use case that forwards one call.
class GetTodosUseCase @Inject constructor(private val repo: TodoRepository) {
    operator fun invoke() = repo.observeAll()
}

// Anti-pattern: `api(...)` dependencies leaking transitive types across module boundaries.
api(project(":core:database"))
```

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :domain:test                 # pure JVM, should run in seconds
./gradlew :feature:todo:testDebugUnitTest
./gradlew :app:dependencies --configuration debugRuntimeClasspath | grep "project :" # confirm no feature -> data edges
```

## Sources

- https://developer.android.com/topic/architecture
- https://developer.android.com/topic/architecture/domain-layer
- https://developer.android.com/topic/architecture/data-layer
- https://developer.android.com/topic/modularization
- https://developer.android.com/topic/modularization/patterns
- https://developer.android.com/build/migrate-to-catalogs
- https://docs.gradle.org/current/userguide/sharing_build_logic_between_subprojects.html
- https://docs.gradle.org/current/userguide/configuration_cache.html
- https://docs.gradle.org/current/userguide/isolated_projects.html
- https://developer.android.com/build/releases/agp-9-4-0-release-notes
- https://developer.android.com/build/extend-agp
- https://developer.android.com/build/jdks
- [../references/nowinandroid.md](../references/nowinandroid.md) for the sample these module and build-logic conventions were studied from
