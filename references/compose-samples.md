# Reference study: android/compose-samples

`android/compose-samples` is Google's collection of Jetpack Compose showcase apps. Six of them were studied for this repository: JetNews (news reader), Jetsnack (shopping, custom design system), Jetchat (messaging), Jetcaster (podcasts, multi-form-factor), JetLagged (sleep tracker, custom drawing) and Reply (email, adaptive navigation). Each app is a separate Gradle project with its own `gradle/libs.versions.toml`; the catalogs are copies of one shared file, so most apps agree on versions. This document records what each app demonstrates, what to adopt, what not to copy, and which file in this repository now teaches each technique.

## Toolchain snapshot

Read from `JetNews/gradle/libs.versions.toml` (shared by Jetsnack, Jetchat, JetLagged and Reply) and `Jetcaster/gradle/libs.versions.toml`, checkout dated 2026-10-23.

| Item | JetNews, Jetsnack, Jetchat, JetLagged, Reply | Jetcaster | This repo (`data/versions.json`) | Verdict |
|---|---|---|---|---|
| AGP | 9.3.1 | 9.2.1 | 9.4.0 | samples lag by one or two minors |
| Gradle wrapper | 9.5.0 | 9.5.0 | 9.6.0 (AGP-documented) | lags |
| Kotlin | 2.4.20 | 2.3.21 | 2.4.20 | JetNews group matches; Jetcaster lags |
| KSP | 2.3.12 | 2.3.9 | resolve from release page | n/a |
| Compose BOM | 2026.09.00 | 2026.09.00 | 2026.09.00 | matches |
| Material 3 | from BOM | 1.5.0-alpha22 (pinned) | 1.4.0 | Jetcaster leads on an alpha; do not copy that pin |
| Navigation | 2.10.1 | 2.9.8 | 2.10.2 | lags slightly |
| Navigation 3 | 1.2.0-rc01 (JetNews only) | not used | 1.2.0 | JetNews is on the RC |
| Lifecycle (compose) | 2.11.0 | 2.11.0 | 2.11.0 | matches |
| Window | 1.5.1 | 1.5.1 | 1.5.1 | matches |
| compileSdk / minSdk / targetSdk | 37 / 24 / 33 | 37 / 24 / 33 | 37 / 24 / 36 | `targetSdk = 33` is a sample-only setting; Play requires 36 |
| Room | 2.8.5 | 2.8.4 | 2.8.5 | matches / lags |
| Hilt | 2.60.1 | 2.59.2 | resolve from release page | n/a |
| Coil | 2.7.0 (`io.coil-kt`) | 2.7.0 | Coil 3 (`io.coil-kt.coil3`) | samples lag a major version |
| androidx.tv material | n/a | 1.1.0 | not in catalog | `<version>` |
| Wear Compose | n/a | 1.6.2 | not in catalog | `<version>` |
| Accompanist | 0.37.3 (Reply `adaptive`, `permissions`) | 0.37.3 | not used | do not adopt |

Every app enables `enableEdgeToEdge()`, uses the Kotlin Compose compiler plugin (`org.jetbrains.kotlin.plugin.compose`), KSP (no kapt), and Roborazzi screenshot tests in some modules.

## JetNews

What it is: a news reader with a feed, article detail, interests tabs, a navigation drawer that becomes a rail on expanded windows, a Glance widget, and deep links. Its data layer is fake and in-memory; the value is the UI layer.

### UI techniques demonstrated

