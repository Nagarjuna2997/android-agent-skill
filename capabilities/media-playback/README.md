# Media playback

Audio and video playback with Media3 1.11.1: an `ExoPlayer` owned by a `MediaSessionService` so playback survives the UI, a `MediaController` in the app connected through `SessionToken`, a `PlayerView` in Compose for video, playback state exposed as `StateFlow`, the foreground service type and notification, and an instrumented test that plays a bundled asset.

## When to use

- Playing audio or video from a URL, a local file or `res/raw`: podcasts, music, course videos, voice notes.
- A `MediaSessionService` is the right structure for anything the user expects to keep playing in the background or control from the lock screen and headphones. For a short, screen-bound clip with no background need, a plain `ExoPlayer` in the ViewModel is enough; the service section can be skipped.

## Dependencies

```toml
[versions]
media3 = "1.11.1"

[libraries]
media3-exoplayer = { group = "androidx.media3", name = "media3-exoplayer", version.ref = "media3" }
media3-exoplayer-hls = { group = "androidx.media3", name = "media3-exoplayer-hls", version.ref = "media3" }   # optional, HLS streams
media3-session = { group = "androidx.media3", name = "media3-session", version.ref = "media3" }
media3-ui-compose = { group = "androidx.media3", name = "media3-ui-compose", version.ref = "media3" }
media3-ui = { group = "androidx.media3", name = "media3-ui", version.ref = "media3" }                         # PlayerView if not using the Compose surface
media3-test-utils = { group = "androidx.media3", name = "media3-test-utils", version.ref = "media3" }
```

```kotlin
dependencies {
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)
    implementation(libs.media3.ui.compose)
    androidTestImplementation(libs.media3.test.utils)
}
```

## Manifest and permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<application ...>
    <service
        android:name=".playback.PlaybackService"
        android:exported="true"
        android:foregroundServiceType="mediaPlayback">
        <intent-filter>
            <action android:name="androidx.media3.session.MediaSessionService" />
        </intent-filter>
    </service>
</application>
```

`exported="true"` lets system media controls and other controllers bind. Media3 posts the media notification itself; `POST_NOTIFICATIONS` keeps it visible on API 33+.

## Implementation

### Service

```kotlin
package com.example.app.playback

import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder().setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).setUsage(C.USAGE_MEDIA).build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)   // pause when headphones unplug
            .build()
        session = MediaSession.Builder(this, player)
            .setSessionActivity(
                android.app.PendingIntent.getActivity(
                    this, 0, packageManager.getLaunchIntentForPackage(packageName),
                    android.app.PendingIntent.FLAG_IMMUTABLE,
                )
            )
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player ?: return
        if (!player.playWhenReady || player.mediaItemCount == 0) stopSelf()   // nothing playing: let the service die
    }

    override fun onDestroy() {
        session?.run { player.release(); release() }
        session = null
        super.onDestroy()
    }
}
```

Media3 handles the foreground notification, media buttons, Bluetooth and the system media controls through the session.

### Controller repository

```kotlin
package com.example.app.playback

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.MoreExecutors
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.guava.await
import javax.inject.Inject
import javax.inject.Singleton

data class PlaybackState(
    val isPlaying: Boolean = false,
    val buffering: Boolean = false,
    val title: String? = null,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val error: String? = null,
)

interface PlaybackRepository {
    suspend fun controller(): Player
    fun state(): Flow<PlaybackState>
    suspend fun play(uri: String, title: String, artworkUri: String?)
    suspend fun togglePlayPause()
    suspend fun seekTo(ms: Long)
    fun release()
}

@Singleton
class Media3PlaybackRepository @Inject constructor(@ApplicationContext private val context: Context) : PlaybackRepository {
    private var controller: MediaController? = null

    override suspend fun controller(): Player {
        controller?.let { return it }
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        return MediaController.Builder(context, token).buildAsync().await().also { controller = it }
    }

    override fun state(): Flow<PlaybackState> = callbackFlow {
        val player = controller()
        fun snapshot() = PlaybackState(
            isPlaying = player.isPlaying,
            buffering = player.playbackState == Player.STATE_BUFFERING,
            title = player.mediaMetadata.title?.toString(),
            positionMs = player.currentPosition,
            durationMs = player.duration.coerceAtLeast(0),
            error = player.playerError?.message,
        )
        val listener = object : Player.Listener {
            override fun onEvents(p: Player, events: Player.Events) { trySend(snapshot()) }
        }
        player.addListener(listener)
        trySend(snapshot())
        awaitClose { player.removeListener(listener) }
    }

