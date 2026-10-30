# Reference study: android/uamp (Universal Android Music Player)

What UAMP teaches about structuring an audio app around a single playback service, and how each of its ideas maps onto Media3 1.11.1, which is what `data/versions.json` pins and what this repository's recipes use.

## What it is

UAMP is Google's long-running sample of a music app that works on phones, tablets, Android Auto, Android Automotive OS, Wear, TV, Google Cast and the Google Assistant from one codebase. Its README now opens with a deprecation notice: the sample is no longer maintained. The last commit is from 2026-01 (a static-assets merge); the architecture itself dates from 2017 to 2021.

Studied at commit `9498d99` (2026-01-09).

## Toolchain it is on right now

Plainly: UAMP is an older-style project on the legacy media stack, not on Media3.

| Component | UAMP | This repository | Relation |
|---|---|---|---|
| Player | ExoPlayer 2 (`com.google.android.exoplayer:exoplayer-core` 2.16.0, `SimpleExoPlayer`) | Media3 1.11.1 `androidx.media3:media3-exoplayer` | legacy |
| Session | `MediaSessionCompat` + `extension-mediasession` `MediaSessionConnector` | `androidx.media3.session.MediaSession` / `MediaLibrarySession` | legacy |
| Browsing service | `androidx.media:media` 1.0.1 `MediaBrowserServiceCompat` | `MediaLibraryService` | legacy |
| Notification | `PlayerNotificationManager` from `exoplayer-ui` | `DefaultMediaNotificationProvider` in `media3-session` | legacy |
| Cast | `extension-cast` `CastPlayer` | `androidx.media3:media3-cast` | legacy |
| UI | Fragments, XML layouts, `LiveData`, Glide, `kotlin-android-extensions` | Compose, `StateFlow`, Coil | legacy |
| AGP / Gradle | 4.0.1 / 6.1.1 | 9.4.0 / 9.6.0 | lags by five major versions |
| Kotlin | 1.3.72, coroutines 1.1.0 | 2.4.20 | lags |
| compileSdk / targetSdk / minSdk | 30 / 30 / 19 | 37 / 36 / product decision | lags |

Nothing in UAMP's dependency list should be added to a new project. What survives is the architecture.

## The architecture worth keeping

UAMP's structure is still the recommended shape for an audio app, and Media3 was designed to express it with less code:

1. One service owns playback. `MusicService` creates the player, the session and the notification, loads the catalog, and decides what to play. Activities never touch the player directly.
2. The session is the only public API. The phone UI, Android Auto, Automotive, Wear, Assistant and the system media controls all talk to the session; the service does not know which one is calling except through the caller identity it validates.
3. A browse tree exposes the catalog. Browsers ask for a root and then children by id; the tree is built once from the music source and holds "Recommended", "Albums" and "Recent" roots, with album nodes derived from track metadata.
4. The notification is derived from the player, never built by hand.
5. The UI connects through one connection object (`MusicServiceConnection`) that exposes playback state and now-playing metadata as observable state, and ViewModels map that into screen state.
6. Caller validation (`PackageValidator`) checks the browser's package name and signing certificate against an XML allowlist before returning a browsable root; unknown callers get an empty root.
7. Cast switches players. When a Cast session becomes available the service hands the current playlist and position to a `CastPlayer`, and back to the local player when it ends.
8. Automotive extends the same service: `AutomotiveMusicService : MusicService` adds sign-in commands and a custom error with a resolution intent, in its own module with `android.hardware.type.automotive` required.

## Re-expressed on Media3 1.11.1

Each UAMP piece has a direct Media3 equivalent. The table is the migration map; the full original implementation is in `capabilities/media-session-service/README.md`.

| UAMP (legacy) | Media3 1.11.1 |
|---|---|
| `MediaBrowserServiceCompat` with `onGetRoot` / `onLoadChildren` / `onSearch` | `MediaLibraryService` with a `MediaLibrarySession.Callback` implementing `onGetLibraryRoot`, `onGetChildren`, `onGetItem`, `onSearch` / `onGetSearchResult` |
| `MediaSessionCompat` + `MediaSessionConnector.setPlayer` | `MediaLibrarySession.Builder(service, player, callback).build()`; the player is the session |
| `PlaybackPreparer.onPrepareFromMediaId` resolving ids to URIs | `MediaSession.Callback.onAddMediaItems` / `onSetMediaItems` returning fully resolved `MediaItem`s |
| `PackageValidator.isKnownCaller(packageName, uid)` in `onGetRoot` | the same check in `onConnect(session, controller)` using `ControllerInfo.packageName` and `uid`; reject with `ConnectionResult.reject()` or accept with a reduced command set |
| `PlayerNotificationManager` + manual `startForeground` | `DefaultMediaNotificationProvider` installed with `setMediaNotificationProvider`; the service goes foreground on its own |
| `MediaBrowserCompat` + `MediaControllerCompat` in `MusicServiceConnection` | `MediaBrowser.Builder(context, SessionToken).buildAsync()`; a `MediaBrowser` is a `MediaController` is a `Player` |
| `LiveData<PlaybackStateCompat>` | `Player.Listener.onEvents` into a `callbackFlow`, exposed as `StateFlow<UiState>` |
| `extension-cast` `CastPlayer` + `SessionAvailabilityListener` | `media3-cast` `CastPlayer` with the same listener; swap with `MediaSession.setPlayer` |
| `android.media.browse.MediaBrowserService` intent filter | both `androidx.media3.session.MediaLibraryService` and the legacy action, so Android Auto's `MediaBrowserCompat` can still bind |
| `BrowserRoot` extras for content style | `MediaMetadata.Builder` extras with the same `android.media.browse.CONTENT_STYLE_*` keys on the root and folder items |
| `AutomotiveMusicService` custom commands | `SessionCommand` + `onCustomCommand`, with `setAvailableSessionCommands` in `onConnect` |

