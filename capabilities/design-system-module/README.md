# Design system module

A `:core:designsystem` Gradle module that owns the app's `AppTheme`, typography, light/dark/dynamic color schemes, an `AppIcons` object, thin component wrappers over Material 3 1.4.0 (`AppButton`, `AppFilterChip`, `AppTopAppBar`), `ThemePreviews` and `DevicePreviews` multipreview annotations, and a second application module `:app-catalog` that renders every component for review. Modelled on Now in Android's `:core:designsystem` and `:app-nia-catalog` (see [../../references/nowinandroid.md](../../references/nowinandroid.md)); all code here is original.

## When to use

- More than one module draws UI, or more than one person does. A theme defined in `:app` cannot be used by `:feature:*` modules, and a theme defined in `:core:ui` next to app-aware composables drags the data model into every consumer.
- The product has opinions Material defaults do not express (a brand color for primary buttons, a fixed top app bar style, custom icon set). Wrappers pin those once; a lint rule (see [../../checklists/code-quality.md](../../checklists/code-quality.md)) then keeps raw Material calls out of features.
- Not for a single-module app with default Material styling; [../../patterns/ui/material3-theming.md](../../patterns/ui/material3-theming.md) alone is enough there. Not a replacement for Material components: a wrapper forwards to Material and adds defaults, it does not reimplement.

## Dependencies

`core/designsystem/build.gradle.kts`:

```kotlin
plugins {
    id("com.example.android.library")
    id("com.example.android.library.compose")     // Compose plugin, BOM 2026.09.00, tooling
}

android {
    namespace = "com.example.app.core.designsystem"
    testOptions.unitTests.isIncludeAndroidResources = true
}

dependencies {
    // api: consumers of the design system get Material 3 and foundation without declaring them.
    api(libs.androidx.compose.foundation)
    api(libs.androidx.compose.foundation.layout)
    api(libs.androidx.compose.material3)                  // 1.4.0 via the BOM
    api(libs.androidx.compose.material.icons.extended)    // only if AppIcons uses extended icons; adds ~2 MB to debug builds
    api(libs.androidx.compose.runtime)
    api(libs.androidx.compose.ui.util)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.androidx.compose.ui.test.manifest)
    testImplementation(libs.robolectric)                  // <version>, https://github.com/robolectric/robolectric/releases
}
```

`app-catalog/build.gradle.kts`:

```kotlin
plugins {
    id("com.example.android.application")
    id("com.example.android.application.compose")
}
android {
    namespace = "com.example.app.catalog"
    defaultConfig { applicationId = "com.example.app.catalog"; versionCode = 1; versionName = "0.1" }
    buildTypes { release { signingConfig = signingConfigs.getByName("debug") } }   // internal tool, never published
}
dependencies {
    implementation(libs.androidx.activity.compose)
    implementation(project(":core:designsystem"))
}
```

`:app-catalog` depends only on `:core:designsystem`. If it needs `:core:ui`, something app-aware leaked into the design system.

## Manifest and permissions

None for the library. `:app-catalog` is a normal application with one `ComponentActivity`; register it in `settings.gradle.kts` (`include(":app-catalog")`) and exclude it from release pipelines.

## Implementation

### Color schemes

```kotlin
package com.example.app.core.designsystem.theme

import androidx.compose.ui.graphics.Color

// Tonal palette values generated with the Material Theme Builder; names say tone, not role.
internal val Indigo10 = Color(0xFF00105C)
internal val Indigo20 = Color(0xFF1F2A7D)
internal val Indigo30 = Color(0xFF384395)
internal val Indigo40 = Color(0xFF505CAE)
internal val Indigo80 = Color(0xFFBDC2FF)
internal val Indigo90 = Color(0xFFE0E0FF)
internal val Amber10 = Color(0xFF2A1800)
internal val Amber20 = Color(0xFF462B00)
internal val Amber30 = Color(0xFF643F00)
internal val Amber40 = Color(0xFF835400)
internal val Amber80 = Color(0xFFFFB95C)
internal val Amber90 = Color(0xFFFFDDB3)
internal val Gray10 = Color(0xFF1B1B1F)
internal val Gray90 = Color(0xFFE4E1E6)
internal val Gray99 = Color(0xFFFFFBFF)
```

