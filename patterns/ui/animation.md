# Animation in Compose

Compose animations are driven by state: you declare the target, the runtime interpolates. Pick the API by what changes: a single value, visibility, content swap, several coordinated values, or an element moving between screens. All examples assume Compose BOM 2026.09.00 and Material 3 1.4.0.

## animate*AsState: one value

The simplest API. Give it a target; it animates whenever the target changes and the composable recomposes with the current frame value.

```kotlin
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween

@Composable
fun ExpandableCard(expanded: Boolean, onToggle: () -> Unit, content: @Composable () -> Unit) {
    val rotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = tween(durationMillis = 200),
        label = "chevron",
    )
    val elevation by animateDpAsState(if (expanded) 8.dp else 1.dp, label = "elevation")
    val container by animateColorAsState(
        if (expanded) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
        label = "container",
    )

    Card(onClick = onToggle, colors = CardDefaults.cardColors(containerColor = container),
         elevation = CardDefaults.cardElevation(defaultElevation = elevation)) {
        Row { Text("Details"); Icon(Icons.Filled.ExpandMore, null, Modifier.rotate(rotation)) }
        if (expanded) content()
    }
}
```

The `label` parameter names the animation in Android Studio's animation inspector; always set it. Use `spring()` for motion that responds to user input (drag release, toggle) and `tween` for fixed-duration transitions. Read animated values as late as possible (`Modifier.graphicsLayer { rotationZ = rotation }` instead of `Modifier.rotate(rotation)`) when the animation runs every frame, to skip recomposition (see [compose-state.md](compose-state.md)).

## AnimatedVisibility: enter and exit

```kotlin
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically

AnimatedVisibility(
    visible = showBanner,
    enter = fadeIn() + expandVertically(expandFrom = Alignment.Top),
    exit = fadeOut() + shrinkVertically(shrinkTowards = Alignment.Top),
) {
    OfflineBanner()
}
```

Unlike `if (showBanner) OfflineBanner()`, the content stays in composition during the exit animation. Inside a `LazyColumn`, use `Modifier.animateItem()` on each item instead; it animates placement, appearance and removal and needs stable keys.

```kotlin
items(todos, key = { it.id }) { todo ->
    TodoRow(todo, modifier = Modifier.animateItem())
}
```

## AnimatedContent: swap between states

For content that changes shape or identity (a counter, loading to loaded, a step in a wizard).

```kotlin
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith

AnimatedContent(
    targetState = count,
    transitionSpec = {
        if (targetState > initialState) {
            slideInVertically { it } + fadeIn() togetherWith slideOutVertically { -it } + fadeOut()
        } else {
            slideInVertically { -it } + fadeIn() togetherWith slideOutVertically { it } + fadeOut()
        }.using(SizeTransform(clip = false))
    },
    label = "counter",
) { value ->
    Text("$value", style = MaterialTheme.typography.displayMedium)
}
```

Use it for `UiState.Content` transitions too, keyed on the sealed type so Loading, Error and Success cross-fade rather than pop:

```kotlin
AnimatedContent(targetState = state.content, contentKey = { it::class }, label = "content") { content ->
    when (content) { ... }
}
```

`contentKey` prevents a new `Success` instance (a list update) from re-running the transition. `Crossfade` is the simpler cousin when a fade is all you need.

## updateTransition: several values together

When multiple properties must animate in lockstep from one state, create one `Transition` and derive each value from it. They share timing and can be inspected together.

```kotlin
import androidx.compose.animation.core.animateDp
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.updateTransition

enum class SheetState { Collapsed, Expanded }

@Composable
fun BottomSheetHandle(state: SheetState) {
    val transition = updateTransition(targetState = state, label = "sheet")
    val height by transition.animateDp(label = "height") { if (it == SheetState.Expanded) 400.dp else 80.dp }
    val alpha by transition.animateFloat(label = "alpha") { if (it == SheetState.Expanded) 1f else 0.6f }
    val corner by transition.animateDp(label = "corner") { if (it == SheetState.Expanded) 0.dp else 24.dp }

    Surface(
        Modifier.fillMaxWidth().height(height).graphicsLayer { this.alpha = alpha },
        shape = RoundedCornerShape(topStart = corner, topEnd = corner),
    ) { ... }
}
```

