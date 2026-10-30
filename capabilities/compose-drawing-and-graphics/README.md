# Compose drawing and graphics

Custom drawing in Compose: `Canvas` and the draw modifiers, `Path` for data-driven shapes, `drawWithCache` to build paths and brushes once, `Brush` gradients, `graphicsLayer` for transforms that skip recomposition, a custom `Layout` with a parent-data modifier, and a `Modifier.Node` that owns an AGSL shader. Distilled from JetLagged (sleep and heart-rate charts, animated backgrounds, scaling drawer) and Jetsnack (collapsing header) in `android/compose-samples`; the code here is an original re-implementation.

## When to use

- Charts, graphs, progress rings, waveforms, sparkline backgrounds, custom shapes and decorative gradients that Material components do not provide.
- Any visual that must animate every frame: draw it in the draw phase so recomposition is not involved.
- Not for standard components with a custom color (use theming), not for images (use [image-loading](../image-loading/README.md)), and not for complex interactive diagrams where a dedicated charting library already exists in the project. Draw by hand when the chart is specific to the product and small enough to own.

## Dependencies

Compose only. `Canvas`, `drawWithCache`, `drawBehind`, `graphicsLayer` and `Path` are in `androidx.compose.ui:ui` and `androidx.compose.foundation:foundation`; `rememberTextMeasurer` and `drawText` are in `androidx.compose.ui:ui-text`.

```kotlin
dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui-text")
    implementation("androidx.compose.animation:animation")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
```

## Manifest and permissions

None. `RuntimeShader` (AGSL) needs API 33; gate it with `Build.VERSION.SDK_INT` and provide a fallback, as shown below.

## Implementation

### Choosing the drawing entry point

| Need | Use |
|---|---|
| A composable that is only a drawing | `Canvas(modifier) { ... }` (a `Spacer` with `drawBehind`) |
| Draw under or over existing content | `Modifier.drawBehind { }` / `Modifier.drawWithContent { drawContent(); ... }` |
| Expensive setup (paths, brushes, measured text) reused across frames | `Modifier.drawWithCache { ...; onDrawBehind { } }` |
| Transform, alpha, clip, shadow without recomposition | `Modifier.graphicsLayer { }` |
| Measure children by data (bar widths from durations) | custom `Layout` with a `ParentDataModifier` |
| A reusable modifier with its own state and animation loop | `Modifier.Node` + `ModifierNodeElement` |

Rules: read animated or scroll state inside the draw or layer lambda, not in the composable body; allocate `Path`, `Paint`, `Brush` in `drawWithCache` or `remember`, never per frame; use `size` from the scope instead of measuring the composable yourself.

### A data path with drawWithCache

A smoothed line chart with a filled variance band. Inputs change rarely (new data), size changes on rotation; both re-run the cache block. Frames in between only run `onDrawBehind`.

```kotlin
package com.example.app.ui.chart

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp

/** One sample: x in [0, 1] across the chart, min/avg/max in data units. */
data class Sample(val x: Float, val min: Float, val avg: Float, val max: Float)

@Composable
fun RangeLineChart(samples: List<Sample>, lineColors: List<Color>, bandColor: Color, modifier: Modifier = Modifier) {
    require(lineColors.size >= 2) { "A gradient needs at least two colors" }
    Box(
        modifier
            .fillMaxSize()
            .drawWithCache {
                val (line, band) = buildPaths(samples, size)
                val lineBrush = Brush.verticalGradient(lineColors)
                val stroke = Stroke(width = 2.dp.toPx())
                onDrawBehind {
                    drawPath(band, bandColor, style = Fill)
                    drawPath(line, lineBrush, style = stroke)
                }
            },
    )
}

/** Pure function, unit-testable: data in, two paths out. */
internal fun buildPaths(samples: List<Sample>, size: Size): Pair<Path, Path> {
    val line = Path()
    val band = Path()
    if (samples.isEmpty()) return line to band
    val top = samples.maxOf { it.max }
    val bottom = samples.minOf { it.min }
    val range = (top - bottom).takeIf { it > 0f } ?: 1f
    fun y(v: Float) = size.height - (v - bottom) / range * size.height

    var prev = Offset(samples.first().x * size.width, y(samples.first().avg))
    line.moveTo(prev.x, prev.y)
    band.moveTo(prev.x, y(samples.first().max))
    for (s in samples.drop(1)) {
        val next = Offset(s.x * size.width, y(s.avg))
        // Cubic through the midpoint gives a smooth curve without overshoot.
        val midX = (prev.x + next.x) / 2f
        line.cubicTo(midX, prev.y, midX, next.y, next.x, next.y)
        band.lineTo(next.x, y(s.max))
        prev = next
    }
    for (s in samples.asReversed()) band.lineTo(s.x * size.width, y(s.min))
    band.close()
    return line to band
}
```

