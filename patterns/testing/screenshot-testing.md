# Screenshot Testing with Compose Preview Screenshot Testing

Compose Preview Screenshot Testing turns `@Preview` composables into image-based regression tests: generate reference PNGs once, then every build compares fresh renders against them and fails on pixel differences. It runs on the JVM with the layoutlib renderer, so it needs no device and takes seconds.

## What it proves and what it does not

Proves:

- A composable's rendered output at a given size, theme, font scale and locale has not changed unintentionally.
- Dark theme, large font and RTL variants exist and look as reviewed, because each is a separate preview and a separate reference image.
- A dependency upgrade (Compose BOM, Material 3) did not shift layouts.

Does not prove:

- Behavior. Nothing is clicked; state is whatever the preview passes in. Use [compose-ui-testing.md](compose-ui-testing.md) for interaction.
- Pixel-exact device output. Layoutlib is not Skia on a phone; fonts, antialiasing and shadows differ slightly. References are only comparable to other layoutlib renders on the same tool version.
- Animations, system bars, dialogs and popups rendered in separate windows, or anything that depends on a real `Activity`.
- Accessibility or performance.

Treat it as a cheap visual diff for reviewed designs, not as end-to-end verification.

## Setup

The plugin is `com.android.compose.screenshot`. Its version is tracked separately from AGP; it is not in `data/versions.json`, so resolve it from the Android Studio release notes page for screenshot testing. It requires AGP 8.5.0 or newer and works with AGP 9.4.0.

```kotlin
// build.gradle.kts (project)
plugins {
    id("com.android.compose.screenshot") version "<version>" apply false
}
```

```kotlin
// app/build.gradle.kts
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.android.compose.screenshot")
}

android {
    experimentalProperties["android.experimental.enableScreenshotTest"] = true
}

dependencies {
    screenshotTestImplementation("androidx.compose.ui:ui-tooling")   // from the BOM
}
```

```properties
# gradle.properties
android.experimental.enableScreenshotTest=true
```

The plugin adds a `screenshotTest` source set next to `test` and `androidTest`: `app/src/screenshotTest/kotlin/`. Previews in `main` are not picked up; move or copy the ones you want tested into the `screenshotTest` source set. Keeping them separate also keeps preview-only code out of the release build's dependency graph.

## Writing screenshot previews

A screenshot preview is an ordinary `@Preview` composable in the `screenshotTest` source set. Make it deterministic: fixed data, `dynamicColor = false`, no `System.currentTimeMillis()`, no random ids, no network images (use a placeholder painter in previews).

```kotlin
// app/src/screenshotTest/kotlin/com/example/app/todo/TodoScreenScreenshots.kt
package com.example.app.todo

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import com.example.app.ui.theme.AppTheme
import java.time.Instant

private val sampleItems = listOf(
    TodoItem("1", "Buy groceries", false, Instant.EPOCH),
    TodoItem("2", "Read a chapter", true, Instant.EPOCH),
    TodoItem("3", "A much longer title that should wrap onto a second line without clipping", false, Instant.EPOCH),
)

@Preview(name = "success_light", showBackground = true, widthDp = 412, heightDp = 892)
@Preview(name = "success_dark", showBackground = true, widthDp = 412, heightDp = 892, uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "success_fontScale2", showBackground = true, widthDp = 412, heightDp = 892, fontScale = 2f)
@Preview(name = "success_rtl", showBackground = true, widthDp = 412, heightDp = 892, locale = "ar")
@Preview(name = "success_tablet", showBackground = true, widthDp = 1280, heightDp = 800)
@Composable
fun TodoScreen_Success() {
    AppTheme(dynamicColor = false) {
        TodoScreen(
            state = TodoUiState(content = TodoUiState.Content.Success(sampleItems)),
            onAdd = {}, onToggle = {}, onDelete = {}, onFilterChange = {}, onMessageShown = {},
        )
    }
}

@Preview(name = "empty", showBackground = true, widthDp = 412, heightDp = 892)
@Composable
fun TodoScreen_Empty() {
    AppTheme(dynamicColor = false) {
        TodoScreen(state = TodoUiState(content = TodoUiState.Content.Empty), onAdd = {}, onToggle = {}, onDelete = {}, onFilterChange = {}, onMessageShown = {})
    }
}

@Preview(name = "error", showBackground = true, widthDp = 412, heightDp = 892)
@Composable
fun TodoScreen_Error() {
    AppTheme(dynamicColor = false) {
        TodoScreen(state = TodoUiState(content = TodoUiState.Content.Error("Could not reach the server.")), onAdd = {}, onToggle = {}, onDelete = {}, onFilterChange = {}, onMessageShown = {})
    }
}
```

