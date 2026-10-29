# Versions and compatibility

Which numbers to write in a build file, where they come from, and which platform behavior changes will break an app that raises `targetSdk` without reading about them.

## Where versions come from

`data/versions.json` in this repository is the only place version numbers are stored. It carries `verifiedAt` and `reviewAfter` dates and a source URL per entry. Read it before writing a version; never type a version from memory.

```sh
jq '.toolchain, .libraries, .policy' data/versions.json
android-agent gradle versions --project /absolute/path   # with the CLI: compares a project against the catalog
```

The `unresolved` array lists components whose version was deliberately not recorded (Play services, Maps, ML Kit, Play Integrity, Dagger Hilt, screenshot testing, emulator, bundletool). For those, open the `source` URL, read the current release, and cite it in the report. In generated build files write `<version>` with a comment naming the release page if you cannot look it up.

Current baseline (verified 2026-09-29):

| Component | Version | Note |
|---|---|---|
| Android | 17, API 37 | `compileSdk 37` |
| Play target policy | 36 | phone, tablet, foldable; Wear and Automotive 35, TV and XR 34 |
| AGP | 9.4.0 | documents Gradle 9.6.0, JDK 17 |
| Gradle | 9.6.0 with AGP; 9.8.0 latest standalone | do not upgrade the wrapper past what AGP documents without testing |
| Kotlin | 2.4.20 | Compose compiler is `org.jetbrains.kotlin.plugin.compose` at the same version |
| Compose BOM | 2026.09.00 | Compose 1.12.1, Material3 1.4.0 |
| Navigation | 2.10.2 | Navigation3 1.2.0 |
| Lifecycle | 2.11.0 | |
| Room | 2.8.5 | Room3 3.0.3 |
| WorkManager | 2.12.0 | |
| DataStore | 1.2.1 | |
| CameraX | 1.6.2 | |
| Media3 | 1.11.1 | |
| Credentials | 1.6.0 | |
| Paging | 3.5.1 | |
| AndroidX Hilt | 1.4.0 | `hilt-navigation-compose`, `hilt-work`; distinct from Dagger Hilt |
| Benchmark | 1.5.0 | |
| Window | 1.5.1 | `WindowSizeClass` |
| Car App | 1.7.0 | |
| Firebase BoM | 34.18.0 | |
| Play Billing | 9.0.0 | |

## compileSdk, targetSdk, minSdk

```kotlin
android {
    compileSdk = 37
    defaultConfig {
        minSdk = 26
        targetSdk = 36
    }
}
```

`compileSdk` is the API surface the compiler sees. Set it to the newest stable so you can call new APIs (guarded by `Build.VERSION.SDK_INT` checks or `@RequiresApi`) and get the newest lint rules. It has no runtime effect. Raising it is safe apart from new deprecation warnings and lint findings.

`targetSdk` tells the platform which behavior the app was tested against. On a device running a newer OS than `targetSdk`, the system applies compatibility behavior for changes introduced after that level. Raising `targetSdk` opts in to every behavior change up to that level at once. Google Play requires `targetSdk` 36 for new apps and updates on phone and tablet (policy effective 2026-08-31). Raise it one level at a time and test on a device running that level.

`minSdk` is the oldest device the app installs on. It is a product decision: reach versus engineering cost. The AndroidX default is 24. The template in this repository uses 26 because notification channels (`NotificationChannel`) and adaptive icons exist from API 26, which removes two compatibility branches from almost every app. Do not change an existing project's `minSdk` without saying so; lowering it can break library resolution, raising it drops users.

`compileSdk >= targetSdk >= minSdk` always. Lint errors otherwise.

## Toolchain compatibility

AGP, Gradle, JDK and Kotlin move together.

- AGP 9.4.0 requires Gradle 9.6.0 or newer and JDK 17 to run Gradle. Check the AGP release notes table before changing either.
- The Gradle wrapper (`gradle/wrapper/gradle-wrapper.properties`) pins Gradle per project. Change it with `./gradlew wrapper --gradle-version 9.6.0`, which also updates the wrapper scripts; never edit only the properties file.
- Kotlin 2.4.20: the Kotlin Gradle plugin and the Compose compiler plugin must be the same version. Set one `kotlin` version in the catalog and reference it from both plugin aliases.
- KSP: its version string is `<kotlin version>-<ksp release>`, for example `2.4.20-1.0.x`; it must match the Kotlin version exactly. Resolve it from the KSP release page; not in `data/versions.json`. KSP 2 is the default implementation with Kotlin 2.x.
- Dagger Hilt: a Gradle plugin `com.google.dagger.hilt.android` plus `hilt-android` runtime and `hilt-android-compiler` (via `ksp`). Resolve the version from the Hilt release page. AndroidX Hilt 1.4.0 provides `hilt-navigation-compose` and `hilt-work` and is versioned separately.
- JDK: `compileOptions` and `kotlin { jvmToolchain(17) }` should agree. Java 17 source level is a safe default across the AndroidX baseline; higher levels need desugaring awareness for `minSdk < 26` and are not needed for this template.
- `android.useAndroidX=true` is required; the Jetifier flag is gone.
- Gradle configuration cache and parallel builds are on by default with Gradle 9; builds that break under the configuration cache usually have a plugin reading project state at execution time.

Check a project's actual state rather than assuming:

```sh
./gradlew --version
grep distributionUrl gradle/wrapper/gradle-wrapper.properties
grep -E "^(agp|kotlin|ksp|hilt)\s*=" gradle/libs.versions.toml
```

## Compose BOM

