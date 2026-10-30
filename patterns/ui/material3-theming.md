# Material 3 Theming

A single `AppTheme` composable that wraps the app and provides color scheme, typography and shapes through `MaterialTheme`, with dynamic color on Android 12+, a dark scheme, and a `CompositionLocal` for design tokens Material does not model. Material 3 is `androidx.compose.material3:material3:1.4.0` via the Compose BOM 2026.09.00.

```kotlin
dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
```

## Color scheme

Generate the baseline palette with the Material Theme Builder (m3.material.io) from your brand seed color and paste the output. The scheme has roughly 30 roles; the ones you will reference most are `primary`, `onPrimary`, `primaryContainer`, `surface`, `onSurface`, `surfaceVariant`, `onSurfaceVariant`, `outline`, `error`.

```kotlin
package com.example.app.ui.theme

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color

// Values from Material Theme Builder; keep them in one file.
private val primaryLight = Color(0xFF3B5BA9)
private val onPrimaryLight = Color(0xFFFFFFFF)
private val primaryContainerLight = Color(0xFFDAE2FF)
private val onPrimaryContainerLight = Color(0xFF001848)
private val surfaceLight = Color(0xFFFAF8FF)
private val onSurfaceLight = Color(0xFF1A1B20)
private val errorLight = Color(0xFFBA1A1A)
// ... remaining roles

private val primaryDark = Color(0xFFB3C5FF)
private val onPrimaryDark = Color(0xFF002D73)
private val primaryContainerDark = Color(0xFF204290)
private val onPrimaryContainerDark = Color(0xFFDAE2FF)
private val surfaceDark = Color(0xFF121318)
private val onSurfaceDark = Color(0xFFE3E2E9)
private val errorDark = Color(0xFFFFB4AB)

val LightColorScheme = lightColorScheme(
    primary = primaryLight,
    onPrimary = onPrimaryLight,
    primaryContainer = primaryContainerLight,
    onPrimaryContainer = onPrimaryContainerLight,
    surface = surfaceLight,
    onSurface = onSurfaceLight,
    error = errorLight,
)

val DarkColorScheme = darkColorScheme(
    primary = primaryDark,
    onPrimary = onPrimaryDark,
    primaryContainer = primaryContainerDark,
    onPrimaryContainer = onPrimaryContainerDark,
    surface = surfaceDark,
    onSurface = onSurfaceDark,
    error = errorDark,
)
```

Roles you do not override fall back to Material defaults, which are tuned to the baseline purple. Override at least the primary, secondary, tertiary, surface and error groups so the fallback is not visible.

## Typography and shapes

```kotlin
package com.example.app.ui.theme

import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.app.R

// Bundled font in res/font/; or use Google Fonts via androidx.compose.ui:ui-text-google-fonts.
private val Inter = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
)

val AppTypography = Typography(
    displayLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 57.sp, lineHeight = 64.sp),
    headlineMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 28.sp, lineHeight = 36.sp),
    titleLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 22.sp, lineHeight = 28.sp),
    bodyLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
)

val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(28.dp),
)
```

Font sizes are in `sp` so they scale with the user's font size setting. Never convert a text size to `dp` to "keep the layout stable"; that is an accessibility failure (see [accessibility.md](accessibility.md)).

## Custom design tokens via CompositionLocal

Material has no slot for "success green", "spacing scale", or "elevation for cards in the feed". Add a small token class and provide it alongside `MaterialTheme`.

```kotlin
package com.example.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

@Immutable
data class ExtendedColors(
    val success: Color,
    val onSuccess: Color,
    val warning: Color,
    val onWarning: Color,
)

@Immutable
data class Spacing(
    val xs: Dp = 4.dp,
    val sm: Dp = 8.dp,
    val md: Dp = 16.dp,
    val lg: Dp = 24.dp,
    val xl: Dp = 32.dp,
)

val LightExtendedColors = ExtendedColors(
    success = Color(0xFF2E7D32), onSuccess = Color.White,
    warning = Color(0xFFF9A825), onWarning = Color.Black,
)
val DarkExtendedColors = ExtendedColors(
    success = Color(0xFF81C784), onSuccess = Color(0xFF003300),
    warning = Color(0xFFFFD54F), onWarning = Color(0xFF332200),
)

// staticCompositionLocalOf: changing the value recomposes every reader, which is fine
// for a theme that changes at most once (dark/light toggle).
val LocalExtendedColors = staticCompositionLocalOf { LightExtendedColors }
val LocalSpacing = staticCompositionLocalOf { Spacing() }

// Accessor so call sites read `AppTheme.colors.success` instead of the Local directly.
object AppTheme {
    val colors: ExtendedColors
        @Composable get() = LocalExtendedColors.current
    val spacing: Spacing
        @Composable get() = LocalSpacing.current
}
```