```kotlin
package com.example.app.core.designsystem.theme

import android.os.Build
import androidx.annotation.ChecksSdkIntAtLeast
import androidx.annotation.VisibleForTesting
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

@VisibleForTesting
val LightColorScheme: ColorScheme = lightColorScheme(
    primary = Indigo40, onPrimary = Color.White, primaryContainer = Indigo90, onPrimaryContainer = Indigo10,
    secondary = Amber40, onSecondary = Color.White, secondaryContainer = Amber90, onSecondaryContainer = Amber10,
    background = Gray99, onBackground = Gray10, surface = Gray99, onSurface = Gray10,
)

@VisibleForTesting
val DarkColorScheme: ColorScheme = darkColorScheme(
    primary = Indigo80, onPrimary = Indigo20, primaryContainer = Indigo30, onPrimaryContainer = Indigo90,
    secondary = Amber80, onSecondary = Amber20, secondaryContainer = Amber30, onSecondaryContainer = Amber90,
    background = Gray10, onBackground = Gray90, surface = Gray10, onSurface = Gray90,
)

/**
 * The app theme. `dynamicColor` is a user preference (see datastore-proto) and is honored only on API 31+.
 * Previews and screenshot tests pass dynamicColor = false so output does not depend on the wallpaper.
 */
@Composable
fun AppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && supportsDynamicTheming() -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColorScheme
        else -> LightColorScheme
    }
    MaterialTheme(
        colorScheme = colorScheme,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}

@ChecksSdkIntAtLeast(api = Build.VERSION_CODES.S)
fun supportsDynamicTheming(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
```

Only the roles the brand overrides are listed; `lightColorScheme` fills the rest with Material baseline values. Add `error`, `outline`, `surfaceVariant` and the container roles when the designer specifies them, and keep `@VisibleForTesting` on the schemes so a theme test can assert `MaterialTheme.colorScheme.primary == LightColorScheme.primary`.

Tokens that Material has no slot for (a gradient, a brand tint) go in a `CompositionLocal` provided by `AppTheme`; see "Custom design tokens via CompositionLocal" in [../../patterns/ui/material3-theming.md](../../patterns/ui/material3-theming.md). Keep them in this module.

### Typography and shapes

```kotlin
package com.example.app.core.designsystem.theme

import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Scale values in sp so font scaling works; line heights in sp too.
internal val AppTypography = Typography(
    displayLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 57.sp, lineHeight = 64.sp, letterSpacing = (-0.25).sp),
    headlineSmall = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = 0.15.sp),
    bodyLarge = TextStyle(fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = 0.5.sp),
    bodyMedium = TextStyle(fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.25.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = 0.1.sp),
)

internal val AppShapes = Shapes(
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(20.dp),
)
```

A custom font family goes in `res/font/` of this module and is referenced through `FontFamily(Font(R.font.app_sans_regular))`; the module's resource prefix (`core_designsystem_`) applies.

### Icons

One object so features never import `androidx.compose.material.icons.*` directly. Swapping an icon, or moving to custom vector drawables, is then one line.

```kotlin
package com.example.app.core.designsystem.icon

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.outlined.Bookmarks
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Bookmarks
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.ui.graphics.vector.ImageVector

/** Material icons are ImageVectors; custom icons are drawable resource ids (R.drawable.core_designsystem_ic_x). */
object AppIcons {
    val Add: ImageVector = Icons.Rounded.Add
    val ArrowBack: ImageVector = Icons.AutoMirrored.Rounded.ArrowBack   // flips in RTL
    val Bookmarks: ImageVector = Icons.Rounded.Bookmarks
    val BookmarksOutlined: ImageVector = Icons.Outlined.Bookmarks
    val Check: ImageVector = Icons.Rounded.Check
    val Close: ImageVector = Icons.Rounded.Close
    val Search: ImageVector = Icons.Rounded.Search
    val Settings: ImageVector = Icons.Rounded.Settings
}
```

Icons from the core `material-icons-core` artifact cost nothing; each icon from `material-icons-extended` is a class that R8 keeps only if referenced, but the artifact itself slows debug builds. Prefer importing the few extended icons you need as vector drawables.

### Component wrappers

A wrapper has the Material signature minus the parameters the design system decides, plus `modifier` first among the optionals. It never adds business parameters.

