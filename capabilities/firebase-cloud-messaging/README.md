# Firebase Cloud Messaging

Push notifications with FCM from the Firebase BoM 34.18.0: a `FirebaseMessagingService` that handles data messages and token rotation, registering the token with your backend through a repository and WorkManager, topic subscriptions, the `POST_NOTIFICATIONS` permission and a test send with the HTTP v1 API.

## When to use

- The server needs to wake the app or show a notification: new message, order update, reminder.
- Send data messages (not notification messages) whenever the app must control the notification or update local state, because notification messages bypass `onMessageReceived` when the app is in the background.
- Local notification building is in [notifications](../notifications/README.md); this recipe only delivers the payload.

## Dependencies

```toml
[versions]
firebase-bom = "34.18.0"
google-services = "<version>"   # https://firebase.google.com/docs/android/setup
workmanager = "2.12.0"

[libraries]
firebase-bom = { group = "com.google.firebase", name = "firebase-bom", version.ref = "firebase-bom" }
firebase-messaging = { group = "com.google.firebase", name = "firebase-messaging" }
work-runtime = { group = "androidx.work", name = "work-runtime-ktx", version.ref = "workmanager" }
kotlinx-coroutines-play-services = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-play-services", version = "<version>" }

[plugins]
google-services = { id = "com.google.gms.google-services", version.ref = "google-services" }
```

```kotlin
plugins { alias(libs.plugins.google.services) }
dependencies {
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.work.runtime)
    implementation(libs.kotlinx.coroutines.play.services)
}
```

## Manifest and permissions

```xml
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<application ...>
    <service
        android:name=".push.AppMessagingService"
        android:exported="false">
        <intent-filter>
            <action android:name="com.google.firebase.MESSAGING_EVENT" />
        </intent-filter>
    </service>

    <!-- Defaults used only by notification messages when the app is in background -->
    <meta-data android:name="com.google.firebase.messaging.default_notification_icon"
        android:resource="@drawable/ic_stat_message" />
    <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id"
        android:value="messages" />
</application>
```

The channel id in the meta-data must be one you create at startup (see [notifications](../notifications/README.md)).

## Implementation

### Messaging service

```kotlin
package com.example.app.push

import com.example.app.notifications.Notifier
import com.example.app.work.TokenUploadWorker
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class AppMessagingService : FirebaseMessagingService() {
    @Inject lateinit var notifier: Notifier
    @Inject lateinit var pushRouter: PushRouter

    override fun onNewToken(token: String) {
        TokenUploadWorker.enqueue(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        // Called for data messages in any app state, and for notification messages only in foreground.
        val data = message.data
        when (data["type"]) {
            "chat" -> {
                val conversation = data["conversationId"] ?: return
                val sender = data["sender"] ?: return
                val text = data["text"] ?: return
                val id = data["messageId"]?.toIntOrNull() ?: conversation.hashCode()
                pushRouter.onChatMessage(conversation)         // refresh local cache
                notifier.showMessage(conversation, sender, text, id)
            }
            "sync" -> pushRouter.requestSync()                  // silent: enqueue WorkManager, no notification
            else -> Unit                                        // unknown types are ignored
        }
    }
}
```

`onMessageReceived` runs on a background thread with about 20 seconds before the process may be killed; anything longer goes to WorkManager. Data payload values are strings; validate every field.

### Token registration

```kotlin
package com.example.app.push

import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

interface PushTokenRepository {
    suspend fun currentToken(): String
    suspend fun register(token: String): Result<Unit>     // POST to your server with the session
    suspend fun unregister(): Result<Unit>
    suspend fun subscribe(topic: String)
    suspend fun unsubscribe(topic: String)
}

class FcmPushTokenRepository @Inject constructor(
    private val messaging: FirebaseMessaging,
    private val api: DeviceApi,
) : PushTokenRepository {
    override suspend fun currentToken(): String = messaging.token.await()

    override suspend fun register(token: String): Result<Unit> = safely { api.registerDevice(token) }

    override suspend fun unregister(): Result<Unit> = safely {
        api.unregisterDevice(currentToken())
        messaging.deleteToken().await()
    }

    private inline fun <T> safely(block: () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: java.io.IOException) {
        Result.failure(e)
    }

    override suspend fun subscribe(topic: String) { messaging.subscribeToTopic(topic).await() }
    override suspend fun unsubscribe(topic: String) { messaging.unsubscribeFromTopic(topic).await() }
}
```

