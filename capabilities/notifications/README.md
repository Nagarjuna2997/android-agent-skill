# Notifications

Local notifications with `NotificationCompat`: channels created at startup, the `POST_NOTIFICATIONS` runtime permission flow on API 33+ in Compose, action buttons handled by a `BroadcastReceiver`, grouping with a summary, deep-link tap intents and verification with `adb` and a UI test.

## When to use

- Any notification the app posts itself: reminders, completed downloads, sync results, foreground-service progress, message previews.
- Remote pushes still end in a local notification; combine with [firebase-cloud-messaging](../firebase-cloud-messaging/README.md), which calls the same `Notifier`.
- Do not post a notification for things the user can see on screen, and never for marketing without an opt-in; Android lets users block channels and uninstall rates follow noisy apps.

## Dependencies

```toml
[versions]
core = "<version>"   # androidx.core-ktx; https://developer.android.com/jetpack/androidx/releases/core

[libraries]
androidx-core-ktx = { group = "androidx.core", name = "core-ktx", version.ref = "core" }
accompanist-permissions = { group = "com.google.accompanist", name = "accompanist-permissions", version = "<version>" }  # optional; https://github.com/google/accompanist/releases
```

```kotlin
dependencies {
    implementation(libs.androidx.core.ktx)
}
```

`NotificationCompat` and `NotificationManagerCompat` live in `androidx.core`. The recipe below uses `rememberLauncherForActivityResult` from `androidx.activity:activity-compose`, which the Compose BOM already brings in, so Accompanist is optional.

## Manifest and permissions

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<application ...>
    <receiver
        android:name=".notifications.NotificationActionReceiver"
        android:exported="false" />
</application>
```

`POST_NOTIFICATIONS` is a runtime permission on API 33+. On older devices it is granted at install. The minSdk of 26 in the templates exists partly because channels are required from API 26; below that, `NotificationCompat` ignores the channel id.

## Implementation

### Channels

```kotlin
package com.example.app.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationManagerCompat
import com.example.app.R

object Channels {
    const val REMINDERS = "reminders"
    const val SYNC = "sync"
    const val MESSAGES = "messages"

