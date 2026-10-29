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
- https://developer.android.com/build/releases/agp-9-4-0-release-notes
