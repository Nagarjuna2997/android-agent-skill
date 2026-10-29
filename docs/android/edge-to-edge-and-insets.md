# Edge-to-edge and window insets

On API 35 and later the app always draws behind the status bar and navigation bar; on earlier levels `enableEdgeToEdge()` opts in. Either way the content must respect the areas the system covers, which is what window insets describe.

## Enable it

```kotlin
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent { AppTheme { AppNavigation() } }
    }
}
```

`enableEdgeToEdge()` (from `androidx.activity`) makes the system bars transparent, sets their icon color from the current theme, and lays the window out behind them on every API level. Call it before `setContent`. With it, behavior is the same on API 26 and API 37, which is the point: do not branch on version.

Remove from themes anything that fights it: `android:windowTranslucentStatus`, `android:statusBarColor`, `android:navigationBarColor`, `android:fitsSystemWindows`. They are ignored on 35+ and cause inconsistencies below.

## The insets

| Inset | Covers |
|---|---|
| `WindowInsets.statusBars` | top system bar |
| `WindowInsets.navigationBars` | bottom gesture area or three-button bar |
| `WindowInsets.systemBars` | both of the above |
| `WindowInsets.displayCutout` | camera notch or hole |
| `WindowInsets.ime` | software keyboard when shown |
| `WindowInsets.safeDrawing` | union of system bars, cutout and IME: where content may be obscured |
| `WindowInsets.safeGestures` | where system gestures would intercept touches |
| `WindowInsets.safeContent` | union of safeDrawing and safeGestures |

`safeDrawing` is the default choice for content; `safeGestures` for swipeable things near edges.

## Scaffold does most of it

Material3 `Scaffold` consumes system bar insets for its top and bottom bars and hands the remaining space to content as `innerPadding`. Apply it, or the content sits under the bars.

```kotlin
Scaffold(
    topBar = { TopAppBar(title = { Text(stringResource(R.string.notes)) }) },
    bottomBar = { NavigationBar { /* items */ } },
) { innerPadding ->
    LazyColumn(
        contentPadding = innerPadding,
        modifier = Modifier.fillMaxSize(),
    ) { /* items */ }
}
```

Use `contentPadding = innerPadding` on lazy lists, not `Modifier.padding(innerPadding)`, so content scrolls under the bars and only the first and last items are padded. For non-scrolling content use `Modifier.padding(innerPadding)`.

Without a top bar, `Scaffold` still accounts for the status bar through its `contentWindowInsets` parameter (default `ScaffoldDefaults.contentWindowInsets`, which is `systemBars`). A full-bleed screen such as an image viewer passes `contentWindowInsets = WindowInsets(0)` and handles insets itself.

## Modifiers

Outside `Scaffold`, or inside it for elements that need their own handling:

```kotlin
Column(modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) { /* ... */ }

// Shorthands
Modifier.statusBarsPadding()
Modifier.navigationBarsPadding()
Modifier.systemBarsPadding()
Modifier.displayCutoutPadding()
Modifier.imePadding()
Modifier.safeDrawingPadding()
Modifier.safeContentPadding()
```

A background that should extend under the status bar while its content does not:

```kotlin
Box(modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer)) {
    Text(text = title, modifier = Modifier.statusBarsPadding().padding(16.dp))
}
```

Only pad once per edge. If `Scaffold` consumed the status bar and a child also calls `statusBarsPadding()`, the child gets padded twice on many devices. Compose tracks consumption: `Modifier.consumeWindowInsets(insets)` tells descendants that an ancestor handled them, and `Scaffold` already does this for `innerPadding`. When passing `innerPadding` down and also using inset modifiers inside, add `Modifier.consumeWindowInsets(innerPadding)` at the boundary.

## Keyboard (IME) insets

Text fields near the bottom must move up when the keyboard appears. Two parts:

1. Window soft input mode `adjustResize` in the manifest (the default with `enableEdgeToEdge` on recent Activity versions, but set it explicitly):

```xml
<activity android:name=".MainActivity" android:windowSoftInputMode="adjustResize" android:exported="true" />
```

2. `imePadding()` on the container that should shrink, usually combined with navigation bar padding so the two do not double up (`imePadding` already excludes the part covered by the navigation bar when you use `WindowInsets.ime.union(WindowInsets.navigationBars)` or the convenience below):