Upload the token when it changes (`onNewToken`) and after sign-in (`currentToken()` then `register`), through a worker so it retries offline:

```kotlin
@HiltWorker
class TokenUploadWorker @AssistedInject constructor(
    @Assisted ctx: Context, @Assisted params: WorkerParameters,
    private val repo: PushTokenRepository,
) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val token = inputData.getString(KEY_TOKEN) ?: repo.currentToken()
        return repo.register(token).fold({ Result.success() }, { if (runAttemptCount < 5) Result.retry() else Result.failure() })
    }
    companion object {
        private const val KEY_TOKEN = "token"
        fun enqueue(context: Context, token: String? = null) {
            val req = OneTimeWorkRequestBuilder<TokenUploadWorker>()
                .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))
                .setInputData(workDataOf(KEY_TOKEN to token))
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("push-token", ExistingWorkPolicy.REPLACE, req)
        }
    }
}
```

On sign-out call `unregister()` so the old user stops receiving pushes on this device.

### Hilt

```kotlin
@Module @InstallIn(SingletonComponent::class)
object MessagingModule {
    @Provides @Singleton fun messaging(): FirebaseMessaging = Firebase.messaging
}
```

### Permission and settings UI

Request `POST_NOTIFICATIONS` from the screen that explains why (for example when the user enables message alerts), using the `NotificationPermissionGate` from [notifications](../notifications/README.md). Expose a toggle backed by DataStore that calls `subscribe("news")`/`unsubscribe("news")` for topic-based broadcasts.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell pm grant com.example.app android.permission.POST_NOTIFICATIONS
adb logcat -s FirebaseMessaging AppMessagingService     # token and message logs

# Print the token from a debug screen or log, then send a data message with the HTTP v1 API:
TOKEN=$(gcloud auth print-access-token)
curl -sS -X POST "https://fcm.googleapis.com/v1/projects/<project-id>/messages:send" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":{"token":"<device-token>","data":{"type":"chat","conversationId":"c1","sender":"Ana","text":"Hi","messageId":"7"}}}'
```

Unit test of the routing logic (extract the `when` into a `PushPayloadHandler` class that takes `Map<String, String>` so it is testable without the service):

```kotlin
@Test fun chatPayloadPostsNotification() {
    val notifier = FakeNotifier()
    val handler = PushPayloadHandler(notifier, FakePushRouter())
    handler.handle(mapOf("type" to "chat", "conversationId" to "c1", "sender" to "Ana", "text" to "Hi", "messageId" to "7"))
    assertEquals(listOf(7), notifier.shownIds)
}
```

The Firebase console's "Send test message" only sends notification messages; use the v1 API for data messages.

## Pitfalls

- Notification messages (payload with `notification`) are displayed by the system in the background and never reach `onMessageReceived`; the app cannot update state or customize them. Send data messages.
- Tokens rotate; a server that only stores the first token loses the device silently. Handle `onNewToken` and re-upload after reinstall.
- Without `POST_NOTIFICATIONS` on API 33+ data messages still arrive, but `notify()` is dropped. Keep the silent-sync path independent of the permission.
- Hilt field injection in the service requires `@AndroidEntryPoint`; the service is instantiated by the system, not by Hilt.
- Doze and app standby delay normal-priority messages. Use `"android": {"priority": "high"}` only for time-sensitive, user-visible content; abuse lowers your priority bucket.
- The legacy FCM HTTP API is shut down; servers must use HTTP v1 with a service account.
- Do not log full tokens in release builds.

## Sources

- https://firebase.google.com/docs/cloud-messaging/android/client
- https://firebase.google.com/docs/cloud-messaging/android/receive
- https://firebase.google.com/docs/cloud-messaging/concept-options
- https://firebase.google.com/docs/cloud-messaging/send-message
- https://developer.android.com/develop/ui/views/notifications/notification-permission