    override suspend fun play(uri: String, title: String, artworkUri: String?) {
        val item = MediaItem.Builder()
            .setUri(uri)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setArtworkUri(artworkUri?.let(android.net.Uri::parse)).build())
            .build()
        controller().apply { setMediaItem(item); prepare(); play() }
    }

    override suspend fun togglePlayPause() { controller().apply { if (isPlaying) pause() else play() } }
    override suspend fun seekTo(ms: Long) { controller().seekTo(ms) }

    override fun release() { controller?.release(); controller = null }
}
```

`kotlinx-coroutines-guava` provides `ListenableFuture.await()`. Build the controller once per process; release it when the app is finished with playback UI (not on every screen change).

### ViewModel and Compose

```kotlin
@HiltViewModel
class PlayerViewModel @Inject constructor(private val playback: PlaybackRepository) : ViewModel() {
    val state: StateFlow<PlaybackState> = playback.state()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PlaybackState())

    // Position ticks for the slider while playing.
    val position: StateFlow<Long> = flow {
        while (true) { emit(playback.controller().currentPosition); delay(500) }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), 0L)

    fun play(uri: String, title: String) = viewModelScope.launch { playback.play(uri, title, null) }
    fun toggle() = viewModelScope.launch { playback.togglePlayPause() }
    fun seek(ms: Long) = viewModelScope.launch { playback.seekTo(ms) }
}

@Composable
fun VideoPlayer(viewModel: PlayerViewModel) {
    var player by remember { mutableStateOf<Player?>(null) }
    LaunchedEffect(Unit) { player = viewModel.controllerForUi() }   // expose suspend controller() through the ViewModel
    player?.let { p ->
        PlayerSurface(player = p, surfaceType = SURFACE_TYPE_SURFACE_VIEW, modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f))
    }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val position by viewModel.position.collectAsStateWithLifecycle()
    Row {
        IconButton(onClick = viewModel::toggle, modifier = Modifier.size(48.dp)) {
            Icon(if (state.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = if (state.isPlaying) "Pause" else "Play")
        }
        Slider(
            value = if (state.durationMs > 0) position.toFloat() / state.durationMs else 0f,
            onValueChange = { viewModel.seek((it * state.durationMs).toLong()) },
            modifier = Modifier.weight(1f),
        )
    }
}
```

`PlayerSurface` comes from `androidx.media3.ui.compose`. For audio-only screens omit the surface and show artwork with Coil.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell dumpsys media_session | grep -A5 com.example.app   # active session appears while playing
adb shell dumpsys activity services com.example.app | grep PlaybackService
adb shell input keyevent KEYCODE_MEDIA_PLAY_PAUSE            # toggles through the session
./gradlew :app:connectedDebugAndroidTest --tests "*PlaybackTest*"
```

Instrumented test with a bundled asset (`src/androidTest/assets/tone.mp3`):

```kotlin
@Test fun playsBundledAsset() = runTest {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val player = ExoPlayer.Builder(context).build()
    try {
        withContext(Dispatchers.Main) {
            player.setMediaItem(MediaItem.fromUri("asset:///tone.mp3"))
            player.prepare(); player.play()
        }
        val playing = withTimeoutOrNull(10_000) {
            while (!withContext(Dispatchers.Main) { player.isPlaying }) delay(100)
            true
        }
        assertTrue(playing == true)
    } finally {
        withContext(Dispatchers.Main) { player.release() }
    }
}
```

`ExoPlayer` must be accessed from the thread it was built on (the main thread here).

## Pitfalls

- Accessing `ExoPlayer` from a background thread throws `IllegalStateException: Player is accessed on the wrong thread`.
- Forgetting `foregroundServiceType="mediaPlayback"` crashes on API 34+ when the service goes foreground.
- Building a `MediaController` per screen leaks bindings and spawns connections; keep one in the repository.
- Without `handleAudioFocus = true`, playback keeps going over phone calls and other apps' audio.
- A `MediaSessionService` that is not stopped when nothing is playing keeps a notification alive; `onTaskRemoved` above handles the swipe-away case.
- Position must be polled; there is no position callback. Keep the poll `WhileSubscribed` so it stops off-screen.
- Media3 `ui-compose` APIs are newer than the `PlayerView` path and some are marked `@UnstableApi`; add `@OptIn(UnstableApi::class)` only on the composable that needs it and say so in the report.

## Going further

This recipe is the single-stream case. When the app has a catalog to browse, must appear in Android Auto or Android Automotive OS, needs playback resumption from the system media controls after process death, or supports Cast, move the service to `MediaLibraryService` and follow `capabilities/media-session-service/README.md`. It keeps the `ExoPlayer`, `MediaController` repository and Compose controls from here and adds the browse tree, caller allowlisting, `DefaultMediaNotificationProvider` and `media3-cast`. The architecture it teaches is the one from Google's UAMP sample, re-expressed on Media3 1.11.1 (`references/uamp.md`).

## Sources

- https://developer.android.com/media/media3
- https://developer.android.com/media/media3/exoplayer/hello-world
- https://developer.android.com/media/media3/session/background-playback
- https://developer.android.com/media/media3/ui/compose
- https://developer.android.com/jetpack/androidx/releases/media3