Add a `drawText` label with `rememberTextMeasurer()`: measure in the cache block (`val label = textMeasurer.measure(AnnotatedString("72 bpm"), style)`), draw with `drawText(label, topLeft = ...)` in `onDrawBehind`. Pass the measurer in from the composable (`val textMeasurer = rememberTextMeasurer()`) because `drawWithCache` is not composable.

### Animated shape with clipPath and PathEffect

JetLagged's sleep bar morphs between a single line and stacked lanes. The pattern: one `Transition` provides height and a progress fraction; `drawWithCache` reads the fraction so the cache invalidates per frame during the animation only, and `clipPath` masks a gradient fill to a rounded rect whose radius is also animated. The full composable is in [../../patterns/ui/animation.md](../../patterns/ui/animation.md) ("Animated custom drawing"); the drawing-specific parts:

```kotlin
.drawWithCache {
    val clip = Path().apply { addRoundRect(RoundRect(Rect(Offset.Zero, size), CornerRadius(lerp(12.dp.toPx(), 4.dp.toPx(), progress)))) }
    val stroke = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round, pathEffect = PathEffect.cornerPathEffect(8.dp.toPx() * progress))
    val graph = buildStepPath(segments, size, progress)
    val brush = Brush.verticalGradient(colors)
    onDrawBehind {
        clipPath(clip) {
            drawPath(graph, brush)
            drawPath(graph, brush, style = stroke)
        }
    }
}
```

`PathEffect.cornerPathEffect(radius)` rounds every corner of the stroke; `PathEffect.dashPathEffect(floatArrayOf(on, off), phase)` with an animated `phase` makes a marching-ants outline.

### graphicsLayer for transforms

A content panel that slides, scales and rounds its corners as a drawer opens. The `Animatable` is read inside the `graphicsLayer` lambda, so the composable does not recompose; only the layer properties update.

```kotlin
package com.example.app.ui.shell

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.util.lerp

@Composable
fun ScalingContent(openFraction: Animatable<Float, *>, content: @Composable () -> Unit) {
    val drawerWidthPx = with(LocalDensity.current) { 280.dp.toPx() }
    val maxCornerPx = with(LocalDensity.current) { 32.dp.toPx() }
    Box(
        Modifier.graphicsLayer {
            val f = openFraction.value              // read here: layer-only invalidation
            translationX = f * drawerWidthPx
            val scale = lerp(1f, 0.85f, f)
            scaleX = scale
            scaleY = scale
            shape = RoundedCornerShape(lerp(0f, maxCornerPx, f))
            clip = true
            shadowElevation = lerp(0f, 24f, f)
        },
    ) { content() }
}
```

Other layer uses: `alpha` for fades (cheaper than `Modifier.alpha` when animated), `rotationZ` for spinners, `compositingStrategy = CompositingStrategy.Offscreen` when drawing with `BlendMode` so the blend applies to the layer rather than the window, and `renderEffect = BlurEffect(...)` on API 31+.

### Scroll-driven drawing without recomposition

Pass a `() -> Float` provider instead of a value when the consumer is a draw or layout lambda. Jetsnack's collapsing header uses this to shrink an image with scroll:

```kotlin
@Composable
fun CollapsingHeaderImage(scrollProvider: () -> Int, collapseRangePx: Float, content: @Composable () -> Unit) {
    val fraction = { (scrollProvider() / collapseRangePx).coerceIn(0f, 1f) }
    Box(
        Modifier.graphicsLayer {
            val f = fraction()
            val scale = lerp(1f, 0.4f, f)
            scaleX = scale
            scaleY = scale
            translationY = -f * collapseRangePx / 2f
        },
    ) { content() }
}

// Caller:
val scrollState = rememberScrollState()
CollapsingHeaderImage(scrollProvider = { scrollState.value }, collapseRangePx = rangePx) { HeroImage() }
```

