# App icon

Adaptive launcher icon with foreground, background and monochrome layers so the icon renders correctly on every launcher shape, in themed-icon mode on API 33+, and in the Play listing: the resource layout, vector drawables with safe-zone geometry, a legacy fallback for API 24 and 25, the manifest wiring, and verification by inspecting the merged resources and the launcher.

## When to use

- Every app. Play requires a 512 x 512 PNG listing icon separately; this recipe covers the in-app launcher icon.
- A one-color monochrome layer is what makes "themed icons" work; without it the launcher shows a tinted generic icon or the full-color one, depending on launcher.
- Generated apps belong to the user: never embed the maintainer's logo. Use a neutral placeholder shape until the user supplies artwork.

## Dependencies

None. Adaptive icons are platform resources. Android Studio's Image Asset wizard (New > Image Asset) produces the same file set from a source image and is the fastest route when the user has artwork.

## Manifest and permissions

```xml
<application
    android:icon="@mipmap/ic_launcher"
    android:roundIcon="@mipmap/ic_launcher_round"
    ...>
```

`roundIcon` is used by launchers that request a round variant on API 25; on 26+ the adaptive icon is masked by the launcher. Keep both attributes pointing to resources that exist for all densities or the adaptive definition.

## Implementation

### Resource layout

```text
app/src/main/res/
  mipmap-anydpi-v26/ic_launcher.xml            adaptive definition (API 26+)
  mipmap-anydpi-v26/ic_launcher_round.xml
  drawable/ic_launcher_foreground.xml          vector, 108 x 108 dp canvas, content inside the 66 dp safe zone
  drawable/ic_launcher_background.xml          vector or solid color
  drawable/ic_launcher_monochrome.xml          single-color vector, same geometry as foreground
  mipmap-mdpi/ic_launcher.png     48 px        legacy fallback for API 24 and 25
  mipmap-hdpi/ic_launcher.png     72 px
  mipmap-xhdpi/ic_launcher.png    96 px
  mipmap-xxhdpi/ic_launcher.png   144 px
  mipmap-xxxhdpi/ic_launcher.png  192 px
  mipmap-*/ic_launcher_round.png  same sizes
  values/ic_launcher_background.xml           color resource if the background is a flat color
```

With minSdk 26 the PNG fallbacks can be dropped; the templates use minSdk 26 for this reason.

### Adaptive definition

`res/mipmap-anydpi-v26/ic_launcher.xml` (and an identical `ic_launcher_round.xml`):

```xml
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
```

`res/values/ic_launcher_background.xml`:

```xml
<resources>
    <color name="ic_launcher_background">#1E5EFF</color>
</resources>
```

### Foreground vector (placeholder geometry)

The canvas is 108 dp; launchers mask to a shape roughly 72 dp across and may scale for parallax, so everything meaningful stays inside the central 66 dp circle (radius 33 dp around 54,54).

```xml
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <!-- Example glyph: a rounded square with a notch. Replace with the user's artwork. -->
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M38,34 H70 A6,6 0 0 1 76,40 V68 A6,6 0 0 1 70,74 H38 A6,6 0 0 1 32,68 V40 A6,6 0 0 1 38,34 Z" />
    <path
        android:fillColor="#1E5EFF"
        android:pathData="M48,48 H60 V60 H48 Z" />
</vector>
```

### Monochrome vector

Same paths, one color. The launcher tints it, so the fill color is irrelevant but must be opaque; alpha is used as the mask.

```xml
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#000000"
        android:pathData="M38,34 H70 A6,6 0 0 1 76,40 V68 A6,6 0 0 1 70,74 H38 A6,6 0 0 1 32,68 V40 A6,6 0 0 1 38,34 Z M48,48 H60 V60 H48 Z"
        android:fillType="evenOdd" />
</vector>
```

Use `evenOdd` to cut holes rather than drawing a second path in the background color; themed icons have no background color to match.

### Generating legacy PNGs

If minSdk is below 26, render the composed icon (background plus foreground, cropped to a circle or squircle) to PNG at the five densities. Android Studio's Image Asset wizard does this; from the command line, `rsvg-convert` or Inkscape can rasterize an SVG export of the same artwork. Commit the PNGs; do not generate at build time.

### Checking at runtime (optional)

To show the icon in-app (an about screen), load it through `PackageManager` rather than referencing the mipmap directly, so launcher shape and theming match:

```kotlin
val icon = context.packageManager.getApplicationIcon(context.packageName)
Image(painter = rememberDrawablePainter(icon), contentDescription = null, modifier = Modifier.size(64.dp))
```

`rememberDrawablePainter` is from Accompanist Drawable Painter or convert with `icon.toBitmap().asImageBitmap()` from `androidx.core.graphics`.

## Verify

```sh
./gradlew :app:assembleDebug
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep -E "ic_launcher"     # anydpi-v26 xml plus drawables present
./gradlew :app:lintDebug          # flags missing monochrome, wrong mipmap folder, or oversize foreground
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell cmd overlay list | grep -i theme   # not required; themed icons are toggled in launcher settings
```

Then on an API 33+ emulator: long-press the home screen, Wallpaper and style, enable "Themed icons" and confirm the monochrome layer is used. Also open Settings > Apps > the app and check the icon is not clipped. These are manual checks; report them as such.

A unit-level check that the resources resolve (Robolectric):

```kotlin
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class LauncherIconTest {
    @Test fun adaptiveIconHasAllLayers() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val drawable = context.packageManager.getApplicationIcon(context.packageName)
        assertTrue(drawable is android.graphics.drawable.AdaptiveIconDrawable)
        val adaptive = drawable as android.graphics.drawable.AdaptiveIconDrawable
        assertNotNull(adaptive.foreground)
        assertNotNull(adaptive.background)
        assertNotNull(adaptive.monochrome)
    }
}
```

## Pitfalls

- Foreground artwork that fills the 108 dp canvas gets clipped by every launcher mask; keep it inside the 66 dp safe zone.
- A monochrome layer with gradients or multiple colors renders as a flat blob; it is alpha-only.
- Mipmap folders are for launcher icons only; other drawables in `mipmap-*` are not density-stripped by bundles and bloat the APK.
- Referencing `@drawable/ic_launcher_foreground` from `mipmap-anydpi-v26` while also having PNGs named `ic_launcher_foreground` in `mipmap-*` folders causes resource conflicts.
- Transparent backgrounds are allowed but look wrong on most launchers; use a solid or gradient background.
- Changing the icon requires a launcher refresh; after `adb install` the launcher may cache the old icon until the app is reopened or the device restarted.
- The Play listing icon (512 px PNG, no transparency, no rounded corners pre-applied) is uploaded separately in Play Console; the in-app mipmaps are not used there.

## Sources

- https://developer.android.com/develop/ui/views/launch/icon_design_adaptive
- https://developer.android.com/studio/write/create-app-icons
- https://developer.android.com/about/versions/13/features#themed-app-icons
- https://developer.android.com/distribute/google-play/resources/icon-design-specifications
