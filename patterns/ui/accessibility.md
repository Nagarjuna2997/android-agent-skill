# Accessibility in Compose

Compose exposes a semantics tree to accessibility services (TalkBack, Switch Access) and to UI tests. Most Material components populate it correctly; the work is in custom composables, images, grouping, touch targets, text scaling, contrast and motion. The checklist companion is [../../checklists/accessibility.md](../../checklists/accessibility.md).

## Semantics basics

Every composable contributes zero or more semantics nodes. `Modifier.semantics { }` adds properties; `Modifier.clearAndSetSemantics { }` replaces everything below with what you specify.

```kotlin
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription

// A section title TalkBack can jump to with heading navigation.
Text("Today", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })

// A custom toggle built from a Box; without role/state it is "a clickable thing".
Box(
    Modifier
        .toggleable(value = checked, onValueChange = onCheckedChange, role = Role.Switch)
        .semantics { stateDescription = if (checked) "Enabled" else "Disabled" },
) { ... }
```

Use `clickable`, `toggleable` and `selectable` modifiers instead of `pointerInput` for tappable things; they add the role, the click action and the state for free.

## contentDescription

- Informative images: describe what the image conveys, not that it is an image. "Order confirmation, two items" rather than "image".
- Decorative images and icons next to text: `contentDescription = null` so TalkBack skips them. An icon inside a button whose label is text is decorative.
- Icon-only buttons: the description is the action. "Delete", not "trash can icon".

```kotlin
// Icon-only button: description is required.
IconButton(onClick = onDelete) {
    Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.action_delete))
}

// Icon next to a text label: decorative.
Button(onClick = onSave) {
    Icon(Icons.Filled.Save, contentDescription = null)
    Spacer(Modifier.width(8.dp))
    Text(stringResource(R.string.action_save))
}

// Image whose meaning matters.
AsyncImage(model = product.imageUrl, contentDescription = product.name)
```

Lint flags `Icon` and `Image` without a `contentDescription` argument; passing `null` deliberately is the correct way to mark decoration, not an empty string.

## Grouping with mergeDescendants

A list row of avatar, name, subtitle and timestamp is four separate focus stops by default. Merge them so TalkBack reads one sentence and the user swipes once per row.

```kotlin
@Composable
fun MessageRow(message: Message, onOpen: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)          // clickable already merges descendants
            .padding(16.dp),
    ) {
        Avatar(message.sender, contentDescription = null)   // name is read from the Text below
        Column(Modifier.weight(1f)) {
            Text(message.sender.name)
            Text(message.preview, maxLines = 1)
        }
        Text(message.relativeTime)
    }
}
```

`clickable` sets `mergeDescendants = true`. For a non-clickable group, add `Modifier.semantics(mergeDescendants = true) { }`. If the merged readout is awkward ("John Doe Hey are you 3m"), override it with `clearAndSetSemantics { contentDescription = "Message from John Doe, 3 minutes ago: Hey are you" }` but keep interactive children outside that modifier, because `clearAndSetSemantics` hides them from accessibility services.

A row with its own button (a star toggle inside the row) should keep the button as a separate node: put the toggle after the merged group or use a custom action.

```kotlin
Modifier.semantics {
    customActions = listOf(
        CustomAccessibilityAction("Archive") { onArchive(); true },
        CustomAccessibilityAction("Mark unread") { onMarkUnread(); true },
    )
}
```

Custom actions appear in TalkBack's actions menu and in Switch Access, which is the correct place for swipe-to-reveal actions that have no visible button.

## Touch targets

Minimum 48 x 48 dp. Material components enforce this through `LocalMinimumInteractiveComponentSize`, which adds invisible padding around small icons. Custom clickables need `Modifier.minimumInteractiveComponentSize()` or an explicit size.

```kotlin
// 24 dp icon, 48 dp touch target.
Box(
    Modifier
        .minimumInteractiveComponentSize()
        .clickable(onClick = onClick, role = Role.Button)
        .semantics { contentDescription = "Favorite" },
    contentAlignment = Alignment.Center,
) {
    Icon(Icons.Filled.Star, contentDescription = null, modifier = Modifier.size(24.dp))
}
```

Two adjacent small targets must not overlap each other's 48 dp zone; give them spacing or combine them.

## Font scaling

Text sizes in `sp` scale with the system font size, up to 200% on recent Android versions. Layouts must survive that.

