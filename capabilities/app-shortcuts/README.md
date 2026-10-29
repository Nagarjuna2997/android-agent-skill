# App shortcuts

Static, dynamic and pinned launcher shortcuts through `ShortcutManagerCompat`: XML-declared static shortcuts, dynamic shortcuts published from a repository with rank and icons, pinned shortcuts with user confirmation, routing shortcut intents through the same deep-link parser as App Links, usage reporting, and verification with `adb`.

## When to use

- Long-press on the launcher icon should offer quick entry points: "New note", "Search", the user's most recent conversations.
- Dynamic shortcuts for personalized, changing targets; static for fixed actions; pinned when the user explicitly adds one to the home screen.
- Android limits visible shortcuts to about four per app on most launchers (`getMaxShortcutCountPerActivity`); keep the list short and ranked.

## Dependencies

```toml
[versions]
core = "<version>"   # https://developer.android.com/jetpack/androidx/releases/core

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "core" }
```

```kotlin
dependencies {
    implementation(libs.androidx.core.ktx)
}
```

`ShortcutManagerCompat` and `ShortcutInfoCompat` are in `androidx.core.content.pm`; no other artifact needed.

## Manifest and permissions

Static shortcuts are declared on the launcher Activity:

```xml
<activity android:name=".MainActivity" android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
    <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />
</activity>
```

`res/xml/shortcuts.xml`:

```xml
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <shortcut
        android:shortcutId="new_note"
        android:enabled="true"
        android:icon="@drawable/ic_shortcut_add"
        android:shortcutShortLabel="@string/shortcut_new_note_short"
        android:shortcutLongLabel="@string/shortcut_new_note_long">
        <intent
            android:action="android.intent.action.VIEW"
            android:data="https://example.com/notes/new"
            android:targetPackage="com.example.app"
            android:targetClass="com.example.app.MainActivity" />
        <categories android:name="android.shortcut.conversation" />
    </shortcut>
</shortcuts>
```

The `android:data` URL reuses the App Link routes from [deep-links](../deep-links/README.md) so one parser handles both. No permissions.

## Implementation

### Dynamic shortcuts

```kotlin
package com.example.app.shortcuts

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.net.toUri
import com.example.app.MainActivity
import com.example.app.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

data class RecentConversation(val id: String, val title: String)

@Singleton
class ShortcutPublisher @Inject constructor(@ApplicationContext private val context: Context) {

    fun publishRecentConversations(recent: List<RecentConversation>) {
        val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context).coerceAtMost(4)
        val shortcuts = recent.take(max).mapIndexed { index, c ->
            ShortcutInfoCompat.Builder(context, "conversation_${c.id}")
                .setShortLabel(c.title.take(10))
                .setLongLabel(c.title.take(25))
                .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_chat))
                .setIntent(
                    Intent(Intent.ACTION_VIEW, "https://example.com/chat/${c.id}".toUri(), context, MainActivity::class.java)
                )
                .setRank(index)                       // 0 is shown first
                .setCategories(setOf("android.shortcut.conversation"))
                .setLongLived(true)                   // lets the system cache it for sharing surfaces
                .build()
        }
        ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)
    }

    fun reportUsed(conversationId: String) =
        ShortcutManagerCompat.reportShortcutUsed(context, "conversation_$conversationId")

    fun removeConversation(conversationId: String) =
        ShortcutManagerCompat.removeDynamicShortcuts(context, listOf("conversation_$conversationId"))

    fun removeAll() = ShortcutManagerCompat.removeAllDynamicShortcuts(context)
}
```

Call `publishRecentConversations` from the repository after the recent list changes, off the main thread. `setDynamicShortcuts` replaces the whole set; `pushDynamicShortcut` adds one and evicts the lowest-ranked when the limit is hit. Labels are truncated by launchers at about 10 and 25 characters.

### Pinned shortcuts

```kotlin
fun requestPin(context: Context, conversation: RecentConversation) {
    if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) return
    val info = ShortcutInfoCompat.Builder(context, "conversation_${conversation.id}")
        .setShortLabel(conversation.title)
        .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_chat))
        .setIntent(Intent(Intent.ACTION_VIEW, "https://example.com/chat/${conversation.id}".toUri(), context, MainActivity::class.java))
        .build()
    ShortcutManagerCompat.requestPinShortcut(context, info, null)
}
```

The launcher shows a confirmation dialog; the app cannot pin silently. Pinned shortcuts persist until the user removes them, so when the target disappears call `ShortcutManagerCompat.disableShortcuts(context, ids, "This conversation was deleted")` rather than removing, so a tap shows the message.

### Handling the intent

Nothing extra: the Activity receives `ACTION_VIEW` with the `https` URI and `NavHost` or `DeepLinkParser` routes it exactly like an App Link. Report usage in the destination's ViewModel so the system can rank the shortcut:

```kotlin
@HiltViewModel
class ChatViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val shortcuts: ShortcutPublisher,
) : ViewModel() {
    private val route = savedStateHandle.toRoute<ChatRoute>()
    init { shortcuts.reportUsed(route.conversationId) }
}
```

### Shortcuts for sharing

Long-lived conversation shortcuts with the `android.shortcut.conversation` category also appear as direct share targets when the app declares a `<meta-data android:name="android.service.chooser.chooser_target_service">` and a share-target XML; see the sharing documentation if the app sends content between users.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell dumpsys shortcut --package com.example.app     # lists static, dynamic and pinned shortcuts with ranks
adb shell cmd shortcut get-shortcuts com.example.app     # API 33+; machine-readable
adb shell am start -a android.intent.action.VIEW -d "https://example.com/notes/new" com.example.app   # same path a shortcut tap takes
```

Robolectric test:

```kotlin
@RunWith(RobolectricTestRunner::class)
class ShortcutPublisherTest {
    @Test fun publishesRankedShortcuts() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        ShortcutPublisher(context).publishRecentConversations(
            listOf(RecentConversation("a", "Ana"), RecentConversation("b", "Ben"))
        )
        val shortcuts = ShortcutManagerCompat.getDynamicShortcuts(context)
        assertEquals(listOf("conversation_a", "conversation_b"), shortcuts.sortedBy { it.rank }.map { it.id })
    }
}
```

Then on the emulator long-press the launcher icon and confirm the entries appear with icons; launchers vary, so record that as a manual device check.

## Pitfalls

- Static shortcut intents must name `targetPackage` and `targetClass`; the launcher does not resolve implicit intents.
- Shortcut ids are stable keys. Changing the id scheme orphans pinned shortcuts; disable them with a message instead of deleting.
- Publishing from the main thread with large bitmaps (`IconCompat.createWithBitmap`) janks; use adaptive bitmap icons sized at 48 dp and publish off-main.
- The launcher may show fewer shortcuts than `getMaxShortcutCountPerActivity`; keep the most useful ones at rank 0 and 1.
- Static and dynamic shortcuts sharing an id conflict; prefix dynamic ids.
- Shortcut labels are not localized automatically for dynamic shortcuts; rebuild them on locale change (listen for `ACTION_LOCALE_CHANGED` or re-publish on app start).

## Sources

- https://developer.android.com/develop/ui/views/launch/shortcuts
- https://developer.android.com/develop/ui/views/launch/shortcuts/creating-shortcuts
- https://developer.android.com/develop/ui/views/launch/shortcuts/managing-shortcuts
- https://developer.android.com/develop/ui/views/launch/shortcuts/best-practices
- https://developer.android.com/reference/androidx/core/content/pm/ShortcutManagerCompat
