# Media session service

A full music-app playback architecture on Media3 1.11.1, re-expressing the structure of Google's UAMP sample (see `references/uamp.md`): one `MediaLibraryService` owning an `ExoPlayer` and a `MediaLibrarySession`, a browse tree served to Android Auto and Android Automotive OS, caller allowlisting, the media notification from `DefaultMediaNotificationProvider`, a `MediaBrowser` in the app behind a `StateFlow` repository with a Compose browse-and-play screen, playback resumption, and Cast through `media3-cast`. The basics (service, foreground type, `MediaController`, `PlayerSurface`, the asset test) are in `capabilities/media-playback/README.md`; this recipe builds on it and does not repeat them.

## When to use

- A music, podcast or audiobook app with a catalog users browse, that must work from the car, the lock screen, headphones, Assistant and Cast as well as the phone screen.
- Read `capabilities/media-playback/README.md` first. If the app plays one stream with no catalog and no car support, that recipe alone is enough. Use this one when any of these apply: a browsable library, Android Auto or Automotive, Cast, resumption from the system media controls after process death.

## Dependencies

```toml
[versions]
media3 = "1.11.1"
playServicesCast = "<version>"   # https://developers.google.com/cast/docs/release-notes (Cast only)

[libraries]
media3-exoplayer = { group = "androidx.media3", name = "media3-exoplayer", version.ref = "media3" }
media3-session = { group = "androidx.media3", name = "media3-session", version.ref = "media3" }
media3-ui-compose = { group = "androidx.media3", name = "media3-ui-compose", version.ref = "media3" }
media3-cast = { group = "androidx.media3", name = "media3-cast", version.ref = "media3" }
play-services-cast-framework = { group = "com.google.android.gms", name = "play-services-cast-framework", version.ref = "playServicesCast" }
kotlinx-coroutines-guava = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-guava", version = "<version>" }   # https://github.com/Kotlin/kotlinx.coroutines/releases
```

```kotlin
dependencies {
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)
    implementation(libs.media3.ui.compose)
    implementation(libs.kotlinx.coroutines.guava)
    implementation(libs.media3.cast)                  // Cast only
    implementation(libs.play.services.cast.framework) // Cast only
}
```

## Manifest and permissions

Permissions are the same as `media-playback` (`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS`, `INTERNET`). The service declaration changes: both the Media3 action and the legacy browser action, because Android Auto, Automotive and Assistant still bind through `MediaBrowserCompat`.

```xml
<application ...>
    <!-- Android Auto (projected): declares that this app provides media to the car. -->
    <meta-data android:name="com.google.android.gms.car.application" android:resource="@xml/automotive_app_desc" />
    <!-- Cast only: the options provider that media3-cast reads. -->
    <meta-data
        android:name="com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME"
        android:value="androidx.media3.cast.DefaultCastOptionsProvider" />

    <service
        android:name=".playback.MusicService"
        android:exported="true"
        android:foregroundServiceType="mediaPlayback">
        <intent-filter>
            <action android:name="androidx.media3.session.MediaLibraryService" />
            <action android:name="android.media.browse.MediaBrowserService" />
        </intent-filter>
    </service>
</application>
```

`res/xml/automotive_app_desc.xml`:

```xml
<automotiveApp>
    <uses name="media" />
</automotiveApp>
```

Android Automotive OS is a separate `:automotive` module (same `applicationId`, its own launcher-less manifest) that adds `<uses-feature android:name="android.hardware.type.automotive" android:required="true" />` and `<meta-data android:name="com.android.automotive" android:resource="@xml/automotive_app_desc" />`, and targets API 35 or higher per `data/versions.json` (`policy.newAppsAndUpdates.automotive`). The service class is shared from a `:playback` library module.

## Implementation

### Catalog and browse tree

The tree is plain Kotlin behind an interface, so it is unit-testable and the service only asks it for items.