```kotlin
package com.example.app.core.designsystem.component

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.example.app.core.designsystem.theme.AppTheme

/** Filled button with a generic content slot. Wraps Material 3 [Button]; pins the container color. */
@Composable
fun AppButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    content: @Composable RowScope.() -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary),
        contentPadding = contentPadding,
        content = content,
    )
}

/** Filled button with text and an optional leading icon; the common case, so it gets its own overload. */
@Composable
fun AppButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    text: @Composable () -> Unit,
    leadingIcon: @Composable (() -> Unit)? = null,
) {
    AppButton(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        contentPadding = if (leadingIcon != null) ButtonDefaults.ButtonWithIconContentPadding else ButtonDefaults.ContentPadding,
    ) {
        AppButtonContent(text = text, leadingIcon = leadingIcon)
    }
}

@Composable
fun AppOutlinedButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    content: @Composable RowScope.() -> Unit,
) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onBackground),
        border = BorderStroke(
            width = AppButtonDefaults.OutlinedButtonBorderWidth,
            color = if (enabled) MaterialTheme.colorScheme.outline
            else MaterialTheme.colorScheme.onSurface.copy(alpha = AppButtonDefaults.DisabledOutlinedBorderAlpha),
        ),
        contentPadding = contentPadding,
        content = content,
    )
}

@Composable
fun AppTextButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    TextButton(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onBackground),
        content = content,
    )
}

@Composable
private fun RowScope.AppButtonContent(text: @Composable () -> Unit, leadingIcon: @Composable (() -> Unit)?) {
    if (leadingIcon != null) {
        androidx.compose.foundation.layout.Box(Modifier.sizeIn(maxHeight = ButtonDefaults.IconSize)) { leadingIcon() }
    }
    androidx.compose.foundation.layout.Box(
        Modifier.padding(start = if (leadingIcon != null) ButtonDefaults.IconSpacing else 0.dp),
    ) { text() }
}

object AppButtonDefaults {
    val OutlinedButtonBorderWidth = 1.dp
    const val DisabledOutlinedBorderAlpha = 0.12f
}

@ThemePreviews
@Composable
private fun AppButtonPreview() {
    AppTheme { AppButton(onClick = {}, text = { Text("Save") }) }
}
```

The same shape applies to `AppFilterChip(selected, onSelectedChange, label)`, `AppTopAppBar(titleRes, navigationIcon, actionIcon, ...)` and `AppNavigationBar`. Keep each wrapper in its own file with its previews at the bottom. Wrappers remain accessible by construction because they forward to Material; do not drop `enabled` or `contentDescription` parameters.

### Multipreview annotations

```kotlin
package com.example.app.core.designsystem.component

import android.content.res.Configuration
import androidx.compose.ui.tooling.preview.Devices
import androidx.compose.ui.tooling.preview.Preview

/** Renders a composable in light and dark theme. */
@Preview(name = "Light", uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true)
@Preview(name = "Dark", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true)
annotation class ThemePreviews

/** Renders a composable at phone, landscape phone, foldable, tablet and desktop sizes. */
@Preview(name = "Phone", device = Devices.PHONE, showBackground = true)
@Preview(name = "Phone landscape", widthDp = 891, heightDp = 411, showBackground = true)
@Preview(name = "Foldable", device = Devices.FOLDABLE, showBackground = true)
@Preview(name = "Tablet", device = Devices.TABLET, showBackground = true)
@Preview(name = "Desktop", device = Devices.DESKTOP, showBackground = true)
annotation class DevicePreviews

/** Font scale 1.0 and 2.0; the second catches clipped labels. */
@Preview(name = "Font 1x", fontScale = 1.0f, showBackground = true)
@Preview(name = "Font 2x", fontScale = 2.0f, showBackground = true)
annotation class FontScalePreviews
```

Annotation classes are plain Kotlin and Compose Preview Screenshot Testing picks them up like any `@Preview` (see [../../patterns/testing/screenshot-testing.md](../../patterns/testing/screenshot-testing.md)). Stack `@ThemePreviews @DevicePreviews` on a screen composable to get ten renders.

### Catalog app

A `LazyColumn` of sections, one `FlowRow` per component family, in every state (enabled, disabled, selected, with icon). Its job is review on a device: a designer scrolls it after each design-system change.

```kotlin
package com.example.app.catalog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.add
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.example.app.core.designsystem.component.AppButton
import com.example.app.core.designsystem.component.AppFilterChip
import com.example.app.core.designsystem.component.AppOutlinedButton
import com.example.app.core.designsystem.component.AppTextButton
import com.example.app.core.designsystem.icon.AppIcons
import com.example.app.core.designsystem.theme.AppTheme

@Composable
fun ComponentCatalog() {
    AppTheme {
        Surface {
            // Edge-to-edge is enforced on API 35+; pad for the system bars plus a 16 dp gutter.
            val contentPadding = WindowInsets.systemBars
                .add(WindowInsets(left = 16.dp, top = 16.dp, right = 16.dp, bottom = 16.dp))
                .asPaddingValues()
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = contentPadding,
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item { Text("Component catalog", style = MaterialTheme.typography.headlineSmall) }

                section("Buttons") {
                    AppButton(onClick = {}) { Text("Enabled") }
                    AppOutlinedButton(onClick = {}) { Text("Enabled") }
                    AppTextButton(onClick = {}) { Text("Enabled") }
                }
                section("Buttons, disabled") {
                    AppButton(onClick = {}, enabled = false) { Text("Disabled") }
                    AppOutlinedButton(onClick = {}, enabled = false) { Text("Disabled") }
                    AppTextButton(onClick = {}, enabled = false) { Text("Disabled") }
                }
                section("Buttons with icon") {
                    AppButton(onClick = {}, text = { Text("Add") }, leadingIcon = { Icon(AppIcons.Add, contentDescription = null) })
                }
                section("Chips") {
                    AppFilterChip(selected = false, onSelectedChange = {}) { Text("Unselected") }
                    AppFilterChip(selected = true, onSelectedChange = {}) { Text("Selected") }
                    AppFilterChip(selected = false, onSelectedChange = {}, enabled = false) { Text("Disabled") }
                }
            }
        }
    }
}

// FlowRow's overflow parameters are still experimental on the BOM in use; check the annotation on your Compose version.
@OptIn(ExperimentalLayoutApi::class)
private fun androidx.compose.foundation.lazy.LazyListScope.section(
    title: String,
    content: @Composable () -> Unit,
) {
    item { Text(title, style = MaterialTheme.typography.titleMedium) }
    item { FlowRow(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() } }
}
```