## The theme composable

```kotlin
package com.example.app.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalContext

@Composable
fun AppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    // Dynamic color picks up the user's wallpaper palette on Android 12+.
    // Turn it off for a strongly branded app.
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }
    val extended = if (darkTheme) DarkExtendedColors else LightExtendedColors

    CompositionLocalProvider(
        LocalExtendedColors provides extended,
        LocalSpacing provides Spacing(),
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = AppTypography,
            shapes = AppShapes,
            content = content,
        )
    }
}
```

Note the signature: `AppTheme` is the only place that reads `isSystemInDarkTheme()`. Screens read `MaterialTheme.colorScheme` and never check dark mode themselves. If the app has an in-app theme setting, read it from a DataStore-backed ViewModel in `MainActivity` and pass `darkTheme` explicitly.

With edge-to-edge (enforced from API 35), the status and navigation bars are transparent and the theme's `surface` shows through; call `enableEdgeToEdge()` in `onCreate` and let `Scaffold` supply insets. There is no need to set `window.statusBarColor` anymore, and on API 35+ it is deprecated.

## Using the theme

```kotlin
@Composable
fun StatusBadge(status: OrderStatus, modifier: Modifier = Modifier) {
    val (bg, fg) = when (status) {
        OrderStatus.Delivered -> AppTheme.colors.success to AppTheme.colors.onSuccess
        OrderStatus.Delayed -> AppTheme.colors.warning to AppTheme.colors.onWarning
        OrderStatus.Cancelled -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
    }
    Text(
        text = status.label,
        style = MaterialTheme.typography.labelLarge,
        color = fg,
        modifier = modifier
            .background(bg, MaterialTheme.shapes.small)
            .padding(horizontal = AppTheme.spacing.sm, vertical = AppTheme.spacing.xs),
    )
}
```

Always pair a container color with its `on` color from the same role. Picking `onSurface` text over `primaryContainer` looks fine in light mode and fails contrast in dark mode.

## Previews for both themes

```kotlin
import androidx.compose.ui.tooling.preview.Preview
import android.content.res.Configuration

@Preview(name = "Light", showBackground = true)
@Preview(name = "Dark", uiMode = Configuration.UI_MODE_NIGHT_YES or Configuration.UI_MODE_TYPE_NORMAL, showBackground = true)
@Preview(name = "Large font", fontScale = 1.5f, showBackground = true)
annotation class ThemePreviews

@ThemePreviews
@Composable
private fun StatusBadgePreview() {
    AppTheme(dynamicColor = false) {
        StatusBadge(OrderStatus.Delayed)
    }
}
```

`dynamicColor = false` in previews makes screenshots deterministic; dynamic color on a preview or a test device depends on the wallpaper.

## Material 3 Expressive

Material 3 1.4.0 ships the Expressive update behind `@OptIn(ExperimentalMaterial3ExpressiveApi::class)`: `MaterialExpressiveTheme`, a `MotionScheme` (standard or expressive spring-based motion), new shape options (`MaterialShapes`), button groups, loading indicators, and updated component variants. The APIs are marked experimental; before using any of them, check the annotation on the symbol in your resolved Material 3 version. If a symbol is annotated `@ExperimentalMaterial3ExpressiveApi`, it can change in a minor release; wrap the usage in your own composable so a rename touches one file.

```kotlin
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun AppTheme(...) {
    MaterialExpressiveTheme(
        colorScheme = colorScheme,
        typography = AppTypography,
        shapes = AppShapes,
        motionScheme = MotionScheme.expressive(),
        content = content,
    )
}
```

Use `MaterialTheme` by default. Switch to `MaterialExpressiveTheme` only when the product wants the Expressive motion and shapes, and verify the build after every BOM bump.

## Dynamic color and contrast levels