The BOM pins every `androidx.compose.*` artifact to a tested set. Declare it once and omit versions on Compose artifacts:

```kotlin
dependencies {
    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    androidTestImplementation(composeBom)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
}
```

Material3 1.4.0 ships in BOM 2026.09.00. If you need a newer Material3 than the BOM has, override that one artifact with an explicit version; do not drop the BOM. Material3 Expressive APIs are annotated individually (`@ExperimentalMaterial3ExpressiveApi`); a stable Material3 release does not mean every Expressive component is stable.

Libraries outside the BOM that must agree with it: `androidx.activity:activity-compose`, `androidx.lifecycle:lifecycle-*-compose` (2.11.0), `androidx.navigation:navigation-compose` (2.10.2), `androidx.hilt:hilt-navigation-compose` (1.4.0).

## Behavior changes that bite

Each applies when `targetSdk` reaches that level, unless marked "all apps".

### API 33 (Android 13)

- `POST_NOTIFICATIONS` is a runtime permission. Without it notifications are silently dropped. Request it in context, after the user has seen why notifications matter.
- Granular media permissions: `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO` replace `READ_EXTERNAL_STORAGE`. Prefer the photo picker, which needs none of them.
- Per-app language preferences; use `AppCompatDelegate.setApplicationLocales` and declare `android:localeConfig`.
- Intent filters on exported components must match the intent's action for the component to receive it.

### API 34 (Android 14)

- Foreground services must declare `android:foregroundServiceType` in the manifest and the matching `FOREGROUND_SERVICE_<TYPE>` permission; starting a service with the wrong type throws. Types include `camera`, `location`, `mediaPlayback`, `dataSync`, `health`, `remoteMessaging`, `shortService`, `specialUse`.
- Runtime-registered broadcast receivers must specify `RECEIVER_EXPORTED` or `RECEIVER_NOT_EXPORTED`.
- Implicit intents cannot target internal (non-exported) components.
- `SCHEDULE_EXACT_ALARM` is denied by default for new installs; use `USE_EXACT_ALARM` only for alarm-clock apps, otherwise `setAndAllowWhileIdle` or WorkManager.
- `READ_MEDIA_VISUAL_USER_SELECTED` adds a partial-access photo mode.
- Background activity launches from `PendingIntent` are restricted; pass `ActivityOptions` with `setPendingIntentBackgroundActivityStartMode` where needed.

### API 35 (Android 15)

- Edge-to-edge is enforced: apps draw behind the status and navigation bars whether they call `enableEdgeToEdge()` or not. Handle insets, see `docs/android/edge-to-edge-and-insets.md`.
- 16 KB memory pages: apps with native libraries (`.so`, including those from dependencies) must be built page-aligned. Pure Kotlin apps are unaffected; apps bundling native code must rebuild with NDK r28 or later and check every third-party `.so`. Google Play requires 16 KB support for apps targeting 35 and above.
- Foreground service timeouts for `dataSync` and `mediaProcessing` types (six hours per day).
- `BOOT_COMPLETED` receivers cannot launch certain foreground service types.
- Restrictions on `TextView` elegant text height and font padding defaults change text layout slightly; verify screenshots.
- Private space: a second user profile; apps using `PackageManager` to enumerate other apps see less.

### API 36 (Android 16)

- Predictive back is enabled by default for apps targeting 36; `onBackPressed` and `KEYCODE_BACK` interception no longer run. Use `OnBackPressedCallback` or Compose `BackHandler` / `PredictiveBackHandler`.
- Orientation, resizability and aspect-ratio restrictions (`screenOrientation`, `resizeableActivity`, `minAspectRatio`) are ignored on large screens (600dp or wider). Layouts must adapt; see `patterns/ui/adaptive-layouts.md`.
- Edge-to-edge opt-out (`windowOptOutEdgeToEdgeEnforcement`) is removed.
- Adaptive refresh rate and health-connect changes; check the release page for the ones that apply to your capabilities.

### API 37 (Android 17)

Compile against it. Only raise `targetSdk` to 37 after reading the behavior changes list at https://developer.android.com/about/versions/17 and testing on an Android 17 emulator. This repository does not restate the list because its contents were not verified at `verifiedAt`.

## Compatibility checks in code

```kotlin
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    // API 33+ path
}
```

Lint's `NewApi` check enforces that calls above `minSdk` are guarded. Prefer AndroidX wrappers (`ContextCompat`, `NotificationManagerCompat`, `WindowCompat`) over hand-written branches; they already encode the guards. `@ChecksSdkIntAtLeast` on your own helpers lets lint understand them.

## Verify

```sh
jq '.verifiedAt, .reviewAfter' data/versions.json           # is the catalog still within its review window
./gradlew :app:lintDebug                                     # NewApi, ExpiredTargetSdkVersion, GradleDependency
./gradlew :app:dependencies --configuration debugRuntimeClasspath | grep compose   # all Compose artifacts at one BOM
```

Run the app on an emulator image at the `targetSdk` level and one at `minSdk`, and say which images were used.

## Sources

- https://developer.android.com/about/versions
- https://developer.android.com/about/versions/17
- https://developer.android.com/google/play/requirements/target-sdk
- https://developer.android.com/build/releases/gradle-plugin
- https://developer.android.com/build/releases/agp-9-4-0-release-notes
- https://developer.android.com/develop/ui/compose/bom
- https://developer.android.com/jetpack/androidx/versions
- https://kotlinlang.org/docs/releases.html
- https://developer.android.com/guide/practices/page-sizes
- https://developer.android.com/develop/ui/compose/compiler
