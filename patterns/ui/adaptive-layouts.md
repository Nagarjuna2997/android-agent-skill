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

## Choosing the navigation suite yourself

`NavigationSuiteScaffold` picks bar, rail or drawer from the width class. When the product wants different rules (a permanent drawer only on very wide windows, a bottom bar in tabletop posture because the lower half is the only reachable area, a rail header that moves to the top on short windows), decide the `NavigationSuiteType` yourself and feed it to `NavigationSuiteScaffoldLayout`, which lays out your own navigation composable next to the content. This is how Reply from `android/compose-samples` does it.

```kotlin
package com.example.app

import androidx.activity.compose.BackHandler
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.currentWindowSize
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldLayout
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import androidx.window.core.layout.WindowSizeClass
import androidx.window.core.layout.WindowSizeClass.Companion.HEIGHT_DP_MEDIUM_LOWER_BOUND
import androidx.window.core.layout.WindowSizeClass.Companion.WIDTH_DP_EXPANDED_LOWER_BOUND
import androidx.window.core.layout.WindowSizeClass.Companion.WIDTH_DP_MEDIUM_LOWER_BOUND
import kotlinx.coroutines.launch

// Compact in either dimension: a landscape phone is wide but too short for a rail with a header.
private fun WindowSizeClass.isCompactInAnyDimension(): Boolean =
    !isWidthAtLeastBreakpoint(WIDTH_DP_MEDIUM_LOWER_BOUND) || !isHeightAtLeastBreakpoint(HEIGHT_DP_MEDIUM_LOWER_BOUND)

@Composable
fun AppNavigationShell(
    current: TopLevel,
    onNavigate: (TopLevel) -> Unit,
    content: @Composable () -> Unit,
) {
    val adaptiveInfo = currentWindowAdaptiveInfo()
    val windowWidthDp = with(LocalDensity.current) { currentWindowSize().toSize().toDpSize().width }

    val layoutType = when {
        adaptiveInfo.windowPosture.isTabletop -> NavigationSuiteType.NavigationBar
        adaptiveInfo.windowSizeClass.isCompactInAnyDimension() -> NavigationSuiteType.NavigationBar
        adaptiveInfo.windowSizeClass.isWidthAtLeastBreakpoint(WIDTH_DP_EXPANDED_LOWER_BOUND) &&
            windowWidthDp >= 1200.dp -> NavigationSuiteType.NavigationDrawer
        else -> NavigationSuiteType.NavigationRail
    }

    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    // A swipe must not open the modal drawer when a permanent drawer or a bottom bar is showing,
    // but an open drawer must always be closable.
    val gesturesEnabled = drawerState.isOpen || layoutType == NavigationSuiteType.NavigationRail
    BackHandler(enabled = drawerState.isOpen) { scope.launch { drawerState.close() } }

    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = gesturesEnabled,
        drawerContent = { AppDrawerContent(current, onNavigate, onClose = { scope.launch { drawerState.close() } }) },
    ) {
        NavigationSuiteScaffoldLayout(
            layoutType = layoutType,
            navigationSuite = {
                when (layoutType) {
                    NavigationSuiteType.NavigationBar -> AppBottomBar(current, onNavigate)
                    NavigationSuiteType.NavigationRail -> AppRail(current, onNavigate, onMenu = { scope.launch { drawerState.open() } })
                    else -> AppPermanentDrawer(current, onNavigate)
                }
            },
            content = content,
        )
    }
}
```

`AppBottomBar`, `AppRail`, `AppPermanentDrawer` and `AppDrawerContent` are ordinary `NavigationBar`, `NavigationRail` and `PermanentDrawerSheet` composables over the same `TopLevel` enum. Keep the selection logic in one function like the one above; do not map `NavigationSuiteType` to an app-specific enum and back.

## The `isExpandedScreen` two-pane pattern

Before reaching for `ListDetailPaneScaffold`, consider the simpler shape JetNews uses: compute one Boolean at the root and let it drive three decisions. It fits apps whose "detail" is a full screen on phones and a side pane on tablets, with no third pane and no extra-pane navigation.