A `@PreviewParameter` provider works too and yields one image per value. The preview `name` becomes part of the reference file name, so give every variant a distinct, stable name.

Component-level previews (a row, a badge, a button in each state) are more valuable per image than full screens: a single screen screenshot changes for many unrelated reasons, a row screenshot changes only when the row does.

## Generating references

```sh
./gradlew :app:updateDebugScreenshotTest
```

Writes PNGs to `app/src/screenshotTest/reference/<package>/<file>/<function>_<previewName>.png`. Commit them. Review the images in the pull request like any other change; a reference that was generated from a bug encodes the bug.

Regenerate after an intentional visual change, and only for the previews that changed:

```sh
./gradlew :app:updateDebugScreenshotTest --tests "com.example.app.todo.TodoScreenScreenshots"
```

## Validating

```sh
./gradlew :app:validateDebugScreenshotTest
```

Renders every preview, compares against the reference, and fails the task on any difference. The report at `app/build/reports/screenshotTest/preview/debug/index.html` shows reference, actual and a diff image per failure. Image comparison has a small tolerance by default; you can adjust it per module:

```kotlin
android {
    testOptions {
        screenshotTests {
            imageDifferenceThreshold = 0.001f   // fraction of differing pixels allowed; 0 = exact
        }
    }
}
```

Keep the threshold near zero. A larger threshold hides one-pixel layout shifts, which is the whole thing you are trying to catch.

## CI

Reference images are platform-dependent in minor ways (font hinting differs between Linux and macOS layoutlib builds). Generate and validate on the same OS, which in practice means generating on Linux in CI and having developers do the same via a container, or accepting that local macOS validation may differ and treating CI as the source of truth.

```yaml
# .github/workflows/screenshots.yml (excerpt)
- name: Validate screenshots
  run: ./gradlew :app:validateDebugScreenshotTest --no-daemon
- name: Upload screenshot report
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: screenshot-report
    path: app/build/reports/screenshotTest/
```

Run it in the same job as unit tests; it does not need an emulator. When a diff is expected (a design change), the PR author runs `update`, commits the new references, and reviewers look at the image diff in the PR.

## Working around limitations

- Fonts: bundle the app's fonts as resources rather than depending on Google Fonts at runtime; downloadable fonts are not available to layoutlib and the fallback font makes every text screenshot differ from a device.
- Images: `AsyncImage` from Coil shows nothing in a preview. Pass a `placeholder` painter, or use Coil's `LocalAsyncImagePreviewHandler` to return a fixed drawable in previews.
- Dynamic color: always `dynamicColor = false`.
- Time and locale: inject a fixed `Clock` into anything that formats dates; set `locale` on the preview explicitly rather than relying on the host machine.
- Dialogs and bottom sheets: render their content composable directly rather than the `Dialog` wrapper, which is a separate window.
- Multiple modules: each library module applies the plugin and keeps its own references; feature modules screenshot their own screens.

## Avoid

```kotlin
// Anti-pattern: previews in `main` doing double duty; the screenshot set grows uncontrolled
// and preview-only helpers leak into the production dependency graph.

// Anti-pattern: non-deterministic data.
TodoItem(UUID.randomUUID().toString(), "Milk", false, Instant.now())

// Anti-pattern: regenerating all references to make CI green without looking at the diff.
./gradlew updateDebugScreenshotTest   # on every failure

// Anti-pattern: one screenshot per screen, none per component.

// Anti-pattern: a threshold high enough that a 2 dp padding change passes.
imageDifferenceThreshold = 0.05f
```

## Verify

```sh
./gradlew :app:updateDebugScreenshotTest    # first run; commit app/src/screenshotTest/reference/
./gradlew :app:validateDebugScreenshotTest  # must pass on an unchanged tree
# Then change a padding value, run validate again, and confirm it fails with a diff image
# in app/build/reports/screenshotTest/preview/debug/index.html. Revert the change.
```

A screenshot suite that has never failed has not been shown to work.

## Sources

- https://developer.android.com/studio/preview/compose-screenshot-testing
- https://developer.android.com/develop/ui/compose/tooling/previews
- https://developer.android.com/studio/releases/gradle-plugin
- https://developer.android.com/jetpack/androidx/releases/compose-ui
