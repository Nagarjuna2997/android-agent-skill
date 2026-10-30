# TV and large-screen app

A `:tv` application module for Android TV and Google TV built with Compose for TV (`androidx.tv:tv-material`), sharing data and domain modules with the phone app: Leanback launcher manifest, overscan-safe layout, D-pad focus management with `FocusRequester`, `focusRestorer` and `focusGroup`, key handling for a custom control, a navigation drawer, and the tablet/foldable tie-in through the adaptive layout pattern. Distilled from Jetcaster's `:tv` module in `android/compose-samples`; the code here is an original re-implementation. This capability is marked runtime-unverified: the recipe follows the documented APIs and the sample's structure but has not been executed on a TV device or emulator by this repository.

## When to use

- The product is media, fitness, games, smart home or anything used from across a room. TV is a ten-foot UI: large type, few items on screen, no touch, no keyboard, navigation entirely by D-pad.
- The app already runs on tablets through [adaptive layouts](../../patterns/ui/adaptive-layouts.md); TV is a separate module, not a larger breakpoint. A tablet layout on a TV fails Play's TV quality review (touch-only controls, unreachable focus, text cut off by overscan).
- Not for apps that only need a tablet layout: that is `WindowSizeClass` work, not this recipe. Not for Android Automotive, which has its own module and templates ([Car App Library](https://developer.android.com/training/cars)).
- Play requires TV builds to target API 34 or higher (`data/versions.json`, `policy.newAppsAndUpdates.tv`), lower than the phone requirement of 36; the module can still target 36.

## Dependencies

Versions for `androidx.tv` artifacts are not in `data/versions.json`; resolve `<version>` from https://developer.android.com/jetpack/androidx/releases/tv (Jetcaster uses `tv-material` 1.1.0 and `tv-foundation` 1.0.0).

`gradle/libs.versions.toml`:

```toml
[versions]
tv-material = "<version>"   # https://developer.android.com/jetpack/androidx/releases/tv

[libraries]
androidx-tv-material = { group = "androidx.tv", name = "tv-material", version.ref = "tv-material" }
```

`tv/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

android {
    namespace = "com.example.app.tv"
    compileSdk = 37
    defaultConfig {
        applicationId = "com.example.app"          // same id as :app so Play serves one listing
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }
    buildFeatures { compose = true }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))      // 2026.09.00
    implementation(libs.androidx.tv.material)
    implementation(libs.androidx.compose.ui)
    implementation("androidx.compose.material:material-icons-core")   // from the BOM; vector icons only, no material3
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)         // 2.10.2
    implementation(libs.androidx.lifecycle.runtime.compose)  // 2.11.0
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.androidx.hilt.navigation.compose)    // 1.4.0
    implementation(projects.core.data)
    implementation(projects.core.domain)
    implementation(projects.core.designsystem)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
```

Do not add `androidx.compose.material3:material3` to the TV module. `androidx.tv.material3` has its own `MaterialTheme`, `Surface`, `Card`, `Button`, `Text`, `ListItem`, `NavigationDrawer` and `Tab` with focus-driven scale and glow; mixing the two packages gives components that cannot be focused by a D-pad.

## Manifest and permissions

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <!-- No touch screen, and Leanback optional so a phone-and-TV single APK is also possible. -->
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />
    <uses-feature android:name="android.software.leanback" android:required="false" />

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:name=".TvApplication"
        android:banner="@drawable/tv_banner"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@style/Theme.App.Tv">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

`android:banner` (320 x 180 dp) is required for the TV home screen and is a Play listing requirement. `Theme.App.Tv` should inherit `android:Theme.Material.NoActionBar` (or `Theme.AppCompat.NoActionBar`) with a dark window background; Compose draws everything else. If the TV module is a separate APK with the same `applicationId`, give it a distinct `versionCode` range (for example phone `1xxxx`, TV `2xxxx`) so both can be uploaded to the same release.

## Implementation

### Theme and spacing

TV screens are viewed at a distance and part of the edge may be hidden by the display (overscan). Keep 48 dp horizontal and 27 dp vertical margins on screen edges (Android's TV guidance), and put the values in one place.

```kotlin
package com.example.app.tv.ui.theme

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.darkColorScheme

@Immutable
data class OverscanMargin(val horizontal: Dp = 48.dp, val vertical: Dp = 27.dp) {
    fun asPadding() = PaddingValues(horizontal = horizontal, vertical = vertical)
}

object TvDefaults {
    val overscan = OverscanMargin()
    val cardWidth = 196.dp
    val rowGap = 20.dp
    val sectionGap = 40.dp
}

@Composable
fun TvTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(),   // TV UIs are dark by convention; brand it with your tokens
        typography = TvTypography,         // larger sizes than the phone theme; bodyLarge around 20 sp
        content = content,
    )
}
```

### Screen with a navigation drawer

The drawer collapses to icons and expands when focus enters it. `focusProperties { onEnter }` sends focus to the item for the current route, and `focusGroup()` keeps D-pad movement inside the drawer until the user presses right.

```kotlin
package com.example.app.tv.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.focusGroup
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.List
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.tv.material3.DrawerValue
import androidx.tv.material3.Icon
import androidx.tv.material3.NavigationDrawer
import androidx.tv.material3.NavigationDrawerItem
import androidx.tv.material3.Text
import com.example.app.tv.ui.theme.TvDefaults

enum class TvDestination(val label: String, val icon: ImageVector) {
    Home("Home", Icons.Filled.Home), Library("Library", Icons.Filled.List),
    Search("Search", Icons.Filled.Search), Settings("Settings", Icons.Filled.Settings),
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun TvShell(current: TvDestination, onNavigate: (TvDestination) -> Unit, content: @Composable () -> Unit) {
    val requesters = remember { TvDestination.entries.associateWith { FocusRequester() } }

    NavigationDrawer(
        drawerContent = { drawerValue ->
            val closed = drawerValue == DrawerValue.Closed
            Column(
                Modifier
                    .padding(horizontal = 16.dp, vertical = TvDefaults.overscan.vertical)
                    // Technique from android/compose-samples Jetcaster (Apache-2.0): entering the
                    // drawer lands on the current destination, not the first item.
                    .focusProperties { onEnter = { requesters.getValue(current).requestFocus() } }
                    .focusGroup(),
            ) {
                TvDestination.entries.forEach { destination ->
                    NavigationDrawerItem(
                        selected = closed && destination == current,
                        onClick = { onNavigate(destination) },
                        leadingContent = { Icon(destination.icon, contentDescription = null) },
                        modifier = Modifier.focusRequester(requesters.getValue(destination)),
                    ) { Text(destination.label) }
                    if (destination == TvDestination.Home) Spacer(Modifier.weight(1f))
                }
            }
        },
    ) {
        content()
    }
}
```

Hosting: `NavHost` from Navigation Compose works unchanged on TV; wrap destinations that should show the drawer in `TvShell` and leave player or search full screen. Use `hiltViewModel()` and the same `UiState` ViewModels as the phone module where the data is identical; the TV module only owns screens.

### Catalog rows with focus restoration

A vertical `LazyColumn` of horizontal `LazyRow`s is the standard TV catalog. Two focus rules make it usable: the screen requests initial focus on first composition, and each row remembers which item had focus so moving down and back up returns to the same card.

```kotlin
package com.example.app.tv.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.Text
import com.example.app.tv.ui.theme.TvDefaults

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun CatalogScreen(sections: List<CatalogSection>, onOpen: (String) -> Unit) {
    val firstRow = remember { FocusRequester() }
    LaunchedEffect(sections.isNotEmpty()) { if (sections.isNotEmpty()) firstRow.requestFocus() }

    LazyColumn(
        contentPadding = TvDefaults.overscan.asPadding(),
        verticalArrangement = Arrangement.spacedBy(TvDefaults.sectionGap),
        modifier = Modifier.fillMaxSize(),
    ) {
        items(sections, key = { it.id }) { section ->
            Column {
                Text(section.title)
                LazyRow(
                    horizontalArrangement = Arrangement.spacedBy(TvDefaults.rowGap),
                    modifier = Modifier
                        .then(if (section == sections.first()) Modifier.focusRequester(firstRow) else Modifier)
                        .focusRestorer(),     // returns focus to the last focused card in this row
                ) {
                    items(section.items, key = { it.id }) { item ->
                        Card(
                            onClick = { onOpen(item.id) },
                            scale = CardDefaults.scale(focusedScale = 1.1f),   // focus is the hover state on TV
                        ) {
                            Poster(item)
                        }
                    }
                }
            }
        }
    }
}
```

`focusRestorer()` needs each item to be keyed (it stores the key of the focused child). The `scale` and `border` defaults on `androidx.tv.material3.Card` already show focus; never rely on color alone because the user is several meters away.

### Handling D-pad keys on a custom control

Most of the time `focusable()` plus `onClick` is enough: D-pad center maps to click. A seek bar needs left/right as its own gestures:

```kotlin
package com.example.app.tv.ui.player

import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
fun SeekBar(progress: Float, onSeekBy: (seconds: Int) -> Unit, color: Color, modifier: Modifier = Modifier) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Box(
        modifier
            .fillMaxWidth()
            .height(16.dp)
            .semantics { progressBarRangeInfo = ProgressBarRangeInfo(progress, 0f..1f) }
            .focusable(interactionSource = interaction)
            .onKeyEvent { event ->
                if (event.type != KeyEventType.KeyUp) return@onKeyEvent false
                when (event.key) {
                    Key.DirectionLeft -> { onSeekBy(-10); true }
                    Key.DirectionRight -> { onSeekBy(10); true }
                    else -> false
                }
            }
            .drawWithCache {
                val knobRadius = (if (focused) 8.dp else 5.dp).toPx()
                val y = size.height / 2f
                onDrawBehind {
                    drawLine(color, Offset(0f, y), Offset(size.width, y), strokeWidth = 2.dp.toPx())
                    if (focused) drawCircle(color.copy(alpha = 0.4f), knobRadius * 1.6f, Offset(progress * size.width, y))
                    drawCircle(color, knobRadius, Offset(progress * size.width, y))
                }
            },
    )
}
```

Return `true` only for keys you consume, or focus navigation stops working around the control. `Key.Back` is handled by `BackHandler`, not here. Media keys (`Key.MediaPlayPause`, `Key.MediaFastForward`) arrive at the Activity; route them through a `MediaSession` ([media-playback](../media-playback/README.md)) rather than `onKeyEvent`.

### Large screens that are not TVs

Tablets, foldables and ChromeOS stay in the phone module. The parts of this recipe that transfer: keyboard focus order (`focusGroup`, `focusRestorer`) for keyboard users, and visible focus states on cards. The parts that do not: Leanback launcher, overscan margins, `androidx.tv.material3`. See [../../patterns/ui/adaptive-layouts.md](../../patterns/ui/adaptive-layouts.md) for the multi-form-factor module layout that keeps `:app` and `:tv` on the same core.

## Verify

```sh
./gradlew :tv:assembleDebug
./gradlew :tv:testDebugUnitTest
# Android TV emulator: create an AVD from the "TV" category (1080p, API 34+), then
adb -s emulator-5554 install -r tv/build/outputs/apk/debug/tv-debug.apk
adb shell am start -n com.example.app/com.example.app.tv.MainActivity
adb shell input keyevent KEYCODE_DPAD_DOWN      # focus moves to the first row
adb shell input keyevent KEYCODE_DPAD_RIGHT     # focus moves along the row, card scales
adb shell input keyevent KEYCODE_DPAD_CENTER    # opens the item
adb shell input keyevent KEYCODE_BACK
```

Compose UI test for focus (runs on the TV emulator):

```kotlin
@Test fun firstCardReceivesInitialFocus() {
    composeRule.setContent { TvTheme { CatalogScreen(sections = fakeSections, onOpen = {}) } }
    composeRule.onAllNodes(hasClickAction()).onFirst().assertIsFocused()
    composeRule.onRoot().performKeyInput { pressKey(Key.DirectionRight) }
    composeRule.onAllNodes(hasClickAction())[1].assertIsFocused()
}
```

Report status honestly: "source inspected, `:tv` compiles" after `assembleDebug`; "runtime unverified" until the D-pad walkthrough above was done on a TV emulator or device. Before Play submission run the TV quality checklist (banner, no touch-only controls, every item reachable by D-pad, text inside overscan margins, 10-foot type sizes).

## Pitfalls

- Importing `androidx.compose.material3.*` in the TV module. The components look right and cannot be focused.
- No initial focus request: the screen renders and the D-pad does nothing until the user presses a direction, and sometimes not even then.
- `LazyRow` without keys plus `focusRestorer()`: restoration silently fails.
- Content at the screen edge: cut off on many TVs. Use the overscan padding on every top-level screen, not on the window.
- Reading `WindowSizeClass` to detect TV. Detect TV by module (`:tv`) or `UiModeManager.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION` if a single-APK layout is unavoidable.
- `requestFocus()` on a `FocusRequester` not yet attached (the composable was not composed) throws `IllegalStateException`; request focus in a `LaunchedEffect` keyed on the data being present, as above.
- Consuming every key in `onKeyEvent` (`true` unconditionally) breaks Back and focus traversal.
- Light theme on TV: glare and eye strain; dark is the convention and the Play review expects it.
- `targetSdk` below 34 in the TV module: rejected by Play for TV form factors.

## Sources

- https://developer.android.com/training/tv/playback/compose
- https://developer.android.com/design/ui/tv
- https://developer.android.com/develop/ui/compose/touch-input/focus
- https://developer.android.com/develop/ui/compose/touch-input/focus/change-focus-behavior
- https://developer.android.com/develop/ui/compose/touch-input/keyboard-input/commands
- https://developer.android.com/training/tv/start/start
- https://developer.android.com/jetpack/androidx/releases/tv
- https://developer.android.com/google/play/requirements/target-sdk
- https://github.com/android/compose-samples (Jetcaster `:tv`; see [../../references/compose-samples.md](../../references/compose-samples.md))