- Never use `dp` for text or convert to a fixed size to prevent scaling.
- Give containers room to grow: avoid fixed heights on rows with text; use `heightIn(min = ...)`.
- Prefer `maxLines` plus `overflow = TextOverflow.Ellipsis` over clipping.
- Icons that sit next to text can scale too, with `Modifier.size(with(LocalDensity.current) { 24.sp.toDp() })` if the design wants them to.
- Check `LocalConfiguration.current.fontScale` only to choose a different layout at large scales (stack a row vertically at 1.5+), never to shrink text.

Preview and test at `fontScale = 1.5f` and `2.0f`.

## Reduced motion

Android has no single "reduce motion" switch; the signals are "Remove animations" (sets the animator duration scale to 0) and, on some devices, a separate accessibility toggle. Read the animator scale and skip or shorten non-essential animations.

```kotlin
import android.provider.Settings

@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}

val reduceMotion = rememberReduceMotion()
val progress by animateFloatAsState(
    targetValue = if (expanded) 1f else 0f,
    animationSpec = if (reduceMotion) snap() else tween(300),
)
```

Also avoid auto-playing looping motion (parallax, background video) when reduce motion is on, and never convey information only through motion. More in [animation.md](animation.md).

## Color and contrast

WCAG AA: 4.5:1 for body text, 3:1 for large text (18 sp regular or 14 sp bold) and for UI component boundaries. Material color roles are designed to meet this when you use container and `on` colors in matching pairs. Custom colors must be checked (see [material3-theming.md](material3-theming.md) for the token setup).

Do not use color as the only signal. An error text field needs an icon or message, not just a red outline; a selected tab needs a shape or underline, not just a tint.

## Focus and traversal order

TalkBack reads in layout order, which usually matches visual order. When it does not (a floating action button composed first but positioned last), set `traversalIndex`:

```kotlin
Modifier.semantics { isTraversalGroup = true }       // on the container
Modifier.semantics { traversalIndex = 1f }           // on children, lower reads first
```

Live regions announce changes without focus moving; use them for a snackbar replacement or a status line, not for the whole screen:

```kotlin
Text(statusText, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
```

## Testing

Unit-level: the Compose test rule works on the same semantics tree TalkBack uses, so assertions on content descriptions, roles and merged text verify accessibility without a device.

```kotlin
@Test
fun messageRow_isOneMergedNodeWithFullReadout() {
    composeRule.setContent { AppTheme { MessageRow(sampleMessage, onOpen = {}) } }
    composeRule.onNodeWithText("John Doe", useUnmergedTree = false).assertExists()
    composeRule.onNode(hasClickAction() and hasText("John Doe", substring = true)).assertIsDisplayed()
}

@Test
fun deleteButton_hasContentDescription() {
    composeRule.setContent { AppTheme { TodoRow(sampleTodo, onToggle = {}, onDelete = {}) } }
    composeRule.onNodeWithContentDescription("Delete").assertHasClickAction()
}
```

Print the tree while debugging with `composeRule.onRoot().printToLog("A11Y")`.

Device-level:

- Enable TalkBack (Settings > Accessibility) and traverse every screen with swipe right. Every interactive element must be reachable and announce its role and state.
- Run Accessibility Scanner (from the Play Store) on each screen; it reports missing labels, small targets and low contrast.
- Enable "Remove animations" and font scale 200% and go through the main flows.
- The Play pre-launch report runs an automated accessibility check and lists findings per screenshot.

## Avoid

```kotlin
// Anti-pattern: empty string instead of null; TalkBack announces nothing but the node remains focusable.
Icon(Icons.Filled.Star, contentDescription = "")

// Anti-pattern: describing the widget type.
contentDescription = "button"

// Anti-pattern: pointerInput for a tap with no semantics.
Modifier.pointerInput(Unit) { detectTapGestures { onClick() } }

// Anti-pattern: fixed height row with sp text.
Row(Modifier.height(56.dp)) { Text(title) }

// Anti-pattern: color only.
Text(amount, color = if (negative) Color.Red else Color.Green)

// Anti-pattern: clearAndSetSemantics on a container with buttons inside.
```

## Verify

```sh
./gradlew :app:testDebugUnitTest          # Robolectric semantics tests
./gradlew :app:connectedDebugAndroidTest   # on-device semantics tests
adb shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService
adb shell settings put system font_scale 2.0
adb shell settings put global animator_duration_scale 0
```

## Sources

- https://developer.android.com/develop/ui/compose/accessibility
- https://developer.android.com/develop/ui/compose/accessibility/semantics
- https://developer.android.com/develop/ui/compose/accessibility/api-defaults
- https://developer.android.com/develop/ui/compose/accessibility/testing
- https://developer.android.com/guide/topics/ui/accessibility/apps
- https://developer.android.com/guide/topics/ui/accessibility/testing
- https://support.google.com/accessibility/android/answer/6376570
