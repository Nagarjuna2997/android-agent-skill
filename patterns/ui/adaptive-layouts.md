# Adaptive Layouts

Phones, tablets, foldables, ChromeOS windows and desktop mode all run the same APK. The layout must respond to the actual window size and posture, not to "is this a tablet". The tools: `WindowSizeClass` from `androidx.window:window:1.5.1`, `currentWindowAdaptiveInfo()` and the canonical scaffolds from `androidx.compose.material3.adaptive`.

```kotlin
dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3.adaptive:adaptive")
    implementation("androidx.compose.material3.adaptive:adaptive-layout")
    implementation("androidx.compose.material3.adaptive:adaptive-navigation")
    implementation("androidx.compose.material3:material3-adaptive-navigation-suite")
    implementation("androidx.window:window:1.5.1")
}
```

## Window size classes

A `WindowSizeClass` buckets the window into width and height classes. Decide layout by width class; height class matters for landscape phones.

| Width class | Breakpoint | Typical | Layout |
|---|---|---|---|
| Compact | < 600 dp | Phone portrait | Single pane, bottom navigation |
| Medium | 600 to 839 dp | Phone landscape, small tablet, unfolded foldable portrait | Two panes possible, navigation rail |
| Expanded | 840 dp and up | Tablet landscape, desktop window | Two or three panes, navigation drawer or rail |

Window 1.5.1 also defines `WIDTH_DP_LARGE_LOWER_BOUND` (1200) and `WIDTH_DP_EXTRA_LARGE_LOWER_BOUND` (1600) for large desktop windows.

```kotlin
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.window.core.layout.WindowSizeClass
import androidx.window.core.layout.WindowSizeClass.Companion.WIDTH_DP_EXPANDED_LOWER_BOUND
import androidx.window.core.layout.WindowSizeClass.Companion.WIDTH_DP_MEDIUM_LOWER_BOUND

@Composable
fun HomeScreen() {
    val windowSizeClass = currentWindowAdaptiveInfo().windowSizeClass
    when {
        windowSizeClass.isWidthAtLeastBreakpoint(WIDTH_DP_EXPANDED_LOWER_BOUND) -> ThreePaneHome()
        windowSizeClass.isWidthAtLeastBreakpoint(WIDTH_DP_MEDIUM_LOWER_BOUND) -> TwoPaneHome()
        else -> SinglePaneHome()
    }
}
```

Use the `isWidthAtLeastBreakpoint` style rather than comparing enums; it reads correctly when the extra breakpoints are added and does not need a `when` with every case.

`currentWindowAdaptiveInfo()` reads the Activity's window, so it reacts when the user resizes a freeform window on ChromeOS or enters split screen; `LocalConfiguration` alone misses some of those. Do not compute size classes from `Resources.displayMetrics`, which reports the display, not the window.

## List-detail with ListDetailPaneScaffold

The canonical pattern for a list of items with a detail view: one pane on compact, two on medium/expanded, with the back gesture collapsing the detail pane.

```kotlin
package com.example.app.todo

import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffold
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.navigation.NavigableListDetailPaneScaffold
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
fun TodoListDetail(items: List<TodoItem>) {
    // The navigator owns which panes are visible and the selected content key;
    // it is saved across configuration change.
    val navigator = rememberListDetailPaneScaffoldNavigator<String>()
    val scope = rememberCoroutineScope()

    NavigableListDetailPaneScaffold(
        navigator = navigator,
        listPane = {
            AnimatedPane {
                TodoList(
                    items = items,
                    selectedId = navigator.currentDestination?.contentKey,
                    onSelect = { id ->
                        scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, id) }
                    },
                )
            }
        },
        detailPane = {
            AnimatedPane {
                val id = navigator.currentDestination?.contentKey
                if (id == null) EmptyDetailPlaceholder() else TodoDetail(id = id)
            }
        },
    )
}
```

`NavigableListDetailPaneScaffold` wires `BackHandler` for you: on compact, back goes from detail to list; on expanded, back does nothing special. The `contentKey` is the item id, not the item; the detail composable loads its own data. The adaptive APIs are still `@ExperimentalMaterial3AdaptiveApi` in the 2026.09.00 BOM; check the annotation after each BOM update.

For a third pane (list, detail, extra) use `SupportingPaneScaffold`, or use `ListDetailPaneScaffold` with an `extraPane`.

## NavigationSuiteScaffold

Replaces a hand-written switch between `NavigationBar`, `NavigationRail` and `PermanentNavigationDrawer`.

```kotlin
package com.example.app

import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue

@Composable
fun AppShell() {
    var current by rememberSaveable { mutableStateOf(TopLevel.Home) }

    NavigationSuiteScaffold(
        navigationSuiteItems = {
            TopLevel.entries.forEach { dest ->
                item(
                    selected = dest == current,
                    onClick = { current = dest },
                    icon = { Icon(dest.icon, contentDescription = null) },
                    label = { Text(dest.label) },
                )
            }
        },
    ) {
        when (current) {
            TopLevel.Home -> HomeRoute()
            TopLevel.Search -> SearchRoute()
            TopLevel.Profile -> ProfileRoute()
        }
    }
}
```

By default it chooses a bottom bar for compact width, a rail for medium and expanded, and a drawer only when you pass a `layoutType` explicitly. To integrate with Navigation Compose, put the `NavHost` in the content slot and drive `selected` from `currentBackStackEntryAsState()` as in [../navigation.md](../navigation.md).