    fun create(context: Context) {
        val manager = NotificationManagerCompat.from(context)
        manager.createNotificationChannelsCompat(
            listOf(
                NotificationChannelCompat.Builder(REMINDERS, NotificationManagerCompat.IMPORTANCE_HIGH)
                    .setName(context.getString(R.string.channel_reminders))
                    .setDescription(context.getString(R.string.channel_reminders_desc))
                    .build(),
                NotificationChannelCompat.Builder(SYNC, NotificationManagerCompat.IMPORTANCE_LOW)
                    .setName(context.getString(R.string.channel_sync))
                    .setShowBadge(false)
                    .build(),
                NotificationChannelCompat.Builder(MESSAGES, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                    .setName(context.getString(R.string.channel_messages))
                    .build(),
            )
        )
    }
}
```

Call `Channels.create(this)` in `Application.onCreate()`. Creating an existing channel is a no-op; importance can only be lowered by the user afterwards, so choose the initial importance carefully.

### Notifier

```kotlin
package com.example.app.notifications

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import com.example.app.MainActivity
import com.example.app.R
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class Notifier @Inject constructor(@ApplicationContext private val context: Context) {

    private val manager = NotificationManagerCompat.from(context)

    fun canPost(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED && manager.areNotificationsEnabled()

    fun showMessage(conversationId: String, sender: String, text: String, messageId: Int) {
        if (!canPost()) return

        val contentIntent = PendingIntent.getActivity(
            context, messageId,
            Intent(Intent.ACTION_VIEW, "https://example.com/chat/$conversationId".toUri(), context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val markRead = PendingIntent.getBroadcast(
            context, messageId,
            Intent(context, NotificationActionReceiver::class.java)
                .setAction(NotificationActionReceiver.ACTION_MARK_READ)
                .putExtra(NotificationActionReceiver.EXTRA_CONVERSATION, conversationId)
                .putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION_ID, messageId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, Channels.MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_message)        // monochrome, transparent background
            .setContentTitle(sender)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setGroup(GROUP_MESSAGES)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)  // pre-26 devices
            .addAction(R.drawable.ic_done, context.getString(R.string.mark_read), markRead)
            .build()

        manager.notify(messageId, notification)
        postSummary()
    }

    private fun postSummary() {
        val summary = NotificationCompat.Builder(context, Channels.MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setStyle(NotificationCompat.InboxStyle().setSummaryText(context.getString(R.string.new_messages)))
            .setGroup(GROUP_MESSAGES)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .build()
        manager.notify(SUMMARY_ID, summary)
    }

    fun cancel(id: Int) = manager.cancel(id)

    private companion object {
        const val GROUP_MESSAGES = "com.example.app.MESSAGES"
        const val SUMMARY_ID = 0
    }
}
```

The content intent carries an App Link URI so tapping routes through the same deep-link handling as external links; see [deep-links](../deep-links/README.md). `FLAG_IMMUTABLE` is mandatory on API 31+ unless the system needs to fill in the intent (direct reply uses `FLAG_MUTABLE`).

### Action receiver

```kotlin
package com.example.app.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import com.example.app.data.MessageRepository
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class NotificationActionReceiver : BroadcastReceiver() {
    @Inject lateinit var repository: MessageRepository
    @Inject @ApplicationScope lateinit var scope: CoroutineScope

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_MARK_READ) return
        val conversation = intent.getStringExtra(EXTRA_CONVERSATION) ?: return
        val id = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1)
        val pending = goAsync()
        scope.launch {
            try {
                repository.markRead(conversation)
                NotificationManagerCompat.from(context).cancel(id)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_MARK_READ = "com.example.app.MARK_READ"
        const val EXTRA_CONVERSATION = "conversation"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
    }
}
```

`goAsync()` gives roughly ten seconds for the coroutine; anything longer should enqueue WorkManager.

### Runtime permission in Compose

```kotlin
package com.example.app.ui.permissions

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect

@Composable
fun NotificationPermissionGate(onResult: (granted: Boolean) -> Unit) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        LaunchedEffect(Unit) { onResult(true) }
        return
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission(), onResult)
    Button(onClick = { launcher.launch(Manifest.permission.POST_NOTIFICATIONS) }) {
        Text("Turn on reminders")
    }
}
```

Ask in context (when the user enables reminders), not at first launch. If `shouldShowRequestPermissionRationale` returns false after a denial, show a message with a button to `Settings.ACTION_APP_NOTIFICATION_SETTINGS` instead of re-launching the request.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell pm grant com.example.app android.permission.POST_NOTIFICATIONS
adb shell dumpsys notification --noredact | grep -A5 "pkg=com.example.app"   # posted notifications and channels
adb shell cmd notification list com.example.app                               # ids currently shown
```

Instrumented UI test:

```kotlin
@Test fun notificationAppearsWithAction() {
    val notifier = Notifier(ApplicationProvider.getApplicationContext())
    notifier.showMessage("c1", "Ana", "Hello", messageId = 42)

    val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    device.openNotification()
    assertTrue(device.wait(Until.hasObject(By.text("Hello")), 5_000))
    assertTrue(device.hasObject(By.text("Mark read")))
    device.pressBack()
}
```

Add `@get:Rule val grant = GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)` and the UI Automator dependency (`androidx.test.uiautomator:uiautomator`) for this test.

## Pitfalls

- Posting without checking `canPost()` on API 33+ throws `SecurityException` through lint and is silently dropped at runtime.
- A colored or opaque small icon renders as a white square on the status bar. Use a monochrome vector with a transparent background.
- Reusing the same notification id for different messages replaces the previous one; use stable per-item ids and a separate summary id.
- Group members without a summary are not grouped on API 24+. Always post the summary.
- `PendingIntent` without `FLAG_IMMUTABLE` or `FLAG_MUTABLE` crashes on API 31+.
- Channel importance set too high (`IMPORTANCE_HIGH` for a sync channel) trains users to block the app.
- Foreground-service notifications need the matching `foregroundServiceType`; see [work-manager](../work-manager/README.md).
- `BroadcastReceiver.onReceive` runs on the main thread; never do I/O there without `goAsync()`.

## Sources

- https://developer.android.com/develop/ui/views/notifications
- https://developer.android.com/develop/ui/views/notifications/notification-permission
- https://developer.android.com/develop/ui/views/notifications/channels
- https://developer.android.com/develop/ui/views/notifications/group
- https://developer.android.com/develop/ui/views/notifications/build-notification