Android 14 (API 34) adds a system contrast setting (Settings > Accessibility > Color contrast) exposed as `UiModeManager.contrast`, a float from 0 (standard) to 1 (high). Material Theme Builder exports six schemes for a seed color: standard, medium-contrast and high-contrast, each in light and dark. Reply from `android/compose-samples` selects among them by contrast range; dynamic color, when enabled, already adapts to the setting so it bypasses the lookup.

```kotlin
package com.example.app.ui.theme

import android.app.UiModeManager
import android.content.Context
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode

// Generated by Material Theme Builder; six vals, one per scheme.
// val LightColorScheme, DarkColorScheme, MediumContrastLight, MediumContrastDark, HighContrastLight, HighContrastDark

@Composable
private fun schemeForContrast(darkTheme: Boolean): ColorScheme {
    val context = LocalContext.current
    // UiModeManager.contrast is API 34+ and not available in previews.
    val contrast = if (!LocalInspectionMode.current && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        (context.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager).contrast
    } else {
        0f
    }
    return when {
        contrast >= 0.67f -> if (darkTheme) HighContrastDark else HighContrastLight
        contrast >= 0.34f -> if (darkTheme) MediumContrastDark else MediumContrastLight
        else -> if (darkTheme) DarkColorScheme else LightColorScheme
    }
}

@Composable
fun AppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        else -> schemeForContrast(darkTheme)
    }
    MaterialTheme(colorScheme = colorScheme, typography = AppTypography, shapes = AppShapes, content = content)
}
```

This `AppTheme` replaces the color selection in the version above; the `CompositionLocalProvider` for extended tokens stays. The contrast value is read once per composition of `AppTheme`; the Activity is recreated when the user changes the setting, so there is no need to observe it. Previews cannot reach `UiModeManager`, which is why the check on `LocalInspectionMode` exists; add a `@Preview` that passes each scheme directly to `MaterialTheme` to see the high-contrast variants. Your `ExtendedColors` tokens need the same three levels if they carry text or borders; a `success` green that passes 4.5:1 on the standard surface will not pass on a high-contrast one.

## A fully custom design system

Some products have a design language that is not Material: their own color roles, gradients, text styles, no tonal surfaces. Jetsnack from `android/compose-samples` is the reference for doing that in Compose without fighting `MaterialTheme`. Three decisions make it work.

First, the theme object is your own `@Immutable` class provided through a `staticCompositionLocalOf`, with roles named for their use (brand, text, icon, border, interactive gradients), never for their hue:

```kotlin
package com.example.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

@Immutable
data class AppColors(
    val brand: Color,
    val brandSecondary: Color,
    val background: Color,
    val border: Color,
    val floated: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textHelp: Color,
    val textInteractive: Color,
    val textLink: Color,
    val iconPrimary: Color,
    val iconSecondary: Color,
    val iconInteractive: Color,
    val iconInteractiveInactive: Color,
    val error: Color,
    val interactivePrimary: List<Color>,     // gradient stops
    val interactiveSecondary: List<Color>,
    val isDark: Boolean,
)

private val LocalAppColors = staticCompositionLocalOf<AppColors> { error("No AppColors provided; wrap the UI in AppTheme") }

object AppTheme {
    val colors: AppColors
        @Composable get() = LocalAppColors.current
}
```

Second, `MaterialTheme` still wraps the content, because Material components (`Text`, `Scaffold`, `Snackbar`, `TextField`) read typography and shapes from it and you want those. Its color scheme is set to a single loud marker color so any component or composable that reads `MaterialTheme.colorScheme` by default is visibly wrong in the first preview:

```kotlin
// Technique from android/compose-samples Jetsnack (Apache-2.0): every Material color role set
// to one marker color. Nothing in the app should ever show magenta.
private fun markerColorScheme(marker: Color = Color.Magenta) = lightColorScheme(
    primary = marker, onPrimary = marker, primaryContainer = marker, onPrimaryContainer = marker,
    secondary = marker, onSecondary = marker, secondaryContainer = marker, onSecondaryContainer = marker,
    tertiary = marker, onTertiary = marker, tertiaryContainer = marker, onTertiaryContainer = marker,
    background = marker, onBackground = marker, surface = marker, onSurface = marker,
    surfaceVariant = marker, onSurfaceVariant = marker, surfaceTint = marker,
    inverseSurface = marker, inverseOnSurface = marker, inversePrimary = marker,
    error = marker, onError = marker, errorContainer = marker, onErrorContainer = marker,
    outline = marker, outlineVariant = marker, scrim = marker,
    surfaceBright = marker, surfaceDim = marker, surfaceContainer = marker, surfaceContainerHigh = marker,
    surfaceContainerHighest = marker, surfaceContainerLow = marker, surfaceContainerLowest = marker,
)

@Composable
fun AppTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (darkTheme) DarkAppColors else LightAppColors
    CompositionLocalProvider(LocalAppColors provides colors) {
        MaterialTheme(
            colorScheme = markerColorScheme(),
            typography = AppTypography,
            shapes = AppShapes,
            content = content,
        )
    }
}
```