`transition.isRunning` and `transition.currentState` tell you where the animation is, which is what a drag gesture handler needs to decide whether to interrupt. For gesture-driven motion use `Animatable` with `animateTo`/`snapTo` from a coroutine, and `AnchoredDraggable` for snap points.

## Shared element transitions

Shared elements animate a composable from its bounds on one screen to its bounds on the next. The APIs are in `androidx.compose.animation` and work with Navigation Compose and `AnimatedContent`.

```kotlin
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SharedTransitionScope

@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun AppNavHost(navController: NavHostController) {
    SharedTransitionLayout {
        NavHost(navController, startDestination = Home) {
            composable<Home> {
                HomeScreen(
                    sharedTransitionScope = this@SharedTransitionLayout,
                    animatedVisibilityScope = this@composable,
                    onOpen = { id -> navController.navigate(TodoDetail(id)) },
                )
            }
            composable<TodoDetail> { entry ->
                DetailScreen(
                    id = entry.toRoute<TodoDetail>().todoId,
                    sharedTransitionScope = this@SharedTransitionLayout,
                    animatedVisibilityScope = this@composable,
                )
            }
        }
    }
}

@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun TodoThumbnail(
    id: String,
    url: String,
    sharedTransitionScope: SharedTransitionScope,
    animatedVisibilityScope: AnimatedVisibilityScope,
) {
    with(sharedTransitionScope) {
        AsyncImage(
            model = url,
            contentDescription = null,
            modifier = Modifier
                .sharedElement(
                    sharedContentState = rememberSharedContentState(key = "image-$id"),
                    animatedVisibilityScope = animatedVisibilityScope,
                )
                .size(64.dp),
        )
    }
}
```

The same `key` on both screens links the two composables. Use `sharedBounds` instead of `sharedElement` when the content differs between screens (a title that changes style) and only the container should morph. Passing the scopes as parameters rather than reading `LocalSharedTransitionScope` keeps the composables explicit; either works. The API is still `@ExperimentalSharedTransitionApi` in this BOM; check the annotation after upgrades.

## Material motion and MotionScheme

Material 3 1.4.0 introduces `MotionScheme` as part of the Expressive update. A motion scheme defines spring specs for "fast spatial", "default spatial", "slow spatial" and the matching "effects" (non-spatial) categories. Components read it from `MaterialTheme.motionScheme`; your animations can too, so they match the system components.

```kotlin
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
val spec = MaterialTheme.motionScheme.defaultSpatialSpec<Float>()
val offset by animateFloatAsState(if (open) 0f else -200f, animationSpec = spec, label = "drawer")
```

`MotionScheme.standard()` is close to the earlier Material 3 tweens; `MotionScheme.expressive()` is bouncier. Set it on `MaterialExpressiveTheme` (see [material3-theming.md](material3-theming.md)). The property is marked `@ExperimentalMaterial3ExpressiveApi` in 1.4.0; verify before depending on it in a library module.

## Respecting reduced motion

Read the animator duration scale once per composition and choose `snap()` or a shortened spec when it is 0. `rememberReduceMotion()` from [accessibility.md](accessibility.md) encapsulates this.

```kotlin
val reduceMotion = rememberReduceMotion()

AnimatedVisibility(
    visible = showBanner,
    enter = if (reduceMotion) EnterTransition.None else fadeIn() + expandVertically(),
    exit = if (reduceMotion) ExitTransition.None else fadeOut() + shrinkVertically(),
) { OfflineBanner() }
```

Rules:

- State changes must be understandable without motion. If an animation is the only cue (an item "flying" into the cart), add a text or icon change too.
- No infinite animations that cannot be paused when reduce motion is on; `rememberInfiniteTransition` is fine for a loading indicator, not for decoration.
- Keep parallax and large-scale movement out when reduce motion is on.

Note that when the system animator scale is 0, Compose animations still run (they use their own clock), which is why you must check the setting yourself. Compose UI tests set `mainClock.autoAdvance = false` or use the test rule's clock to complete animations deterministically; see [../testing/compose-ui-testing.md](../testing/compose-ui-testing.md).

## Performance notes