```kotlin
package com.example.app.playback.library

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaConstants

data class Track(val id: String, val title: String, val artist: String, val album: String, val uri: Uri, val artworkUri: Uri?)

interface MusicCatalog {
    suspend fun tracks(): List<Track>
}

object BrowseIds {
    const val ROOT = "root"
    const val EMPTY_ROOT = "empty"
    const val RECOMMENDED = "recommended"
    const val ALBUMS = "albums"
    fun album(name: String): String = "album:$name"
}

class BrowseTree(private val catalog: MusicCatalog) {
    // Technique from android/uamp (Apache-2.0): a map from parent id to children, built once from the catalog.
    private var children: Map<String, List<MediaItem>> = emptyMap()
    private var byId: Map<String, Track> = emptyMap()

    suspend fun load() {
        val tracks = catalog.tracks()
        byId = tracks.associateBy { it.id }
        val albums = tracks.groupBy { it.album }
        children = buildMap {
            put(BrowseIds.ROOT, listOf(
                folder(BrowseIds.RECOMMENDED, "Recommended", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED),
                folder(BrowseIds.ALBUMS, "Albums", MediaMetadata.MEDIA_TYPE_FOLDER_ALBUMS, grid = true),
            ))
            put(BrowseIds.RECOMMENDED, tracks.take(10).map(::playable))
            put(BrowseIds.ALBUMS, albums.map { (name, items) ->
                folder(BrowseIds.album(name), name, MediaMetadata.MEDIA_TYPE_ALBUM, artwork = items.first().artworkUri)
            })
            albums.forEach { (name, items) -> put(BrowseIds.album(name), items.map(::playable)) }
        }
    }

    fun root(): MediaItem = folder(BrowseIds.ROOT, "Library", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
    fun emptyRoot(): MediaItem = folder(BrowseIds.EMPTY_ROOT, "", MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
    fun children(parentId: String): List<MediaItem> = children[parentId].orEmpty()
    fun track(id: String): Track? = byId[id]
    fun search(query: String): List<MediaItem> =
        byId.values.filter { it.title.contains(query, true) || it.artist.contains(query, true) }.map(::playable)

    // Playable items carry the real URI so onAddMediaItems can hand them straight to the player.
    fun playable(track: Track): MediaItem = MediaItem.Builder()
        .setMediaId(track.id)
        .setUri(track.uri)
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(track.title).setArtist(track.artist).setAlbumTitle(track.album)
                .setArtworkUri(track.artworkUri)
                .setIsBrowsable(false).setIsPlayable(true)
                .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                .build(),
        )
        .build()

    private fun folder(id: String, title: String, mediaType: Int, grid: Boolean = false, artwork: Uri? = null): MediaItem {
        val extras = android.os.Bundle().apply {
            // Content-style hints tell Auto and Automotive whether children render as a grid or a list.
            putInt(
                MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE,
                if (grid) MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM else MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
            )
            putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
        }
        return MediaItem.Builder().setMediaId(id).setMediaMetadata(
            MediaMetadata.Builder().setTitle(title).setArtworkUri(artwork)
                .setIsBrowsable(true).setIsPlayable(false).setMediaType(mediaType).setExtras(extras).build(),
        ).build()
    }
}
```

### Caller allowlist

Android Auto, Automotive, Assistant and system UI connect as browsers. Unknown callers get the empty root. Media3 identifies the common ones for you; signature hashes cover the rest.

```kotlin
package com.example.app.playback

import android.content.Context
import android.content.pm.PackageManager
import androidx.media3.session.MediaSession
import java.security.MessageDigest

// Technique from android/uamp PackageValidator (Apache-2.0): package name plus SHA-256 of the signing certificate.
class CallerAllowlist(private val context: Context, private val knownSignatures: Map<String, Set<String>>) {
    private val cache = mutableMapOf<String, Boolean>()

    fun isTrusted(session: MediaSession, controller: MediaSession.ControllerInfo): Boolean {
        if (controller.uid == android.os.Process.myUid()) return true          // our own UI
        if (session.isMediaNotificationController(controller)) return true      // system media controls
        if (session.isAutoCompanionController(controller)) return true           // Android Auto
        if (session.isAutomotiveController(controller)) return true              // Automotive OS
        return cache.getOrPut(controller.packageName) { signatureMatches(controller.packageName) }
    }

    private fun signatureMatches(packageName: String): Boolean {
        val allowed = knownSignatures[packageName] ?: return false
        val info = runCatching {
            context.packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        }.getOrNull() ?: return false
        val signers = info.signingInfo?.apkContentsSigners ?: return false
        return signers.any { sig ->
            MessageDigest.getInstance("SHA-256").digest(sig.toByteArray()).joinToString("") { "%02x".format(it) } in allowed
        }
    }
}
```

Fill `knownSignatures` from the signing certificates published by the partner apps you support (for example a watch companion or a launcher). The common Google clients are covered by the `is*Controller` checks. Log the package and hash of rejected callers at debug level so adding one is a copy from logcat, never auto-accept.

### The service