- Navigation 3 with a custom `Scene`. JetNews owns its back stacks (one `NavBackStack` per top-level destination) and implements a `ListDetailScene` plus a `SceneStrategy` that pairs a list entry with the detail entry above it when the window is expanded. Pane layout is attached to entries as metadata rather than wired through parameters. The `NavDisplay` also wires predictive back through `NavigationBackHandler` and a `predictivePopTransitionSpec` that scales the outgoing screen toward the edge the gesture started from.
- Two-pane `isExpandedScreen` pattern. The app computes one Boolean from `currentWindowAdaptiveInfo().windowSizeClass.isWidthAtLeastBreakpoint(WIDTH_DP_EXPANDED_LOWER_BOUND)` and uses it to (a) swap the modal drawer for a rail, (b) lock the drawer closed on expanded windows by providing a non-remembered `DrawerState(Closed)`, (c) hide the top app bar on the detail pane when it is side by side with the list.
- `rememberUpdatedState` around a value read inside a `remember` block. Because the Navigation 3 `entryProvider` is captured during entry decoration, JetNews wraps `isExpandedScreen` in `rememberUpdatedState` and passes a lambda `{ currentIsExpandedScreen }` so later window resizes are visible without rebuilding the entries.
- Error messages as state, one at a time. `HomeUiState` carries `errorMessages: List<ErrorMessage>`; the screen shows `errorMessages[0]` in a snackbar inside a `LaunchedEffect` keyed on the message text, and calls back `onErrorDismiss(id)` when the snackbar is gone. The retry and dismiss lambdas go through `rememberUpdatedState` so a recomposition does not restart the effect.
- `derivedStateOf` on `LazyListState` for an "is scrolled" flag, and `snapshotFlow` with `debounce(50)` to persist scroll position (index and offset) into the ViewModel so the detail pane restores it after process death.
- Rich article body rendered from a paragraph model (`Paragraph(type, text, markups)`) into `AnnotatedString` spans; bullets drawn as an `sp`-sized box aligned to the text baseline with `alignBy`; code blocks on a tinted `Surface`.
- Accessibility: a row-level `customActions` entry for "bookmark" while the inner toggle button gets `clearAndSetSemantics {}` so TalkBack sees one node with one action; `onClick(label = ...)` to rename the click action; `heading()` on tab section titles; `semantics(mergeDescendants = true)` on author metadata rows.
- A multipreview annotation set (`@CompletePreviews` style) combining device, font scale and theme previews.

### Adopt

Original illustration of the "one expanded Boolean, read at the top" pattern:

```kotlin
// Technique from android/compose-samples JetNews (Apache-2.0): compute the breakpoint once,
// hand the pane composables a Boolean, and keep every pane composable size-agnostic.
@Composable
fun AppShell() {
    val windowSizeClass = currentWindowAdaptiveInfo().windowSizeClass
    val isExpanded = windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_EXPANDED_LOWER_BOUND)
    Row {
        if (isExpanded) AppNavRail(...)
        AppNavDisplay(isExpanded = isExpanded, ...)
    }
}
```

### Do not copy

- `val LazyListState.isScrolled get() = derivedStateOf { ... }.value` allocates a new derived state on every read because it is not remembered. Wrap in `remember(listState) { derivedStateOf { ... } }` instead (see [../patterns/ui/compose-state.md](../patterns/ui/compose-state.md)).
- Manual DI through `AppContainer` and `ViewModel.provideFactory`. The sample avoids Hilt to stay dependency-light; this repository uses Hilt by default ([../patterns/dependency-injection.md](../patterns/dependency-injection.md)).
- Links in article bodies are underlined but not clickable (no `LinkAnnotation`). The rich-text capability adds proper link handling.
- `targetSdk = 33`.

### Where this repository teaches it

