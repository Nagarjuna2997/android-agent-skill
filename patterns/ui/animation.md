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