```kotlin
package com.example.app.playback

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.example.app.R
import com.example.app.playback.library.BrowseTree
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.guava.future
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MusicService : MediaLibraryService() {
    @Inject lateinit var browseTree: BrowseTree
    @Inject lateinit var allowlist: CallerAllowlist
    @Inject lateinit var resumption: ResumptionStore

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var session: MediaLibrarySession? = null

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.Builder().setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).setUsage(C.USAGE_MEDIA).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .build()
        val launch = PendingIntent.getActivity(
            this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE,
        )
        session = MediaLibrarySession.Builder(this, player, LibraryCallback())
            .setSessionActivity(launch)
            .build()
        // The notification is derived from the player; only the channel and icon are ours.
        setMediaNotificationProvider(
            DefaultMediaNotificationProvider.Builder(this)
                .setChannelId("playback")
                .setChannelName(R.string.notification_channel_playback)
                .build()
                .apply { setSmallIcon(R.drawable.ic_notification) },
        )
        scope.launch { browseTree.load() }
        player.addListener(object : Player.Listener {
            override fun onEvents(p: Player, events: Player.Events) {
                if (events.containsAny(Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_IS_PLAYING_CHANGED)) {
                    p.currentMediaItem?.let { scope.launch { resumption.save(it.mediaId, p.currentPosition) } }
                }
            }
        })
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        val player = session?.player ?: return
        if (!player.playWhenReady || player.mediaItemCount == 0) pauseAllPlayersAndStopSelf()
    }

    override fun onDestroy() {
        session?.run { player.release(); release() }
        session = null
        scope.cancel()
        super.onDestroy()
    }

    private inner class LibraryCallback : MediaLibrarySession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            val trusted = allowlist.isTrusted(session, controller)
            val builder = MediaSession.ConnectionResult.AcceptedResultBuilder(session)
            if (trusted) builder.setAvailableSessionCommands(
                MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().add(SessionCommand(COMMAND_SIGN_OUT, Bundle.EMPTY)).build(),
            )
            return builder.build()   // untrusted callers connect but only ever see the empty root
        }

        override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> {
            val root = if (allowlist.isTrusted(session, browser)) browseTree.root() else browseTree.emptyRoot()
            return Futures.immediateFuture(LibraryResult.ofItem(root, params))
        }

        override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
            scope.future { LibraryResult.ofItemList(ImmutableList.copyOf(browseTree.children(parentId)), params) }

        override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> {
            val track = browseTree.track(mediaId) ?: return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
            return Futures.immediateFuture(LibraryResult.ofItem(browseTree.playable(track), null))
        }

        override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> {
            session.notifySearchResultChanged(browser, query, browseTree.search(query).size, params)
            return Futures.immediateFuture(LibraryResult.ofVoid())
        }

        override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
            Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(browseTree.search(query)), params))

        // Controllers send items with only a mediaId (Auto, Assistant, our own UI); resolve them to real URIs here.
        override fun onAddMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>): ListenableFuture<List<MediaItem>> =
            Futures.immediateFuture(mediaItems.map { item ->
                if (item.localConfiguration != null) item else browseTree.track(item.mediaId)?.let(browseTree::playable) ?: item
            })

        // System media controls after process death: rebuild the last playlist and position.
        override fun onPlaybackResumption(session: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaSession.MediaItemsWithStartPosition> =
            scope.future {
                val saved = resumption.load()
                val items = browseTree.children(saved?.parentId ?: BrowseIds.RECOMMENDED)
                val index = items.indexOfFirst { it.mediaId == saved?.mediaId }.coerceAtLeast(0)
                MediaSession.MediaItemsWithStartPosition(items, index, saved?.positionMs ?: 0L)
            }

        override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: SessionCommand, args: Bundle): ListenableFuture<SessionResult> =
            when (customCommand.customAction) {
                COMMAND_SIGN_OUT -> scope.future { resumption.clear(); SessionResult(SessionResult.RESULT_SUCCESS) }
                else -> Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
            }
    }

    companion object { const val COMMAND_SIGN_OUT = "com.example.app.SIGN_OUT" }
}
```

`ResumptionStore` is a small DataStore-backed class (`capabilities/datastore-preferences/README.md`) holding `parentId`, `mediaId` and `positionMs`. `scope.future {}` comes from `kotlinx-coroutines-guava`. Media3 calls `startForeground` itself when the player starts; the manifest `foregroundServiceType` is what makes that legal on API 34+.

### Automotive sign-in error

For a catalog that requires an account, Automotive expects a playback error with a resolution intent instead of a sign-in screen. Send it to the car controller when it connects and the user is signed out:

```kotlin
// Inside onConnect, after building the result, for Automotive controllers only
if (session.isAutomotiveController(controller) && !resumption.isSignedIn()) {
    val extras = Bundle().apply {
        putString(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_LABEL_COMPAT, getString(R.string.sign_in))
        putParcelable(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_INTENT_COMPAT, signInPendingIntent())
    }
    session.sendError(controller, SessionError(SessionError.ERROR_SESSION_AUTHENTICATION_EXPIRED, getString(R.string.sign_in_required), extras))
}
```

`MediaConstants` is `androidx.media3.session.MediaConstants`. The sign-in activity itself is the Credential Manager flow from `capabilities/credential-manager-sign-in/README.md`.

### Cast as a second player

```kotlin
// In MusicService.onCreate, after building the session. Cast is unavailable on devices without Play services: catch and skip.
private var castPlayer: CastPlayer? = null
private fun setUpCast(local: ExoPlayer) {
    val cast = runCatching { CastPlayer(CastContext.getSharedInstance(this)) }.getOrNull() ?: return
    castPlayer = cast
    cast.setSessionAvailabilityListener(object : SessionAvailabilityListener {
        // Technique from android/uamp (Apache-2.0): hand the playlist and position across when the Cast session starts or ends.
        override fun onCastSessionAvailable() = switchPlayer(from = local, to = cast)
        override fun onCastSessionUnavailable() = switchPlayer(from = cast, to = local)
    })
}

private fun switchPlayer(from: Player, to: Player) {
    val items = List(from.mediaItemCount) { from.getMediaItemAt(it) }
    val index = from.currentMediaItemIndex
    val position = from.currentPosition
    val playWhenReady = from.playWhenReady
    from.stop()
    to.setMediaItems(items, index, position)
    to.playWhenReady = playWhenReady
    to.prepare()
    session?.player = to
}
```

`CastPlayer` needs `MediaItem`s with a MIME type set (`setMimeType(MimeTypes.AUDIO_MPEG)`) because the receiver cannot sniff; set it in `BrowseTree.playable`. Release the `CastPlayer` in `onDestroy`.

### App side: browser repository and Compose screen

```kotlin
package com.example.app.playback

@Singleton
class MediaBrowserRepository @Inject constructor(@ApplicationContext private val context: Context) {
    private var browser: MediaBrowser? = null

    suspend fun browser(): MediaBrowser = browser ?: MediaBrowser.Builder(
        context, SessionToken(context, ComponentName(context, MusicService::class.java)),
    ).buildAsync().await().also { browser = it }

    suspend fun children(parentId: String): Result<List<MediaItem>> = runCatching {
        val result = browser().getChildren(parentId, 0, 200, null).await()
        if (result.resultCode == LibraryResult.RESULT_SUCCESS) result.value.orEmpty() else error("code ${result.resultCode}")
    }.onFailure { if (it is CancellationException) throw it }

    suspend fun play(items: List<MediaItem>, startIndex: Int) {
        browser().apply { setMediaItems(items.map { MediaItem.Builder().setMediaId(it.mediaId).build() }, startIndex, 0); prepare(); play() }
    }

    fun release() { browser?.release(); browser = null }
}
```

Only the `mediaId` is sent; `onAddMediaItems` in the service resolves the URI, so the UI never needs to know where audio comes from. Playback state (`isPlaying`, title, position) comes from the same `MediaBrowser` through the `callbackFlow` listener already written in `capabilities/media-playback/README.md`; a `MediaBrowser` is a `MediaController`.

```kotlin
sealed interface BrowseUiState {
    data object Loading : BrowseUiState
    data class Content(val parentId: String, val items: List<MediaItem>) : BrowseUiState
    data object Empty : BrowseUiState
    data class Error(val message: String) : BrowseUiState
}

@HiltViewModel
class BrowseViewModel @Inject constructor(private val repo: MediaBrowserRepository) : ViewModel() {
    private val parent = MutableStateFlow(BrowseIds.ROOT)
    val state: StateFlow<BrowseUiState> = parent.flatMapLatest { id ->
        flow {
            emit(BrowseUiState.Loading)
            emit(repo.children(id).fold(
                onSuccess = { if (it.isEmpty()) BrowseUiState.Empty else BrowseUiState.Content(id, it) },
                onFailure = { BrowseUiState.Error(it.message ?: "Could not load") },
            ))
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), BrowseUiState.Loading)

    fun open(item: MediaItem) {
        val content = state.value as? BrowseUiState.Content ?: return
        if (item.mediaMetadata.isBrowsable == true) parent.value = item.mediaId
        else viewModelScope.launch { repo.play(content.items.filter { it.mediaMetadata.isPlayable == true }, content.items.indexOf(item)) }
    }
}

@Composable
fun BrowseScreen(viewModel: BrowseViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    when (val s = state) {
        BrowseUiState.Loading -> CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading library" })
        BrowseUiState.Empty -> Text("Nothing here yet")
        is BrowseUiState.Error -> Text(s.message, color = MaterialTheme.colorScheme.error)
        is BrowseUiState.Content -> LazyColumn {
            items(s.items, key = { it.mediaId }) { item ->
                ListItem(
                    headlineContent = { Text(item.mediaMetadata.title?.toString().orEmpty()) },
                    supportingContent = item.mediaMetadata.artist?.let { { Text(it.toString()) } },
                    leadingContent = { AsyncImage(model = item.mediaMetadata.artworkUri, contentDescription = null, modifier = Modifier.size(48.dp)) },
                    modifier = Modifier.clickable { viewModel.open(item) }.heightIn(min = 48.dp),
                )
            }
        }
    }
}
```