| Technique | File |
|---|---|
| Expanded-screen two-pane shell, drawer-to-rail | [../patterns/ui/adaptive-layouts.md](../patterns/ui/adaptive-layouts.md) ("The `isExpandedScreen` two-pane pattern") |
| `rememberSaveable` with custom `Saver`, `rememberSerializable`, state holders, `derivedStateOf` and `LazyListState` effects | [../patterns/ui/compose-state.md](../patterns/ui/compose-state.md) ("Patterns from the Compose samples") |
| Paragraph model to `AnnotatedString`, inline content, `LinkAnnotation` | [../capabilities/rich-text-and-markdown/README.md](../capabilities/rich-text-and-markdown/README.md) |
| Row-level custom actions, click labels | [../patterns/ui/accessibility.md](../patterns/ui/accessibility.md) ("Semantics patterns from the Compose samples") |
| `snapshotFlow` scroll persistence, snackbar queue with `rememberUpdatedState` | [../docs/compose/state-and-side-effects.md](../docs/compose/state-and-side-effects.md) ("Sample-derived examples") |
| Navigation 3 back stacks | [../patterns/navigation.md](../patterns/navigation.md) (already covered; JetNews's custom `Scene` is advanced and not reproduced) |

## Jetsnack

What it is: a snack shop with a feed, search, cart and product detail. It is the reference for a fully custom design system on top of Compose and for shared element transitions with Navigation Compose.

### UI techniques demonstrated

- Custom design system. `JetsnackColors` is an `@Immutable` data class with brand, text, icon, border and gradient roles, provided through a private `staticCompositionLocalOf` and read via `JetsnackTheme.colors`. `JetsnackTheme` still wraps `MaterialTheme` for typography and shapes but passes `debugColors()`, a `ColorScheme` with every role set to magenta, so any accidental `MaterialTheme.colorScheme` read is visible immediately.
- Shared element transitions across `NavHost` destinations. `SharedTransitionLayout` wraps the `NavHost`; a `composableWithCompositionLocal` helper provides the destination's `AnimatedVisibilityScope` through a `CompositionLocal`; list items and the detail screen call `sharedBounds` with a typed key (`snackId`, `origin`, `type`), a shared spring `BoundsTransform`, `OverlayClip` for animated corners, and `skipToLookaheadSize()` on text that must not stretch during the transition.
- Bottom bar enter/exit inside the shared transition: `renderInSharedTransitionScopeOverlay(zIndexInOverlay = 1f)` plus `animateEnterExit(slideInVertically/slideOutVertically)` so the bar slides away while the detail screen expands.
- A custom bottom navigation `Layout` where the selected item is twice as wide; per-item `Animatable` selection fractions drive the measure pass, and an indicator `Animatable` drives placement.
- Two named spring specs (`spatialExpressiveSpring()` with damping 0.8 and stiffness 380; `nonSpatialExpressiveSpring()` with damping 1 and stiffness 1600) reused for every motion in the app; this is what Material 3 1.4.0's `MotionScheme` formalizes.
- Cart rows: `AnimatedVisibility` wrapping `SwipeToDismissBox`, with `expandVertically`/`shrinkVertically` so a dismissed row collapses instead of popping.
- A collapsing header built with a custom `Layout` that reads a `scrollProvider: () -> Int` lambda in the measure pass, so scrolling invalidates layout only, not composition.
- `Modifier.blur` and `drawWithCache` gradient over a header image.

### Adopt

```kotlin
// Technique from android/compose-samples Jetsnack (Apache-2.0): poison the Material scheme so
// stray MaterialTheme.colorScheme reads are obvious in a custom design system.
fun poisonedColorScheme(marker: Color = Color.Magenta): ColorScheme =
    lightColorScheme(primary = marker, onPrimary = marker, surface = marker, onSurface = marker, /* every role */)
```

### Do not copy

- String routes with `"$route/{id}?origin={origin}"` and `navArgument`. Use `@Serializable` routes (Navigation 2.10.2) as in [../patterns/navigation.md](../patterns/navigation.md).
- `LocalSharedTransitionScope.current ?: throw IllegalStateException(...)` in every composable. Pass the scopes as parameters or provide them once at the `NavHost`; the pattern in [../patterns/ui/animation.md](../patterns/ui/animation.md) does the latter.
- Hand-rolled springs for every component when `MaterialTheme.motionScheme` exists in Material 3 1.4.0.
- In-memory `SnackRepo` object with no interface.

### Where this repository teaches it

| Technique | File |
|---|---|
| Custom design system via `CompositionLocal`, poisoned Material scheme | [../patterns/ui/material3-theming.md](../patterns/ui/material3-theming.md) ("A fully custom design system") |
| Shared bounds with `BoundsTransform`, overlay rendering, bottom bar enter/exit, `AnimatedVisibility` in lists | [../patterns/ui/animation.md](../patterns/ui/animation.md) ("Patterns from the Compose samples") |
| Scroll-provider lambdas in custom `Layout` | [../capabilities/compose-drawing-and-graphics/README.md](../capabilities/compose-drawing-and-graphics/README.md) |

## Jetchat

What it is: a chat UI with a conversation screen, a rich text input, emoji selector, profile screen, a Glance widget and a backdrop-blur modifier implemented as `Modifier.Node`.

### UI techniques demonstrated

- Keyboard-aware input. The `Scaffold` is given `contentWindowInsets = ScaffoldDefaults.contentWindowInsets.exclude(WindowInsets.navigationBars).exclude(WindowInsets.ime)` and the bottom input composable applies `Modifier.imePadding()` and `Modifier.navigationBarsPadding()` itself, so its background extends behind the navigation bar while content lifts above the keyboard.
- Jump-to-bottom button driven by `derivedStateOf { listState.firstVisibleItemIndex != 0 || listState.firstVisibleItemScrollOffset > thresholdPx }`, animated with `updateTransition` + `animateDp` into an `offset { }` lambda, and `animateScrollToItem(0)` on click. The list is `reverseLayout = true`, so index 0 is the newest message.
- `rememberUpdatedState(onPersonClick)` inside a `remember(text, ...)` block that builds an `AnnotatedString` with `LinkAnnotation.Clickable`, so the cached string keeps calling the latest callback.
- Markdown-lite formatter: a single `Regex` finds URLs, `@mentions`, `*bold*`, `_italic_`, `~strike~` and `` `code` `` tokens and emits `withLink(LinkAnnotation.Url(...))` or `LinkAnnotation.Clickable(...)` spans.
- A custom semantics property (`SemanticsPropertyKey<Boolean>("KeyboardShownKey")`) set on the text field so UI tests can assert keyboard state without reading insets.
- `Role.Image` with `contentDescription` on a custom icon composable, `focusRequester` + `focusTarget()` on the emoji panel so it can take focus from the text field.
- Message list items keyed by message id with `contentType` for headers vs messages.

### Adopt

```kotlin
// Technique from android/compose-samples Jetchat (Apache-2.0): let the input own the IME and
// navigation-bar insets; the Scaffold excludes them so nothing is padded twice.
Scaffold(
    bottomBar = { MessageInput(Modifier.imePadding().navigationBarsPadding()) },
    contentWindowInsets = ScaffoldDefaults.contentWindowInsets
        .exclude(WindowInsets.navigationBars)
        .exclude(WindowInsets.ime),
) { padding -> Messages(contentPadding = padding) }
```

### Do not copy

- `ConversationUiState` with `mutableStateListOf` inside a plain class owned by the Activity; the ViewModel should own messages as a `StateFlow<UiState>`.
- The backdrop blur and magnifier shader modifiers (AGSL, API 33+) are showcase effects with fallbacks; treat them as optional decoration.
- The widget and the video player are peripheral to the chat technique.

### Where this repository teaches it

| Technique | File |
|---|---|
| IME insets, `imePadding`, `imeNestedScroll`, jump-to-bottom | [../patterns/ui/animation.md](../patterns/ui/animation.md) ("Patterns from the Compose samples") |
| `LinkAnnotation.Clickable` with `rememberUpdatedState`, markdown-lite tokenizer | [../capabilities/rich-text-and-markdown/README.md](../capabilities/rich-text-and-markdown/README.md) |
| Custom semantics property for tests, `Role.Image` | [../patterns/ui/accessibility.md](../patterns/ui/accessibility.md) |
| `derivedStateOf` scroll threshold and `snapshotFlow` | [../docs/compose/state-and-side-effects.md](../docs/compose/state-and-side-effects.md), [../patterns/ui/compose-state.md](../patterns/ui/compose-state.md) |

## Jetcaster

What it is: a podcast player built as one Gradle project with `:core:data`, `:core:data-testing`, `:core:domain`, `:core:domain-testing`, `:core:designsystem`, `:mobile`, `:tv`, `:wear` and `:glancewidget`. Each form factor is its own application module on the shared core.

### UI techniques demonstrated

- Multi-form-factor module layout. The phone/tablet app (`:mobile`), the TV app (`:tv`) and the watch app (`:wear`) are separate `com.android.application` modules with the same `applicationId`, depending on the same data and domain modules. `:core:designsystem` holds colors, typography, keylines and the shared `PodcastImage` composable (Coil), and is consumed by every UI module including the Glance widget.
- `SupportingPaneScaffold` with a custom `PaneScaffoldDirective`. `:mobile` copies `calculatePaneScaffoldDirective` and forces one horizontal pane when either width or height is compact, two panes at expanded width, and uses `windowPosture.isTabletop` to add a vertical partition.
- TV: `androidx.tv.material3` components (`NavigationDrawer`, `NavigationDrawerItem`, `Card`, `StandardCardContainer`, `Button`), overscan-safe margins (48 dp horizontal, 24 dp vertical by default, encoded as a `data class` of `PaddingValues`), `focusRequester` + `focusRestorer()` on lists so focus returns to the last item, `focusProperties { onEnter = ... }` + `focusGroup()` on the drawer so entering it lands on the item for the current route, and `onKeyEvent` handling `Key.DirectionLeft`/`Key.DirectionRight` on a custom seek bar drawn with `drawWithCache`. The TV manifest declares `LEANBACK_LAUNCHER`, `android.software.leanback` not required, `android.hardware.touchscreen` not required, and an `android:banner`.
- Wear: Compose for Wear OS with Horologist media UI; this repository already has a Wear recipe, so Jetcaster's `:wear` is referenced only for module layout.
- Compose compiler stability configuration file at the root (`stability_config.conf`) shared by modules, plus `kotlinx.collections.immutable` lists in UI state.

### Do not copy

- Material 3 pinned to `1.5.0-alpha22` in Jetcaster's catalog. Stay on the BOM-managed 1.4.0.
- Kotlin 2.3.21 and AGP 9.2.1 (older than the shared catalog).
- Copying private `PaneScaffoldDirective` helpers out of the library. Prefer `calculatePaneScaffoldDirective(currentWindowAdaptiveInfo())` and adjust only `maxHorizontalPartitions` when needed.
- `Coil 2` in `:core:designsystem`; this repository uses Coil 3.

### Where this repository teaches it

| Technique | File |
|---|---|
| Multi-form-factor module layout | [../patterns/ui/adaptive-layouts.md](../patterns/ui/adaptive-layouts.md) ("Multi-form-factor module layout") |
| TV app module, focus, D-pad, overscan | [../capabilities/tv-and-large-screen-app/README.md](../capabilities/tv-and-large-screen-app/README.md) |
| Watch module | [../capabilities/wear-os-companion/README.md](../capabilities/wear-os-companion/README.md) (existing) |
| Shared design system module | `capabilities/design-system-module` (being written by another author; not linked until it lands) |

## JetLagged

What it is: a sleep and heart-rate dashboard whose charts are drawn by hand: a stepped sleep graph with animated corner radius, a smoothed heart-rate path with a variance band, a custom `Layout` with `ParentDataModifier` for the time axis, and animated backgrounds (bubbles on `Canvas`, AGSL `RuntimeShader` on API 33+ with a gradient fallback).

### UI techniques demonstrated

- `Modifier.drawWithCache`: build `Path`, `Brush`, `Stroke` and measured text once per size or state change, then `onDrawBehind { }` draws them per frame. Animated values (`animateFloat` progress, `animateDp` height) are read inside the cache block so a change re-runs only the draw phase.
- `Path` construction for data: `moveTo`, `lineTo`, `addRect`, `addRoundRect`; `clipPath` to mask a gradient-filled path to rounded bounds; `PathEffect.cornerPathEffect` animated from 0 to a radius; `rememberTextMeasurer()` + `drawText` to draw labels on the canvas.
- Custom `Layout` with `contents = listOf(...)` (multi-slot measure) and a `ParentDataModifier` (`Modifier.timeGraphBar(start, end, hours)`) that tells the parent each bar's horizontal fraction and offset.
- `graphicsLayer { translationX; scaleX/Y; shape; clip; shadowElevation }` for a drawer that scales the main content, driven by an `Animatable` plus `draggable`, decay (`rememberSplineBasedDecay`) and `PredictiveBackHandler`.
- A `DrawModifierNode` + `ModifierNodeElement` that owns a `RuntimeShader`, updates uniforms in `update`, and animates time with `withInfiniteAnimationFrameMillis` in `onAttach`.
- `rememberInfiniteTransition` driving several `Canvas` circles.

### Do not copy

- `remember { mutableStateOf(DrawerState.Closed) }` for the drawer (not saveable across configuration change).
- `WindowWidthSizeClass` from `material3-window-size-class`; use `androidx.window.core.layout.WindowSizeClass` through `currentWindowAdaptiveInfo()`.
- Random bubble positions generated in `remember` without a seed; previews and screenshot tests become nondeterministic.
- Per-bubble `Canvas` composables; one `Canvas` drawing all circles is cheaper.

### Where this repository teaches it

| Technique | File |
|---|---|
| `Canvas`, `Path`, `drawWithCache`, `Brush`, `graphicsLayer`, custom layout modifiers, shaders | [../capabilities/compose-drawing-and-graphics/README.md](../capabilities/compose-drawing-and-graphics/README.md) |
| Animated paths and drawing in animation | [../patterns/ui/animation.md](../patterns/ui/animation.md) ("Patterns from the Compose samples") |

## Reply

What it is: an email client built to show adaptive navigation and the Material 3 color system with contrast levels.

### UI techniques demonstrated

- Navigation suite selection by window class and posture. Reply decides a `NavigationSuiteType` itself: bottom bar when tabletop or when either dimension is compact, permanent drawer when width is expanded and at least 1200 dp, rail otherwise; then uses `NavigationSuiteScaffoldLayout(layoutType = ...)` with its own bar, rail and drawer composables. The rail header is centered or top-aligned depending on height class. The modal drawer's `gesturesEnabled` is `drawerState.isOpen || navLayoutType == NavigationRail` so a swipe cannot open it when a permanent drawer or bottom bar is shown; `BackHandler(enabled = drawerState.isOpen)` closes it.
- Content type (single vs dual pane) from `WindowWidthSizeClass` plus fold posture: medium width gets two panes only when the device is a half-opened book, expanded always gets two.
- List and detail selection is ViewModel state (`openedEmail`, `isDetailOnlyOpen`), with a `LaunchedEffect(contentType)` that closes the detail when the window shrinks to single pane. This is the pre-`ListDetailPaneScaffold` approach; the sample still uses Accompanist `TwoPane` for the dual layout.
- Contrast-aware theme. Material Theme Builder exports standard, medium-contrast and high-contrast light and dark schemes; `selectSchemeForContrast` reads `UiModeManager.contrast` (API 34+) and picks the scheme by range (0 to 0.33 standard, 0.34 to 0.66 medium, 0.67 to 1 high), skipping the lookup in `LocalInspectionMode`. Dynamic color stays an opt-in parameter that bypasses contrast schemes.
- `Modifier.semantics { selected = isSelected }` on email rows in multi-select mode.
- `ExtendedFloatingActionButton(expanded = listState.lastScrolledBackward || !listState.canScrollBackward)` collapses the FAB while scrolling down.

### Do not copy

- `com.google.accompanist:accompanist-adaptive` `TwoPane` and `calculateDisplayFeatures`. Accompanist adaptive is in maintenance; `ListDetailPaneScaffold` with `rememberListDetailPaneScaffoldNavigator` and `currentWindowAdaptiveInfo().windowPosture` cover the same ground.
- `calculateWindowSizeClass(activity)` from `material3-window-size-class`; use `currentWindowAdaptiveInfo()`.
- Mapping `NavigationSuiteType` to an app-specific enum and back; use the type directly.

### Where this repository teaches it

| Technique | File |
|---|---|
| Navigation suite by window class and posture, drawer gesture rules | [../patterns/ui/adaptive-layouts.md](../patterns/ui/adaptive-layouts.md) ("Choosing the navigation suite yourself") |
| Contrast-level color schemes with dynamic color | [../patterns/ui/material3-theming.md](../patterns/ui/material3-theming.md) ("Dynamic color and contrast levels") |
| `selected` semantics in multi-select lists | [../patterns/ui/accessibility.md](../patterns/ui/accessibility.md) |

## Techniques skipped

- JetNews's custom Navigation 3 `Scene`/`SceneStrategy`: the API is at 1.2.0 and the scene strategy surface is large; the repository documents Navigation 3 back stacks and leaves custom scenes to the official guide.
- Jetchat's backdrop blur and magnifier (`RenderEffect`/AGSL `Modifier.Node`): decorative and API-gated; the drawing capability shows the node-based shader pattern once and stops there.
- Jetcaster's Horologist media UI for Wear: library-specific; `wear-os-companion` already covers the module.
- JetLagged's `PredictiveBackHandler` drawer with decay physics: the drawer is better served by Material's `ModalNavigationDrawer`; only the `graphicsLayer` scaling is reused.
- Glance widgets in JetNews, Jetsnack and Jetchat: `home-screen-widget` already covers Glance.

## Verify

To re-check this study against a fresh checkout:

```sh
git clone --depth 1 https://github.com/android/compose-samples /tmp/samples/compose-samples
grep -E '^(androidGradlePlugin|kotlin|androidx-compose-bom|androidx-navigation|androidx-navigation3|targetSdk|compileSdk)' /tmp/samples/compose-samples/JetNews/gradle/libs.versions.toml
diff /tmp/samples/compose-samples/JetNews/gradle/libs.versions.toml /tmp/samples/compose-samples/Jetcaster/gradle/libs.versions.toml
```

Then compare with `data/versions.json`. None of the sample code was built in this repository; the techniques were inspected in source and re-implemented in the files listed above, each of which has its own `## Verify`.

## Attribution

Studied: `android/compose-samples` (JetNews, Jetsnack, Jetchat, Jetcaster, JetLagged, Reply), https://github.com/android/compose-samples, licensed under the Apache License, Version 2.0. The Kotlin and Gradle code in this repository is an original re-implementation of the techniques in the `com.example.app` placeholder package; short excerpts, where present, are marked inline with a `Technique from android/compose-samples` comment. Sample assets, strings and branding were not copied.

## Sources

- https://github.com/android/compose-samples
- https://developer.android.com/develop/ui/compose/layouts/adaptive
- https://developer.android.com/develop/ui/compose/animation/shared-elements
- https://developer.android.com/develop/ui/compose/designsystems/custom
- https://developer.android.com/develop/ui/compose/graphics/draw/overview
- https://developer.android.com/develop/ui/compose/text/user-interactions
- https://developer.android.com/training/tv/playback/compose
- https://developer.android.com/develop/ui/compose/layouts/insets
