# Splash screen

The system splash screen with `androidx.core:core-splashscreen`: a themed icon and background on API 31+ and a backported equivalent down to API 23, `installSplashScreen()` before `super.onCreate`, `setKeepOnScreenCondition` tied to a root ViewModel's readiness, an optional exit animation, and verification that the splash does not linger or double-render.

## When to use

- Every app. Android 12+ shows a splash for every cold start whether you configure it or not; configuring it makes the icon and background yours instead of the default window background with a launcher icon.
- Hold the splash only while loading state that decides the first screen (theme, onboarding flag, session). Never hold it for network calls or ads; Play Console flags slow startup.
- A custom branded animation after the system splash is a design choice; the recipe shows how to hand off without a flash.

## Dependencies

The `core-splashscreen` version is not in `data/versions.json`; resolve from the release page.

```toml
[versions]
core-splashscreen = "<version>"   # https://developer.android.com/jetpack/androidx/releases/core

[libraries]
androidx-core-splashscreen = { group = "androidx.core", name = "core-splashscreen", version.ref = "core-splashscreen" }
```

```kotlin
dependencies {
    implementation(libs.androidx.core.splashscreen)
}
```

## Manifest and permissions

The Activity theme must be a `Theme.SplashScreen` descendant, and `postSplashScreenTheme` must point at the real app theme:

```xml
<activity
    android:name=".MainActivity"
    android:exported="true"
    android:theme="@style/Theme.App.Starting">
```

`res/values/themes.xml`:

```xml
<resources>
    <style name="Theme.App.Starting" parent="Theme.SplashScreen">
        <item name="windowSplashScreenBackground">@color/splash_background</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/ic_splash_icon</item>
        <item name="windowSplashScreenAnimationDuration">500</item>
        <item name="postSplashScreenTheme">@style/Theme.App</item>
    </style>

    <!-- The app's real theme; Compose sets colors, but the window background matters between splash and first frame -->
    <style name="Theme.App" parent="android:Theme.Material.Light.NoActionBar">
        <item name="android:windowBackground">@color/window_background</item>
    </style>
</resources>
```

`res/values-night/themes.xml` overrides both colors for dark mode. On API 31+ the icon is drawn inside a circle of 240 dp with the icon at 160 dp; a vector of 108 dp with content in the inner 66 dp (the same safe zone as the adaptive icon foreground) looks right. An `AnimatedVectorDrawable` works for `windowSplashScreenAnimatedIcon` on 31+; older versions show its first frame.

## Implementation

### Activity

```kotlin
package com.example.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.animation.doOnEnd
import android.animation.ObjectAnimator
import android.view.View
import android.view.animation.AnticipateInterpolator
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    private val rootViewModel: RootViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        val splash = installSplashScreen()      // must precede super.onCreate
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        splash.setKeepOnScreenCondition { rootViewModel.startState.value is StartState.Loading }

        // Optional: slide the splash icon up instead of a hard cut (API 31+ only; no-op below).
        splash.setOnExitAnimationListener { provider ->
            ObjectAnimator.ofFloat(provider.view, View.TRANSLATION_Y, 0f, -provider.view.height.toFloat()).apply {
                interpolator = AnticipateInterpolator()
                duration = 250
                doOnEnd { provider.remove() }
                start()
            }
        }

        setContent { AppRoot(rootViewModel) }
    }
}
```

### Root ViewModel

```kotlin
package com.example.app

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.app.data.settings.SettingsRepository
import com.example.app.data.settings.ThemeMode
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

sealed interface StartState {
    data object Loading : StartState
    data class Ready(val themeMode: ThemeMode, val hasOnboarded: Boolean) : StartState
}

@HiltViewModel
class RootViewModel @Inject constructor(settings: SettingsRepository) : ViewModel() {
    val startState: StateFlow<StartState> = settings.settings
        .map { StartState.Ready(it.themeMode, it.onboardingComplete) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, StartState.Loading)
}
```

`SharingStarted.Eagerly` starts reading DataStore the moment the ViewModel exists, which is during `installSplashScreen()`; the first emission usually arrives within a few milliseconds and the splash releases on the next frame.

### Root composable

```kotlin
@Composable
fun AppRoot(viewModel: RootViewModel) {
    val start by viewModel.startState.collectAsStateWithLifecycle()
    when (val s = start) {
        StartState.Loading -> Unit      // splash is still covering the window; draw nothing
        is StartState.Ready -> AppTheme(darkTheme = s.themeMode.isDark()) {
            AppNavHost(hasOnboarded = s.hasOnboarded)
        }
    }
}
```

Drawing nothing during `Loading` avoids a flash of the wrong theme under the splash's exit animation.

### Branded animation after the splash (optional)

If product wants a logo animation longer than the system splash, do not extend `setKeepOnScreenCondition`; instead let the system splash finish and show a Compose screen with the same background color that plays the animation, then navigates. The system splash is capped in duration and extending it is what Play's startup metrics measure.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell am force-stop com.example.app
adb shell am start -W -n com.example.app/.MainActivity     # prints TotalTime; compare with and without the keep condition
adb shell dumpsys gfxinfo com.example.app | head -20        # first-frame jank check
adb shell settings put global animator_duration_scale 1     # exit animation needs animations enabled
```

`-W` reports `TotalTime` in milliseconds. A splash held for the settings read should add well under 100 ms on a cold start; anything above that means the keep condition is waiting on something it should not.

Instrumented test that the splash releases:

```kotlin
@Test fun contentAppearsAfterSplash() {
    val scenario = ActivityScenario.launch(MainActivity::class.java)
    compose.waitUntil(5_000) { compose.onAllNodesWithTag("app_root").fetchSemanticsNodes().isNotEmpty() }
    scenario.close()
}
```

Add `Modifier.testTag("app_root")` to the `NavHost` container. Manual: cold start on an API 31+ emulator in light and dark mode and confirm the icon, background and the absence of a white flash between splash and first frame.

## Pitfalls

- Calling `installSplashScreen()` after `super.onCreate` throws or silently shows the default splash on older APIs.
- A keep condition that depends on network never releases offline; only gate on local reads with a timeout as a last resort.
- Forgetting `postSplashScreenTheme` leaves the Activity in `Theme.SplashScreen`, which has no action bar and odd window attributes, after the splash.
- A `windowBackground` in `Theme.App` that does not match the Compose surface color causes a flash before the first Compose frame.
- On API 31+ the system shows the splash for every cold launch from the launcher, but not for launches from a notification or deep link in a warm process; do not rely on it for a loading state.
- Custom views or `Activity` splash screens (a separate `SplashActivity`) are a legacy pattern; they double the splash on API 31+. Delete them.
- The exit animation listener runs on 31+ only; test the hard cut on an API 30 emulator too.

## Sources

- https://developer.android.com/develop/ui/views/launch/splash-screen
- https://developer.android.com/develop/ui/views/launch/splash-screen/migrate
- https://developer.android.com/jetpack/androidx/releases/core
- https://developer.android.com/topic/performance/vitals/launch-time