- Animations that run every frame should write to `graphicsLayer`, `offset { }`, `drawBehind` or `Modifier.layout` lambdas so only the draw or layout phase runs.
- Do not allocate inside `transitionSpec` or per-frame lambdas.
- `AnimatedVisibility` and `AnimatedContent` keep both old and new content composed during the transition; heavy screens should key `AnimatedContent` on a small value and load data outside it.
- Use the Animation Preview in Android Studio (the clock icon on a `@Preview`) to scrub transitions without a device.

## Patterns from the Compose samples

Four motion patterns studied in `android/compose-samples` ([../../references/compose-samples.md](../../references/compose-samples.md)) and re-implemented here.

### Animated custom drawing (JetLagged)

A chart that expands on tap: the bar height and a progress fraction come from one `updateTransition`; the `Path`, `Brush` and `Stroke` are built in `drawWithCache` and only redrawn when the animated values change. Reading the animated values inside `drawWithCache` keeps the work in the draw phase; the composable itself does not recompose per frame.

```kotlin
package com.example.app.ui.chart

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDp
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.updateTransition
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp

/** One segment of a stacked timeline: a fraction of the total width and a lane index 0..lanes-1. */
data class Segment(val startFraction: Float, val widthFraction: Float, val lane: Int)

@Composable
fun ExpandingTimeline(segments: List<Segment>, lanes: Int, colors: List<Color>, modifier: Modifier = Modifier) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val transition = updateTransition(targetState = expanded, label = "timeline")
    val bouncy = spring<Float>(dampingRatio = Spring.DampingRatioLowBouncy, stiffness = Spring.StiffnessLow)

    val height by transition.animateDp(label = "height", transitionSpec = { spring(Spring.DampingRatioLowBouncy, Spring.StiffnessLow) }) {
        if (it) 96.dp else 24.dp
    }
    val progress by transition.animateFloat(label = "progress", transitionSpec = { bouncy }) { if (it) 1f else 0f }

    Spacer(
        modifier
            .fillMaxWidth()
            .height(height)
            .clickable { expanded = !expanded }
            .drawWithCache {
                // Everything here re-runs only when size, progress or the inputs change.
                val laneHeight = size.height / lanes
                val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, pathEffect = PathEffect.cornerPathEffect(8.dp.toPx() * progress))
                val clip = Path().apply {
                    addRoundRect(RoundRect(Rect(0f, 0f, size.width, size.height), CornerRadius(lerp(12.dp.toPx(), 4.dp.toPx(), progress))))
                }
                val graph = Path().apply {
                    segments.forEachIndexed { index, segment ->
                        val x = segment.startFraction * size.width
                        val w = segment.widthFraction * size.width
                        // Collapsed: every segment sits in lane 0. Expanded: in its own lane.
                        val y = lerp(0f, segment.lane * laneHeight, progress)
                        if (index > 0) lineTo(x, y + laneHeight / 2f)
                        addRect(Rect(offset = Offset(x, y), size = Size(w, laneHeight)))
                        moveTo(x + w, y + laneHeight / 2f)
                    }
                }
                val brush = Brush.verticalGradient(colors, startY = 0f, endY = size.height)
                onDrawBehind {
                    clipPath(clip) {
                        drawPath(graph, brush)
                        drawPath(graph, brush, style = stroke)
                    }
                }
            },
    )
}
```

The full drawing toolkit (text on canvas, `graphicsLayer`, custom layout modifiers, shaders) is in [../../capabilities/compose-drawing-and-graphics/README.md](../../capabilities/compose-drawing-and-graphics/README.md).

### Shared bounds, bottom bar and list animations (Jetsnack)

Jetsnack extends the shared element pattern above in three ways worth keeping.

One `BoundsTransform` and two springs for the whole app, so every transition has the same feel. Material 3 1.4.0's `MotionScheme` is the themed equivalent; until the project opts into Expressive, define them once:

```kotlin
package com.example.app.ui.motion

import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.core.spring

// Technique from android/compose-samples Jetsnack (Apache-2.0): spatial motion is slightly
// underdamped, non-spatial (fades) is critically damped and fast.
fun <T> spatialSpring() = spring<T>(dampingRatio = 0.8f, stiffness = 380f)
fun <T> effectsSpring() = spring<T>(dampingRatio = 1f, stiffness = 1600f)

@OptIn(ExperimentalSharedTransitionApi::class)
val AppBoundsTransform = BoundsTransform { _, _ -> spatialSpring() }
```

