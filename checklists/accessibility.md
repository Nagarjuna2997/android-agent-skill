# Accessibility Checklist

Pass/fail items to run on every screen before release. The how-to is in [../patterns/ui/accessibility.md](../patterns/ui/accessibility.md). Each item states what to check and why it matters; a failure is a bug, not a polish item.

## Labels and semantics

- [ ] Every icon-only control (`IconButton`, FAB, custom clickable) has a `contentDescription` naming the action, because TalkBack otherwise announces "button" with no purpose.
- [ ] Decorative icons and images pass `contentDescription = null`, not `""`, so they are skipped rather than announced as an unlabeled element.
- [ ] Informative images describe their meaning ("Receipt for order 1234"), not their type ("image").
- [ ] Custom interactive composables use `clickable` / `toggleable` / `selectable` with a `Role`, so the role and the action are in the semantics tree; a `pointerInput` tap handler is invisible to accessibility services.
- [ ] Toggles and selections expose state (`stateDescription` or the Material component's built-in state) so TalkBack says "on" or "selected".
- [ ] Section titles are marked with `semantics { heading() }` so users can jump between sections.
- [ ] Text fields have a visible label or a `contentDescription`, and the error message is linked (`Modifier.semantics { error("...") }` or Material's `supportingText` with `isError`).
- [ ] Status changes that do not move focus (a snackbar substitute, a count updating) use `liveRegion = LiveRegionMode.Polite`.

```kotlin
// Pass
IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.action_delete)) }
// Fail
IconButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = "") }
```

## Grouping and traversal

- [ ] List rows read as one node with a sensible sentence: clickable rows merge automatically, non-clickable groups use `semantics(mergeDescendants = true)`.
- [ ] Interactive children inside a merged row remain reachable (not swallowed by `clearAndSetSemantics`), or are exposed as `customActions`.
- [ ] Swipe-to-reveal actions are also available as custom accessibility actions, because swipe gestures are not available to switch or TalkBack users.
- [ ] Focus order follows reading order; where composition order differs from visual order, `traversalIndex` fixes it.
- [ ] Dialogs and bottom sheets trap focus while open and return it on dismiss (Material 3 components do; custom overlays must set `Modifier.semantics { isTraversalGroup = true }` and manage focus).
- [ ] Nothing important is announced only through a `Toast`; toasts are not reliably read.

## Touch targets

- [ ] Every interactive element is at least 48 x 48 dp, verified with Layout Inspector or Accessibility Scanner; small icons use `minimumInteractiveComponentSize()`.
- [ ] Adjacent targets are at least 8 dp apart or combined so a large finger does not trigger the wrong one.
- [ ] Drag and long-press interactions have an alternative (a button, a menu item), because many users cannot perform them.

## Text and scaling

- [ ] All text sizes are in `sp`; nothing converts to `dp` to prevent scaling.
- [ ] Every screen tested at font scale 2.0 (`adb shell settings put system font_scale 2.0`): no clipped text, no overlapping elements, no truncated labels on buttons.
- [ ] Rows and cards grow with content; no fixed heights wrapping text.
- [ ] Long content scrolls; buttons at the bottom of a form remain reachable at large scale.
- [ ] Text is not embedded in images.
- [ ] Line length and `lineHeight` set in typography so paragraphs remain readable when scaled.

## Color and contrast

- [ ] Body text has at least 4.5:1 contrast against its background; large text and UI boundaries at least 3:1. Material container/on-color pairs pass; custom tokens were measured.
- [ ] Both light and dark themes checked; a pair that passes in light often fails in dark.
- [ ] No information conveyed by color alone: errors have text or an icon, selection has a shape change or check, charts have labels or patterns.
- [ ] Disabled states remain legible enough to read what is disabled (Material's 38 percent alpha is the floor).
- [ ] Dynamic color tested with a very light and a very dark wallpaper, since the derived scheme changes contrast.

## Motion

- [ ] Animations respect "Remove animations" (animator scale 0): transitions snap or shorten, and no content depends on seeing the motion.
- [ ] No auto-playing looping motion in content areas; loading indicators are the only infinite animation.
- [ ] No flashing content above three flashes per second.

## Input and devices

- [ ] Every flow completable with a keyboard (Tab, Enter, arrow keys) on a tablet or ChromeOS; focus is visible on the focused element.
- [ ] Every flow completable with Switch Access scanning (test with the Switch Access service and a volume key switch).
- [ ] Voice Access can trigger buttons by their visible label; labels and `contentDescription` match the visible text.
- [ ] Time limits (session timeout, auto-dismissing dialogs) can be extended or are absent.

## Content

- [ ] Error messages say what went wrong and what to do, in plain language.
- [ ] Links and buttons have distinct labels ("View order 1234", not three "View" buttons).
- [ ] Placeholder text is not the only label for a text field; it disappears on input.
- [ ] Screen titles are set (TopAppBar title or `heading()`), so the screen is announced on entry.
- [ ] The app's language is set per text where it differs from the app locale (`LocaleList` in `TextStyle`), so the screen reader uses the right voice.

## Testing done

- [ ] Automated semantics tests exist for icon labels, roles and merged rows (Compose UI tests on the semantics tree).
- [ ] TalkBack walkthrough of every screen with swipe-right traversal; every element announced with role and state, nothing unreachable, nothing announced twice.
- [ ] Accessibility Scanner run on every screen; all "touch target", "text contrast" and "item label" findings resolved or justified in writing.
- [ ] Pre-launch report accessibility section reviewed on the internal track.
- [ ] Font scale 2.0, "Remove animations", high-contrast text, and color inversion each tried once on the main flows.

## Verify

```sh
./gradlew :app:testDebugUnitTest --tests "*A11y*"      # semantics assertions
adb shell settings put system font_scale 2.0
adb shell settings put global animator_duration_scale 0
adb shell settings put secure enabled_accessibility_services com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService
adb shell settings put secure accessibility_enabled 1
# Restore afterwards:
adb shell settings put system font_scale 1.0
adb shell settings put global animator_duration_scale 1
adb shell settings put secure enabled_accessibility_services ""
```

Record which screens were checked with TalkBack and the Scanner; "accessibility looks fine" without a walkthrough is not a pass.

## Sources

- https://developer.android.com/guide/topics/ui/accessibility/apps
- https://developer.android.com/develop/ui/compose/accessibility
- https://developer.android.com/develop/ui/compose/accessibility/testing
- https://developer.android.com/guide/topics/ui/accessibility/testing
- https://support.google.com/accessibility/android/answer/6376570 (Accessibility Scanner)
- https://support.google.com/accessibility/android/answer/6283677 (TalkBack)
- https://m3.material.io/foundations/accessible-design/overview