Had `scrollState.value` been read in the composable body, every scrolled pixel would recompose the header.

### Custom Layout with a parent-data modifier

A timeline where each bar's width and offset come from its data. Children declare their data through a modifier; the parent reads it in measure. This is the Compose equivalent of layout params.

```kotlin
package com.example.app.ui.chart

import androidx.compose.foundation.layout.LayoutScopeMarker
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.ParentDataModifier
import androidx.compose.ui.unit.Density
import kotlin.math.roundToInt

@Immutable
private class BarData(val startFraction: Float, val widthFraction: Float) : ParentDataModifier {
    override fun Density.modifyParentData(parentData: Any?) = this@BarData
}

@LayoutScopeMarker
@Immutable
object TimelineScope {
    /** Both fractions are of the full row width, in [0, 1]. */
    @Stable
    fun Modifier.timelineBar(startFraction: Float, widthFraction: Float): Modifier =
        this.then(BarData(startFraction, widthFraction))
}

@Composable
fun Timeline(
    rowCount: Int,
    label: @Composable (row: Int) -> Unit,
    bar: @Composable TimelineScope.(row: Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val labels = @Composable { repeat(rowCount) { label(it) } }
    val bars = @Composable { repeat(rowCount) { TimelineScope.bar(it) } }
    Layout(contents = listOf(labels, bars), modifier = modifier) { (labelMeasurables, barMeasurables), constraints ->
        val labelPlaceables = labelMeasurables.map { it.measure(constraints.copy(minWidth = 0)) }
        val labelWidth = labelPlaceables.maxOf { it.width }
        val trackWidth = constraints.maxWidth - labelWidth
        var height = 0
        val barPlaceables = barMeasurables.map { m ->
            val data = m.parentData as? BarData ?: error("Timeline children must use Modifier.timelineBar")
            val width = (data.widthFraction * trackWidth).roundToInt()
            m.measure(constraints.copy(minWidth = width, maxWidth = width)).also { height += it.height }
        }
        layout(constraints.maxWidth, height) {
            var y = 0
            barPlaceables.forEachIndexed { i, p ->
                val data = p.parentData as BarData
                labelPlaceables[i].placeRelative(0, y)
                p.placeRelative(labelWidth + (data.startFraction * trackWidth).roundToInt(), y)
                y += p.height
            }
        }
    }
}
```

`Layout(contents = ...)` (multi-content measure) keeps the slots separate so the measure block does not have to guess which measurable is a label and which is a bar.

### A shader background as a Modifier.Node

AGSL shaders run on API 33+. Implement the modifier as a node so the shader object is created once, uniforms are updated when parameters change, and a frame loop runs only while attached. Older devices get a gradient.

```kotlin
package com.example.app.ui.background

import android.graphics.RuntimeShader
import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.foundation.background
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.withInfiniteAnimationFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import kotlinx.coroutines.launch
import org.intellij.lang.annotations.Language

fun Modifier.wavyBackground(base: Color, accent: Color): Modifier =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) this.then(WavyElement(base, accent))
    else this.background(Brush.verticalGradient(listOf(base, accent)))

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private data class WavyElement(val base: Color, val accent: Color) : ModifierNodeElement<WavyNode>() {
    override fun create() = WavyNode(base, accent)
    override fun update(node: WavyNode) = node.setColors(base, accent)
}

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private class WavyNode(base: Color, accent: Color) : Modifier.Node(), DrawModifierNode {
    private val shader = RuntimeShader(WAVY_AGSL)
    private val brush = ShaderBrush(shader)
    private val timeSeconds = mutableFloatStateOf(0f)

    init { setColors(base, accent) }

    fun setColors(base: Color, accent: Color) {
        shader.setColorUniform("base", android.graphics.Color.valueOf(base.red, base.green, base.blue, base.alpha))
        shader.setColorUniform("accent", android.graphics.Color.valueOf(accent.red, accent.green, accent.blue, accent.alpha))
        invalidateDraw()
    }

    override fun onAttach() {
        coroutineScope.launch {
            while (isAttached) {
                withInfiniteAnimationFrameMillis { timeSeconds.floatValue = it / 1000f }
                invalidateDraw()
            }
        }
    }

    override fun ContentDrawScope.draw() {
        shader.setFloatUniform("resolution", size.width, size.height)
        shader.setFloatUniform("time", timeSeconds.floatValue)
        drawRect(brush)
        drawContent()
    }
}

@Language("AGSL")
private const val WAVY_AGSL = """
    uniform float2 resolution;
    uniform float time;
    layout(color) uniform half4 base;
    layout(color) uniform half4 accent;
    half4 main(float2 fragCoord) {
        float2 uv = fragCoord / resolution;
        float wave = 0.5 + 0.5 * sin(uv.x * 6.0 + time) * cos(uv.y * 4.0 - time * 0.7);
        return mix(base, accent, wave);
    }
"""
```