`sharedBounds` for containers whose content differs between screens, with an animated corner clip and text that must not stretch:

```kotlin
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun ProductDetailContainer(
    productId: String,
    sharedTransitionScope: SharedTransitionScope,
    animatedVisibilityScope: AnimatedVisibilityScope,
    content: @Composable () -> Unit,
) {
    // Corners are round while the card is small and square once it fills the screen.
    val corner by animatedVisibilityScope.transition.animateDp(label = "corner") { state ->
        if (state == EnterExitState.Visible) 0.dp else 20.dp
    }
    with(sharedTransitionScope) {
        Box(
            Modifier
                .clip(RoundedCornerShape(corner))
                .sharedBounds(
                    sharedContentState = rememberSharedContentState(key = "product-$productId-bounds"),
                    animatedVisibilityScope = animatedVisibilityScope,
                    boundsTransform = AppBoundsTransform,
                    clipInOverlayDuringTransition = OverlayClip(RoundedCornerShape(corner)),
                    enter = fadeIn(effectsSpring()),
                    exit = fadeOut(effectsSpring()),
                )
                .fillMaxSize(),
        ) {
            // Text inside a growing container: measure at the final size so it does not
            // reflow on every frame.
            Column(Modifier.skipToLookaheadSize()) { content() }
        }
    }
}
```

Give each shared element a typed key (`data class SharedKey(val id: String, val origin: String, val part: Part)`) when the same item can appear in several lists on the origin screen; a plain `"image-$id"` string collides when the item is in two carousels.

A bottom bar that slides out while the detail opens, rendered above the transition overlay so the expanding card does not cover it:

```kotlin
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun HomeBottomBar(sharedTransitionScope: SharedTransitionScope, animatedVisibilityScope: AnimatedVisibilityScope) {
    with(sharedTransitionScope) {
        with(animatedVisibilityScope) {
            NavigationBar(
                modifier = Modifier
                    .renderInSharedTransitionScopeOverlay(zIndexInOverlay = 1f)
                    .animateEnterExit(
                        enter = fadeIn(effectsSpring()) + slideInVertically(spatialSpring()) { it },
                        exit = fadeOut(effectsSpring()) + slideOutVertically(spatialSpring()) { it },
                    ),
            ) { /* items */ }
        }
    }
}
```

`AnimatedVisibility` in a list wrapping `SwipeToDismissBox`, so a dismissed row shrinks instead of disappearing on the next recomposition. Combine with `Modifier.animateItem()` for the rows that move up:

```kotlin
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DismissibleRow(onDismissed: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val dismissState = rememberSwipeToDismissBoxState()
    val dismissed = dismissState.currentValue == SwipeToDismissBoxValue.EndToStart
    LaunchedEffect(dismissed) { if (dismissed) onDismissed() }   // tell the ViewModel after the gesture settles

    AnimatedVisibility(visible = !dismissed, enter = expandVertically(), exit = shrinkVertically(), modifier = modifier) {
        SwipeToDismissBox(
            state = dismissState,
            enableDismissFromStartToEnd = false,
            backgroundContent = { DismissBackground(progress = dismissState.progress) },
            content = { content() },
        )
    }
}

// In the list:
items(cart, key = { it.id }) { line ->
    DismissibleRow(onDismissed = { onRemove(line.id) }, modifier = Modifier.animateItem()) { CartLine(line) }
}
```

### Jump-to-bottom and keyboard-aware input (Jetchat)

A reversed message list (`reverseLayout = true`, newest at index 0) with a button that appears once the user has scrolled away from the bottom, and an input bar that rises with the keyboard while its background still extends behind the navigation bar.

