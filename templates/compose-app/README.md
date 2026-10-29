# compose-app template

A minimal single-module Android app: Kotlin, Jetpack Compose, Material 3, Hilt, Navigation Compose with type-safe routes, one screen with loading, empty, content and error states, a unit test with Turbine, and a Compose UI test.

## Layout

```
settings.gradle.kts            plugin and dependency repositories, version catalog
build.gradle.kts               root plugin declarations (apply false)
gradle.properties              AndroidX, JVM args, non-transitive R
gradle/libs.versions.toml      every version in one place
app/build.gradle.kts           compileSdk 37, targetSdk 36, minSdk 26, Compose, KSP, Hilt
app/proguard-rules.pro
app/src/main/AndroidManifest.xml
app/src/main/kotlin/com/example/app/
    App.kt                     @HiltAndroidApp
    MainActivity.kt            enableEdgeToEdge, splash, setContent
    ui/theme/                  Theme.kt, Color.kt, Type.kt
    ui/home/                   HomeScreen.kt, HomeViewModel.kt, HomeUiState.kt
    data/ItemRepository.kt     interface + in-memory implementation
    di/AppModule.kt            Hilt bindings and dispatcher qualifiers
    navigation/AppNavigation.kt  @Serializable routes, NavHost
app/src/main/res/              strings, themes (window + splash), launcher icon, backup rules
app/src/test/                  HomeViewModelTest (Turbine + MainDispatcherRule)
app/src/androidTest/           HomeScreenTest (createComposeRule), HiltTestRunner
```

## Before the first build

1. The Gradle wrapper jar is not included. From the project root run one of:

   ```sh
   gradle wrapper --gradle-version 9.6.0
   ```

   or copy `gradle/wrapper/` (both `gradle-wrapper.jar` and `gradle-wrapper.properties`) plus `gradlew` and `gradlew.bat` from an existing project on Gradle 9.6.0. AGP 9.4.0 documents Gradle 9.6.0; see `data/versions.json`.

2. Resolve every `<version>` in `gradle/libs.versions.toml`. Each has a comment with its release page. KSP must match Kotlin 2.4.20 exactly (`2.4.20-1.0.x`).

3. Rename the package. Replace `com.example.app` in `app/build.gradle.kts` (`namespace`, `applicationId`), the Kotlin package declarations and imports, `proguard-rules.pro`, and `testInstrumentationRunner`. Move the source directories to match:

   ```sh
   find . -type f \( -name "*.kt" -o -name "*.kts" -o -name "*.pro" -o -name "*.xml" \) -exec sed -i 's/com\.example\.app/com.yourcompany.yourapp/g' {} +
   ```

4. Set `rootProject.name` in `settings.gradle.kts` and `app_name` in `res/values/strings.xml`.

5. Build:

   ```sh
   ./gradlew :app:assembleDebug
   ./gradlew :app:lintDebug
   ./gradlew :app:testDebugUnitTest
   ./gradlew :app:connectedDebugAndroidTest   # needs a device or emulator
   ```

## What is deliberately not here

- No network, database or DataStore. Aliases for Room, DataStore and WorkManager are in the catalog; add the dependencies when a feature needs them and keep `InMemoryItemRepository` as the test fake.
- No release signing. Add a `signingConfigs` block or sign in CI.
- No baseline profile module. Add `:baselineprofile` once the app has real screens to profile.
- No permissions. Add them with the feature, following `docs/android/permissions.md`.

## Extending

- New screen: add `ui/<feature>/` with `UiState`, `ViewModel`, `Screen`; add a `@Serializable` route in `navigation/AppNavigation.kt`; add a `composable<Route>` entry.
- New data source: implement `ItemRepository` (or a new interface), bind it in `di/AppModule.kt` with `@Binds`, and write a fake beside it.
- Tests: copy the structure of `HomeViewModelTest` for every ViewModel and `HomeScreenTest` for every screen.