Third, every Material component the app uses is wrapped once with the custom colors applied, and screens only ever call the wrappers:

```kotlin
package com.example.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.material3.Surface
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarData
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.example.app.ui.theme.AppTheme

@Composable
fun AppSurface(
    modifier: Modifier = Modifier,
    shape: Shape = MaterialTheme.shapes.medium,
    color: Color = AppTheme.colors.background,
    contentColor: Color = AppTheme.colors.textSecondary,
    border: BorderStroke? = null,
    tonalElevation: Dp = 0.dp,
    content: @Composable () -> Unit,
) = Surface(modifier, shape, color, contentColor, tonalElevation, border = border, content = content)

@Composable
fun AppSnackbar(data: SnackbarData, modifier: Modifier = Modifier) = Snackbar(
    snackbarData = data,
    modifier = modifier,
    shape = MaterialTheme.shapes.small,
    containerColor = AppTheme.colors.background,
    contentColor = AppTheme.colors.textSecondary,
    actionColor = AppTheme.colors.brand,
)
```

Pass `AppSnackbar` to `SnackbarHost(snackbar = { AppSnackbar(it) })`, give `Scaffold` `containerColor = AppTheme.colors.background`, and set `LocalContentColor` inside `AppSurface` consumers through the `contentColor` parameter so `Text` and `Icon` inherit the right default.

When to do this: only when the product's design is genuinely not Material and will stay that way. The cost is real: no dynamic color, no tonal elevation, no contrast schemes for free, and every new Material component needs a wrapper. For "Material with brand colors and a few extra tokens", the `ExtendedColors` approach earlier in this file is the right size. Do not mix the two: an app that reads both `AppTheme.colors` and `MaterialTheme.colorScheme` for real colors has two sources of truth. The marker scheme exists precisely to catch that.

## Avoid

```kotlin
// Anti-pattern: hardcoded colors in composables; breaks dark mode and dynamic color.
Text("Error", color = Color.Red)

// Anti-pattern: reading isSystemInDarkTheme() inside a screen.
val textColor = if (isSystemInDarkTheme()) Color.White else Color.Black

// Anti-pattern: text size in dp.
fontSize = 16.dp   // does not compile for TextStyle; people work around it with TextUnit conversions. Do not.

// Anti-pattern: magic spacing numbers scattered everywhere.
Modifier.padding(start = 13.dp, top = 7.dp)

// Anti-pattern: a second MaterialTheme nested with a different scheme for one screen.
// Use colorScheme.copy(...) locally only when a surface genuinely needs it, and keep contrast.
```

## Verify

```sh
./gradlew :app:assembleDebug
# Render previews for both themes:
./gradlew :app:validateDebugScreenshotTest   # see patterns/testing/screenshot-testing.md
adb shell "cmd uimode night yes"              # toggle dark on a device
adb shell settings put system font_scale 1.5  # confirm text scales and layouts do not clip
```

## Sources

- https://developer.android.com/develop/ui/compose/designsystems/material3
- https://developer.android.com/develop/ui/compose/designsystems/custom
- https://developer.android.com/develop/ui/compose/compositionlocal
- https://developer.android.com/develop/ui/views/theming/dynamic-colors
- https://developer.android.com/develop/ui/compose/layouts/insets
- https://developer.android.com/jetpack/androidx/releases/compose-material3
- https://m3.material.io/theme-builder
- https://m3.material.io/styles/color/roles
- https://developer.android.com/reference/android/app/UiModeManager#getContrast()
- https://github.com/android/compose-samples (Jetsnack, Reply; see [../../references/compose-samples.md](../../references/compose-samples.md))