## Foldable posture

Foldables report their hinge through `WindowInfoTracker`. The useful states: `FoldingFeature.State.HALF_OPENED` (tabletop or book mode) and the hinge's `bounds`, so content can avoid it.

```kotlin
package com.example.app.ui

import android.app.Activity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.flow.map

sealed interface Posture {
    data object Flat : Posture
    data class TableTop(val hingeBoundsPx: android.graphics.Rect) : Posture   // horizontal hinge, half open
    data class Book(val hingeBoundsPx: android.graphics.Rect) : Posture       // vertical hinge, half open
}

@Composable
fun rememberPosture(): Posture {
    val activity = LocalContext.current as Activity
    val flow = remember(activity) {
        WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).map { info ->
            val fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
            when {
                fold == null || fold.state != FoldingFeature.State.HALF_OPENED -> Posture.Flat
                fold.orientation == FoldingFeature.Orientation.HORIZONTAL -> Posture.TableTop(fold.bounds)
                else -> Posture.Book(fold.bounds)
            }
        }
    }
    val posture by flow.collectAsState(initial = Posture.Flat)
    return posture
}
```

Typical uses: in tabletop mode, put the video on the top half and controls on the bottom; in book mode, use the hinge as the list-detail divider. `currentWindowAdaptiveInfo().windowPosture` exposes `isTabletop` and `hingeList` directly if you do not need the raw tracker; prefer it when it has what you need.

Do not lock orientation on foldables or tablets. Google Play flags `android:screenOrientation="portrait"` on large screens, and from Android 16 the system ignores orientation and resizability restrictions on displays 600 dp and wider.

## Tablet and ChromeOS

- Declare nothing special; every app runs on ChromeOS. Do declare `<uses-feature android:name="android.hardware.touchscreen" android:required="false" />` if the app works with a mouse and keyboard, or it is hidden from devices without touch.
- Support keyboard navigation: focus order follows composition order; make sure interactive elements are focusable (Material components already are) and test with Tab.
- Support mouse hover: `Modifier.hoverable` plus `MutableInteractionSource` for hover states on cards and rows.
- Handle window resize: free-form windows can change size class at any time. Keep screen state in ViewModels and `rememberSaveable`, never in a composable that will be disposed when the pane layout changes.
- Max content width: on an expanded window a single-column form should not stretch to 1600 dp. Cap it: `Modifier.widthIn(max = 640.dp)` centered.
- Large-screen quality: Play's large-screen guidelines require no letterboxing, no stretched phone UI, and keyboard/stylus support for the "Tier 2" badge.

## Orientation and configuration changes

Compose survives configuration changes through `rememberSaveable` and ViewModels. Do not add `android:configChanges` to avoid recreation; that opts out of resource reloading and breaks things like locale changes. Instead:

- Hoist state so it is not lost (see [compose-state.md](compose-state.md)).
- Avoid `LocalConfiguration.current.orientation` to pick layouts; use the width class. A landscape phone is Medium width and Compact height, which is the right signal for "show two panes but keep vertical space small".
- Test with the emulator's resizable device profile and with the "Resizable (Experimental)" AVD, which switches between phone, foldable, tablet and desktop frames.

## Previews across sizes

```kotlin
import androidx.compose.ui.tooling.preview.Devices
import androidx.compose.ui.tooling.preview.Preview

@Preview(name = "Phone", device = Devices.PIXEL_7, showSystemUi = true)
@Preview(name = "Foldable", device = Devices.PIXEL_FOLD, showSystemUi = true)
@Preview(name = "Tablet", device = Devices.PIXEL_TABLET, showSystemUi = true)
@Preview(name = "Desktop", device = "spec:width=1920dp,height=1080dp,dpi=160", showSystemUi = true)
annotation class DevicePreviews
```

## Avoid

```kotlin
// Anti-pattern: tablet detection by smallest width resource or screen size, not window.
val isTablet = LocalConfiguration.current.smallestScreenWidthDp >= 600

// Anti-pattern: orientation lock in the manifest.
android:screenOrientation="portrait"

// Anti-pattern: configChanges to dodge recreation.
android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout"

// Anti-pattern: a Boolean `isExpanded` passed down ten levels instead of letting
// each adaptive composable read currentWindowAdaptiveInfo() itself.

// Anti-pattern: duplicating full screens per size class. Share the pane composables
// and vary only the scaffold.
```

## Verify

```sh
./gradlew :app:assembleDebug
# Emulator: create the "Resizable (Experimental)" AVD, then cycle sizes from the toolbar.
adb shell wm size 1280x800      # force a tablet-like window size on a phone for a quick check
adb shell wm size reset
adb shell settings put global force_resizable_activities 1   # test freeform resizing
```

Run the list-detail screen through: phone portrait, phone landscape, foldable half-open, tablet, and a ChromeOS or desktop window resized while open. The selected item must survive every transition.

## Sources

- https://developer.android.com/develop/ui/compose/layouts/adaptive
- https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes
- https://developer.android.com/develop/ui/compose/layouts/adaptive/list-detail
- https://developer.android.com/develop/ui/compose/layouts/adaptive/build-adaptive-navigation
- https://developer.android.com/develop/ui/compose/layouts/adaptive/foldables
- https://developer.android.com/guide/topics/large-screens/large-screen-app-quality
- https://developer.android.com/jetpack/androidx/releases/window
- https://developer.android.com/jetpack/androidx/releases/compose-material3-adaptive