`withInfiniteAnimationFrameMillis` pauses when the window is not visible and respects the test clock. Respect reduced motion: skip the loop when `rememberReduceMotion()` (see [../../patterns/ui/accessibility.md](../../patterns/ui/accessibility.md)) is true by passing a flag into the element.

### Previews and determinism

Charts in previews and screenshot tests must use fixed data; a background that uses `Random` must take a seed. Supply `samples` from a `PreviewParameterProvider` and avoid reading the clock in draw code.

## Verify

```sh
./gradlew :app:testDebugUnitTest --tests "*ChartPathTest*"
./gradlew :app:assembleDebug
./gradlew :app:validateDebugScreenshotTest   # charts are ideal screenshot-test subjects
adb shell settings put global animator_duration_scale 0   # shader loop still runs; check reduce-motion branch
```

Path math is a pure function, so test it on the JVM:

```kotlin
class ChartPathTest {
    @Test fun bandIsClosedAndLineStartsAtFirstSample() {
        val samples = listOf(Sample(0f, 50f, 60f, 70f), Sample(1f, 55f, 65f, 75f))
        val (line, band) = buildPaths(samples, Size(100f, 50f))
        assertFalse(line.isEmpty)
        val bounds = band.getBounds()
        assertEquals(0f, bounds.left, 0.01f)
        assertEquals(100f, bounds.right, 0.01f)
    }
}
```

On a device, open Android Studio's Layout Inspector with recomposition counts and scroll or animate: the chart composable's count must stay flat while the animation runs; if it climbs, a state read escaped into the composable body. Record GPU rendering (`adb shell dumpsys gfxinfo com.example.app`) and confirm no jank during the transition.

## Pitfalls

- Allocating `Path()` or `Brush` inside `onDrawBehind`, `Canvas { }` or `drawBehind { }`: these run every frame. Move them to `drawWithCache`.
- Reading `scrollState.value` or `animatable.value` in the composable body to pass into a draw modifier: recomposes per frame. Pass a lambda or read inside the lambda.
- `Canvas` with `fillMaxSize()` inside a scrollable `Column` gets infinite height constraints and draws nothing; give it a height.
- Forgetting `clip = true` with `shape` in `graphicsLayer`; the shape alone only affects shadows.
- `RuntimeShader` without the API 33 gate crashes on older devices at class load; keep the node in a `@RequiresApi` class as above.
- `drawWithCache` keyed on nothing: it invalidates on size change and on any snapshot state read inside; it does not re-run when a plain parameter changes unless that parameter is read in the block (it is, through capture, which is why `samples` above triggers a rebuild).
- Per-item `Canvas` composables for N decorative shapes; draw them in one `Canvas` loop.
- Drawing text with `drawText` from a `TextMeasurer` created per frame; use `rememberTextMeasurer()` once.
- No semantics: a chart is invisible to TalkBack. Add `Modifier.semantics { contentDescription = "Heart rate 58 to 120 bpm, average 72" }` with a summary computed from the data.

## Sources

- https://developer.android.com/develop/ui/compose/graphics/draw/overview
- https://developer.android.com/develop/ui/compose/graphics/draw/modifiers
- https://developer.android.com/develop/ui/compose/graphics/draw/brush
- https://developer.android.com/develop/ui/compose/graphics/draw/shapes
- https://developer.android.com/develop/ui/compose/layouts/custom
- https://developer.android.com/develop/ui/compose/custom-modifiers
- https://developer.android.com/develop/ui/views/graphics/agsl
- https://developer.android.com/develop/ui/compose/performance/bestpractices
- https://github.com/android/compose-samples (JetLagged, Jetsnack; see [../../references/compose-samples.md](../../references/compose-samples.md))