```kotlin
package com.example.app.ui.chat

import androidx.compose.animation.core.animateDp
import androidx.compose.animation.core.updateTransition
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScaffoldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
fun ChatScreen(messages: List<Message>, onSend: (String) -> Unit) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    Scaffold(
        bottomBar = {
            MessageInput(
                onSend = { text ->
                    onSend(text)
                    scope.launch { listState.scrollToItem(0) }
                },
                // The input owns the IME and navigation-bar insets so its surface color extends
                // behind the navigation bar and the whole bar lifts with the keyboard.
                modifier = Modifier.imePadding().navigationBarsPadding(),
            )
        },
        // Technique from android/compose-samples Jetchat (Apache-2.0): exclude what the input
        // pads itself, or the content is padded twice.
        contentWindowInsets = ScaffoldDefaults.contentWindowInsets
            .exclude(WindowInsets.navigationBars)
            .exclude(WindowInsets.ime),
    ) { padding ->
        Box(Modifier.fillMaxSize()) {
            LazyColumn(state = listState, reverseLayout = true, contentPadding = padding, modifier = Modifier.fillMaxSize()) {
                items(messages, key = { it.id }, contentType = { "message" }) { MessageBubble(it) }
            }

            val thresholdPx = with(LocalDensity.current) { 56.dp.toPx() }
            // Flips rarely; the list state changes on every scrolled pixel.
            val showJump by remember {
                derivedStateOf { listState.firstVisibleItemIndex != 0 || listState.firstVisibleItemScrollOffset > thresholdPx }
            }
            JumpToBottom(
                visible = showJump,
                onClick = { scope.launch { listState.animateScrollToItem(0) } },
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = padding.calculateBottomPadding()),
            )
        }
    }
}

@Composable
fun JumpToBottom(visible: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val transition = updateTransition(visible, label = "jumpToBottom")
    val offset by transition.animateDp(label = "offset") { if (it) 24.dp else (-40).dp }
    if (offset > (-40).dp) {   // keep it composed until fully off-screen so the exit animates
        ExtendedFloatingActionButton(
            text = { Text("Jump to bottom") },
            icon = { Icon(Icons.Filled.ArrowDownward, contentDescription = null) },
            onClick = onClick,
            modifier = modifier.offset { IntOffset(x = 0, y = -offset.roundToPx()) },   // layout phase only
        )
    }
}
```

Two related APIs:

- `Modifier.imeNestedScroll()` (`androidx.compose.foundation.layout`, `@ExperimentalLayoutApi`) on the scrollable list lets an overscroll at the bottom drag the keyboard open or closed on API 30+. Add it only to the list, not to the input.
- `WindowInsets.isImeVisible` plus `LaunchedEffect` to scroll to the newest message when the keyboard opens, if the product wants that; most chat apps do not.

Insets fundamentals are in [../../docs/android/edge-to-edge-and-insets.md](../../docs/android/edge-to-edge-and-insets.md).

## Avoid

```kotlin
// Anti-pattern: animating with a coroutine loop and delay(16).
LaunchedEffect(Unit) { while (true) { x += 1f; delay(16) } }

// Anti-pattern: no label; impossible to find in the inspector.
animateFloatAsState(target)

// Anti-pattern: if/else instead of AnimatedVisibility for content that should exit smoothly.
if (visible) Banner()

// Anti-pattern: AnimatedContent keyed on a data class that changes every emission.
AnimatedContent(targetState = uiState) { ... }   // re-runs the transition on every list update

// Anti-pattern: a sharedElement key that is the same for every list item.
rememberSharedContentState(key = "image")
```

## Verify

```sh
./gradlew :app:assembleDebug
adb shell settings put global animator_duration_scale 0   # confirm reduce-motion branches
adb shell settings put global animator_duration_scale 1
```

Record the screen with "Profile GPU rendering" on and confirm no frames over 16 ms during the transition; Macrobenchmark `FrameTimingMetric` (see [../../checklists/performance.md](../../checklists/performance.md)) gives numbers for CI.

## Sources

- https://developer.android.com/develop/ui/compose/animation/introduction
- https://developer.android.com/develop/ui/compose/animation/choose-api
- https://developer.android.com/develop/ui/compose/animation/composables-modifiers
- https://developer.android.com/develop/ui/compose/animation/shared-elements
- https://developer.android.com/develop/ui/compose/animation/customize
- https://developer.android.com/develop/ui/compose/animation/tooling
- https://m3.material.io/styles/motion/overview
- https://developer.android.com/jetpack/androidx/releases/compose-material3
- https://developer.android.com/develop/ui/compose/graphics/draw/modifiers
- https://developer.android.com/develop/ui/compose/layouts/insets
- https://github.com/android/compose-samples (JetLagged, Jetsnack, Jetchat; see [../../references/compose-samples.md](../../references/compose-samples.md))