The now-playing bar reuses `PlayerViewModel` and the controls from `media-playback`, minus `PlayerSurface` for audio. `AsyncImage` is Coil (`capabilities/image-loading/README.md`).

## Verify

```sh
./gradlew :app:assembleDebug
adb shell dumpsys media_session | grep -B2 -A8 com.example.app      # session with library commands
adb shell input keyevent KEYCODE_MEDIA_PLAY                           # after a reboot: exercises onPlaybackResumption
# Android Auto: install the Desktop Head Unit from the SDK Manager, enable developer mode in the Android Auto app, then
# $ANDROID_HOME/extras/google/auto/desktop-head-unit and browse the app; expect Recommended and Albums at the root.
# Automotive: run the :automotive module on an Automotive OS system image from the SDK Manager.
./gradlew :playback:testDebugUnitTest --tests "*BrowseTreeTest*"
```

JVM test for the tree with a fake catalog (no Android runtime needed except `Uri`, so run under Robolectric or keep `Uri` parsing out of the fake):

```kotlin
@Test fun albumsFolderListsEachAlbumOnce() = runTest {
    val tree = BrowseTree(FakeCatalog(tracks = listOf(track("1", album = "A"), track("2", album = "A"), track("3", album = "B"))))
    tree.load()
    val albums = tree.children(BrowseIds.ALBUMS).map { it.mediaId }
    assertEquals(listOf(BrowseIds.album("A"), BrowseIds.album("B")), albums)
    assertEquals(2, tree.children(BrowseIds.album("A")).size)
}
```

Report "built", "browse tree unit-tested", "verified on phone", and "verified in Desktop Head Unit / Automotive emulator" separately. Cast can only be verified against a real receiver and must be reported as unverified otherwise.

## Pitfalls

- Omitting the legacy `android.media.browse.MediaBrowserService` action: the phone UI works, Android Auto shows nothing.
- Returning the full root to every caller: any app can then enumerate and play the catalog. Keep the allowlist and the empty root.
- Resolving URIs in the UI instead of `onAddMediaItems`: Auto and Assistant send only media ids, so playback from the car silently fails.
- Doing catalog I/O inside `onGetChildren` on the main thread: use `scope.future` and a repository; Media3 calls the callback on the application thread.
- Folders without `setIsBrowsable(true)` and tracks without `setIsPlayable(true)`: the car renders them but tapping does nothing.
- Playable items without `artworkUri`: Auto shows blank tiles; small artwork URIs that the car can fetch (https or `content://` with a granted provider) are required.
- `onPlaybackResumption` not implemented: the system media controls show the app after reboot, and tapping play does nothing.
- Creating the `MediaBrowser` per screen: one per process in the repository; release it when the app is done with playback UI.
- `DefaultMediaNotificationProvider` plus a hand-built notification: two notifications. Let Media3 own it.
- Cast `MediaItem`s without a MIME type fail on the receiver with no error on the phone.
- Media3 `ui-compose` and some session APIs are `@UnstableApi`; opt in per declaration and say so in the report.

## Sources

- https://developer.android.com/media/media3/session/control-playback
- https://developer.android.com/media/media3/session/background-playback
- https://developer.android.com/media/media3/session/connect-to-media-app
- https://developer.android.com/training/cars/media
- https://developer.android.com/training/cars/media/automotive-os
- https://developer.android.com/media/media3/exoplayer/cast
- https://developer.android.com/media/media3/ui/compose
- https://developer.android.com/jetpack/androidx/releases/media3
- https://developers.google.com/cast/docs/android_sender