```kotlin
Column(
    modifier = Modifier
        .fillMaxSize()
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Top))
        .imePadding()
        .navigationBarsPadding(),
) {
    LazyColumn(modifier = Modifier.weight(1f)) { /* messages */ }
    MessageComposer()
}
```

For a lazy list that should keep its last item visible when the keyboard opens, use `imeNestedScroll()` on the list (`Modifier.imeNestedScroll()` from `androidx.compose.foundation.layout`) with `LazyListState`, and `BringIntoViewRequester` on the focused field.

Keyboard animation is synchronized with the inset change on API 30+; nothing to add.

## Display cutouts

With `enableEdgeToEdge`, content extends into the cutout area in portrait and landscape. `safeDrawing` includes the cutout, so content padded with it never sits under the camera. Backgrounds should extend through it. Do not set `android:windowLayoutInDisplayCutoutMode` unless you have a specific reason; the default `always` on API 35+ is correct for edge-to-edge.

## System bar appearance

Icons (light or dark) are chosen by `enableEdgeToEdge` from the theme's `isLightTheme`. To force them for one screen, for example a dark hero image under a light theme:

```kotlin
enableEdgeToEdge(
    statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
)
```

Per screen, change the window insets controller in a `DisposableEffect`:

```kotlin
val view = LocalView.current
val darkIcons = !isSystemInDarkTheme()
DisposableEffect(darkIcons) {
    val window = (view.context as Activity).window
    val controller = WindowCompat.getInsetsController(window, view)
    val previous = controller.isAppearanceLightStatusBars
    controller.isAppearanceLightStatusBars = darkIcons
    onDispose { controller.isAppearanceLightStatusBars = previous }
}
```

On three-button navigation below API 29 the system draws a translucent scrim over the navigation bar; `enableEdgeToEdge` handles it. Do not draw your own scrim.

Hiding bars for immersive content:

```kotlin
val controller = WindowCompat.getInsetsController(window, window.decorView)
controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
controller.hide(WindowInsetsCompat.Type.systemBars())
```

Restore with `show`. Pair with `DisposableEffect` so leaving the screen restores the bars.

## Dialogs, bottom sheets and popups

Material3 `ModalBottomSheet` handles navigation bar insets through `windowInsets`; keep the default. `Dialog` content with `usePlatformDefaultWidth = false` must pad itself with `safeDrawingPadding()`. `DropdownMenu` and `Popup` position themselves inside the window.

## Views interop

An `AndroidView` inside Compose receives insets as a normal child; apply them with Compose modifiers on the `AndroidView`. A `ComposeView` inside an XML layout should be inside a view that sets `fitsSystemWindows` appropriately or use `ViewCompat.setOnApplyWindowInsetsListener`; see `docs/android/migrating-from-views.md`.

## Checklist

- `enableEdgeToEdge()` before `setContent`.
- No `statusBarColor`, `navigationBarColor`, `fitsSystemWindows` in themes.
- Every screen either uses `Scaffold` and applies `innerPadding`, or pads with `safeDrawing`.
- Lazy lists use `contentPadding` so content scrolls under the bars.
- Screens with text input use `adjustResize` and `imePadding()`.
- Backgrounds extend to the edges; interactive elements stay inside `safeContent`.
- Landscape with a cutout checked on both sides.
- Three-button navigation and gesture navigation both checked.

## Verify

```sh
adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton   # three-button nav
adb shell cmd overlay enable com.android.internal.systemui.navbar.gestural      # gesture nav
adb shell settings put system user_rotation 1                                   # landscape
adb shell settings put global show_ime_with_hard_keyboard 1
adb exec-out screencap -p > /tmp/edge.png
```

Open each screen in both navigation modes and both orientations on an API 35+ emulator, and with the keyboard open on any screen with a text field. Compare screenshots: nothing under a bar, nothing cut by the cutout, no double padding at the bottom.

## Sources

- https://developer.android.com/develop/ui/compose/layouts/insets
- https://developer.android.com/develop/ui/views/layout/edge-to-edge
- https://developer.android.com/about/versions/15/behavior-changes-15
- https://developer.android.com/develop/ui/views/layout/display-cutout
- https://developer.android.com/develop/ui/compose/components/scaffold