Short original illustration of the root and children callback (full version in the capability):

```kotlin
// Technique from android/uamp (Apache-2.0): browse tree served by the session; here on Media3.
override fun onGetLibraryRoot(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    params: MediaLibraryService.LibraryParams?,
): ListenableFuture<LibraryResult<MediaItem>> {
    val root = if (callerAllowlist.isTrusted(browser)) catalog.root() else catalog.emptyRoot()
    return Futures.immediateFuture(LibraryResult.ofItem(root, params))
}

override fun onGetChildren(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    parentId: String,
    page: Int,
    pageSize: Int,
    params: MediaLibraryService.LibraryParams?,
): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = serviceScope.future {
    LibraryResult.ofItemList(ImmutableList.copyOf(catalog.children(parentId)), params)
}
```

## Techniques not to copy, and why

- `MediaBrowserServiceCompat`, `MediaSessionCompat`, `MediaSessionConnector`, `PlayerNotificationManager`, ExoPlayer 2 packages: superseded by Media3; ExoPlayer 2 receives no updates and the Media3 types are source-incompatible with them.
- `LiveData` in `MusicServiceConnection` and the ViewModels: this repository forbids `LiveData` in new code; use `StateFlow`.
- Fragments with XML layouts, `kotlin-android-extensions` synthetic imports (removed from Kotlin), Glide for artwork: use Compose and Coil (`capabilities/image-loading/README.md`).
- `AlbumArtContentProvider` with `android:exported="true"` and no permission: it existed to hand artwork to Android Auto; Media3 passes `artworkUri` and `artworkData` through the session, so no exported provider is needed.
- `PersistentStorage` on `SharedPreferences` for the recent song: use DataStore (`capabilities/datastore-preferences/README.md`).
- Automotive sign-in storing `"$email:${password.hashCode()}"` in `SharedPreferences`: sample-only placeholder; real sign-in goes through `capabilities/credential-manager-sign-in/README.md` and tokens live in the Keystore-backed storage described in `checklists/security.md`.
- `PendingIntent.getActivity(this, 0, intent, 0)` without `FLAG_IMMUTABLE`: crashes on API 31+.
- `minSdk 19`, `compileSdk 30`, AGP 4, Gradle 6: do not carry any of the build setup forward.
- `targetSandboxVersion="2"` and `<dist:module dist:instant="true" />` on the phone manifest: instant-app leftovers.
- Catalog served from a remote JSON with Gson: fine as sample data; a real app keeps the catalog behind a repository interface with Room or a network client.

## Technique to repository file map

| Technique | Taught in |
|---|---|
| Service as the single playback owner; session over controllers | `capabilities/media-session-service/README.md` (builds on `capabilities/media-playback/README.md`) |
| Browse tree for Android Auto and Automotive, content-style hints | `capabilities/media-session-service/README.md` |
| Caller allowlisting by package and certificate | `capabilities/media-session-service/README.md` |
| Notification from the player | `capabilities/media-session-service/README.md` |
| UI connection object as a `StateFlow` repository, Compose player screen | `capabilities/media-session-service/README.md` |
| Cast as a second player | `capabilities/media-session-service/README.md` |
| Automotive module, custom commands, sign-in error with resolution | `capabilities/media-session-service/README.md` |
| Foreground service type and manifest | `capabilities/media-playback/README.md`, extended by `capabilities/media-session-service/README.md` |

## Attribution

Sample: `android/uamp`, https://github.com/android/uamp, Copyright Google Inc. and The Android Open Source Project, licensed under the Apache License, Version 2.0. The code in this repository is an original re-implementation of the techniques studied there, written on Media3 1.11.1 in the `com.example.app` placeholder package; no UAMP files were copied, and UAMP's legacy dependencies are not used. Short excerpts, where present, are attributed inline.