```kotlin
package com.example.app.catalog

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge

class CatalogActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { ComponentCatalog() }
    }
}
```

Icons in the catalog carry `contentDescription = null` because the adjacent text labels them; in a real screen an icon-only button needs a description (see [../../patterns/ui/accessibility.md](../../patterns/ui/accessibility.md)).

### Enforcing the wrappers

A custom lint check that flags `Button(` when `AppButton(` exists is the mechanism that makes the module stick; the detector, its registry and the `lintPublish(project(":lint"))` line that ships it to every consumer of `:core:designsystem` are in [../../checklists/code-quality.md](../../checklists/code-quality.md).

## Verify

```sh
./gradlew :core:designsystem:assembleDebug
./gradlew :core:designsystem:testDebugUnitTest --tests "*ThemeTest*"
./gradlew :app-catalog:installDebug && adb shell am start -n com.example.app.catalog/.CatalogActivity
./gradlew :core:designsystem:validateDebugScreenshotTest     # if Compose Preview Screenshot Testing is configured
```

Theme test under Robolectric (the colors are plain values, so no rendering is needed):

```kotlin
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ThemeTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun darkThemeWithoutDynamicColorUsesDarkScheme() {
        composeRule.setContent {
            AppTheme(darkTheme = true, dynamicColor = false) {
                assertEquals(DarkColorScheme.primary, MaterialTheme.colorScheme.primary)
                assertEquals(DarkColorScheme.surface, MaterialTheme.colorScheme.surface)
            }
        }
    }

    @Test
    @Config(sdk = [30])
    fun dynamicColorIsIgnoredBelowApi31() {
        composeRule.setContent {
            AppTheme(darkTheme = false, dynamicColor = true) {
                assertEquals(LightColorScheme.primary, MaterialTheme.colorScheme.primary)
            }
        }
    }
}
```

Open the catalog on a device with a vivid wallpaper and toggle system dark mode; every component must remain legible in all four combinations (light/dark, dynamic on/off) before the change is called done.

## Pitfalls

- `:core:designsystem` importing `:core:model` or `:core:data`. The lint rule `checkDependencies` will not catch it; a `./gradlew :core:designsystem:dependencies --configuration debugRuntimeClasspath | grep "project :"` line in CI does.
- Wrappers that accept a `Color` parameter "for flexibility" defeat the point. Add a semantic variant (`AppButtonStyle.Destructive`) instead.
- `dynamicColor = true` as the default makes previews and screenshot tests nondeterministic on API 31+ render targets. Default it to `false` in `AppTheme` and pass the user preference from `:app`.
- Material icon imports inside feature modules bypass `AppIcons`; the `DesignSystemDetector` in `checklists/code-quality.md` flags `Icons.` receivers for exactly this reason.
- A catalog app that needs flavors or Hilt to compile means the design system has grown app dependencies; fix the dependency, not the catalog.
- Forgetting `showBackground = true` on dark previews renders dark text on a transparent dark background in Studio.
- `material-icons-extended` as `api` of the design system pulls 10k icon classes into every module's compile classpath; prefer vector drawables for icons outside the core set.

## Sources

- https://developer.android.com/develop/ui/compose/designsystems/material3
- https://developer.android.com/develop/ui/compose/designsystems/custom
- https://developer.android.com/develop/ui/compose/designsystems/anatomy
- https://developer.android.com/develop/ui/compose/tooling/previews
- https://developer.android.com/topic/modularization/patterns
- https://m3.material.io/styles/color/dynamic-color/overview