```kotlin
package com.example.app

import androidx.compose.foundation.layout.Row
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.window.core.layout.WindowSizeClass.Companion.WIDTH_DP_EXPANDED_LOWER_BOUND
import kotlinx.coroutines.launch

@Composable
fun AppRoot() {
    val isExpandedScreen = currentWindowAdaptiveInfo().windowSizeClass
        .isWidthAtLeastBreakpoint(WIDTH_DP_EXPANDED_LOWER_BOUND)
    val drawerState = rememberSizeAwareDrawerState(isExpandedScreen)
    val scope = rememberCoroutineScope()

    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = !isExpandedScreen,               // (1) no modal drawer when the rail is shown
        drawerContent = { AppDrawerContent(onNavigated = { scope.launch { drawerState.close() } }) },
    ) {
        Row {
            if (isExpandedScreen) AppRail()                // (2) rail replaces the drawer
            AppNavHost(
                isExpandedScreen = isExpandedScreen,       // (3) panes hide their own top bars when side by side
                openDrawer = { scope.launch { drawerState.open() } },
            )
        }
    }
}

// Technique from android/compose-samples JetNews (Apache-2.0): on expanded windows provide a drawer
// state that is deliberately not remembered, so it can never be opened and never saves state.
@Composable
private fun rememberSizeAwareDrawerState(isExpandedScreen: Boolean): DrawerState {
    val remembered = rememberDrawerState(DrawerValue.Closed)
    return if (isExpandedScreen) DrawerState(DrawerValue.Closed) else remembered
}
```

Inside the host, the list screen shows its top app bar only when `!isExpandedScreen` (the rail carries navigation otherwise) and the detail screen shows a back arrow and bottom action bar only when `!isExpandedScreen` (side by side, the list is already visible). When the window shrinks while a detail is open, the detail becomes the full screen and back returns to the list; when it grows, the list reappears beside it. Both work because the selected item id lives in navigation state, not in a composable.

If the `isExpandedScreen` value is read inside a `remember` block (for example when building Navigation 3 entries that are cached), wrap it with `rememberUpdatedState` and pass a `() -> Boolean` so a later resize is observed:

```kotlin
val currentIsExpanded by rememberUpdatedState(isExpandedScreen)
val entries = remember { buildEntries(isExpanded = { currentIsExpanded }) }
```

Switch to `ListDetailPaneScaffold` when you need the medium breakpoint to also show two panes, animated pane transitions, or an extra pane; it also owns back handling and saved state for you.

## Multi-form-factor module layout

An app that ships to phone, tablet, TV and watch is one Gradle project with one application module per form factor on a shared core, not one module with `if (isTv)` branches. Jetcaster from `android/compose-samples` is the reference layout:

```text
settings.gradle.kts
  :core:data            Room, network, repositories (interfaces + implementations)
  :core:data-testing    fake repositories for every UI module's tests
  :core:domain          use cases and domain models
  :core:domain-testing  fakes for use cases
  :core:designsystem    colors, typography, shapes, keylines, shared image composable
  :mobile               com.android.application, phone + tablet + foldable, Material 3 adaptive
  :tv                   com.android.application, androidx.tv Material, LEANBACK_LAUNCHER
  :wear                 com.android.application, Compose for Wear OS
  :glancewidget         Glance widget on the same data
```

Rules that make this work:

- Every application module declares the same `applicationId` and version, so Play treats them as one app with device-targeted bundles; `:tv` and `:wear` add their manifest features (`android.software.leanback`, `android.hardware.type.watch`).
- Only `:core:designsystem` and the UI modules depend on Compose. `:core:data` and `:core:domain` are Kotlin and coroutines; they compile fast and are tested on the JVM.
- The TV and watch modules do not depend on `:mobile`; a shared composable that every form factor needs (a podcast thumbnail, an empty state) belongs in `:core:designsystem`, and a form-factor-specific one stays in its module.
- `targetSdk` is per module: Play's minimum for TV (34) and Wear (35) differs from phone and tablet (36); see `data/versions.json` under `policy.newAppsAndUpdates`.
- A single Compose compiler stability configuration file at the root, referenced by each module's `composeCompiler { stabilityConfigurationFiles }`, keeps domain models stable everywhere.

The per-form-factor recipes are [../../capabilities/tv-and-large-screen-app/README.md](../../capabilities/tv-and-large-screen-app/README.md) and [../../capabilities/wear-os-companion/README.md](../../capabilities/wear-os-companion/README.md); the module split itself follows [../clean-architecture.md](../clean-architecture.md).

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

// Anti-pattern: Accompanist TwoPane / calculateDisplayFeatures, or material3-window-size-class's
// calculateWindowSizeClass(activity). Both are superseded by currentWindowAdaptiveInfo() and the
// adaptive scaffolds; do not add Accompanist to a new project for this.
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
- https://developer.android.com/google/play/requirements/target-sdk
- https://github.com/android/compose-samples (JetNews, Reply, Jetcaster; see [../../references/compose-samples.md](../../references/compose-samples.md))
