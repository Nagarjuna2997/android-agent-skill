# Capability catalog

47 capability recipes in 23 categories. Each row links to a self-contained `README.md`; read [README.md](README.md) for the entry contract and the honesty rule (a recipe is not proof of a working build in your project). `catalog.json` holds the same data for tooling.

Dependency notation: `group:artifact@key` means the version comes from `data/versions.json` under `libraries.<key>`; a bare `group:artifact` has no pinned version here and must be resolved from the release page named in the recipe. Gradle plugin ids are listed by id.

Min API is the lowest level the recipe's code is written for; the project's own minSdk is a product decision (AndroidX default 24; templates use 26 for notification channels and adaptive icons).

## persistence

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `room-database` | Room database | persistence | Local relational storage with entities, DAOs exposing Flow, Hilt-provided database, migrations and an in-memory DAO test. | `androidx.room:room-runtime@room`, `androidx.room:room-ktx@room`, `androidx.room:room-compiler@room`, `androidx.room:room-testing@room`, `com.google.devtools.ksp` | 24 | [README](./room-database/README.md) |
| `datastore-preferences` | DataStore preferences | persistence | Typed user settings on Preferences DataStore with a Flow-backed repository, atomic edits and a JVM test. | `androidx.datastore:datastore-preferences@datastore` | 24 | [README](./datastore-preferences/README.md) |
| `paging` | Paging | persistence | Paging 3.5.1 with Room as source of truth and a RemoteMediator with remote keys, cachedIn, load-state UI in Compose and a mediator test. | `androidx.paging:paging-runtime@paging`, `androidx.paging:paging-compose@paging`, `androidx.paging:paging-testing@paging`, `androidx.room:room-paging@room` | 24 | [README](./paging/README.md) |
| `auto-backup-and-data-extraction-rules` | Auto Backup and data extraction rules | persistence | fullBackupContent and dataExtractionRules excluding secrets, device ids and caches, secrets in noBackupFilesDir, restore detection and bmgr-based restore testing. | none | 24 | [README](./auto-backup-and-data-extraction-rules/README.md) |
| `datastore-proto` | Proto DataStore | persistence | Typed, schema-versioned preferences with Proto DataStore in a JVM proto module: protobuf plugin, Serializer, DataMigrations guarded by schema flags, Flow-backed repository, migration from Preferences DataStore and a JVM test. | `androidx.datastore:datastore@datastore`, `androidx.datastore:datastore-core@datastore`, `com.google.protobuf:protobuf-kotlin-lite`, `com.google.protobuf:protoc`, `com.google.protobuf` | 24 | [README](./datastore-proto/README.md) |

## networking

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `retrofit-networking` | Retrofit networking | networking | Retrofit + OkHttp + kotlinx.serialization with auth and logging interceptors, sealed error mapping and a MockWebServer test. | `com.squareup.retrofit2:retrofit`, `com.squareup.retrofit2:converter-kotlinx-serialization`, `com.squareup.okhttp3:okhttp`, `com.squareup.okhttp3:logging-interceptor`, `org.jetbrains.kotlinx:kotlinx-serialization-json` | 24 | [README](./retrofit-networking/README.md) |
| `ktor-client` | Ktor client | networking | Ktor HttpClient on the OkHttp engine with content negotiation, bearer auth refresh, error mapping and a MockEngine test; the Retrofit alternative. | `io.ktor:ktor-client-core`, `io.ktor:ktor-client-okhttp`, `io.ktor:ktor-client-content-negotiation`, `io.ktor:ktor-client-auth`, `io.ktor:ktor-serialization-kotlinx-json` | 24 | [README](./ktor-client/README.md) |

## dependency-injection

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `hilt-di` | Hilt dependency injection | dependency-injection | Dagger Hilt with KSP: application and entry points, binding modules, dispatcher qualifiers, hiltViewModel in navigation, WorkManager factory and a module-swapping test. | `com.google.dagger:hilt-android`, `com.google.dagger:hilt-android-compiler`, `androidx.hilt:hilt-navigation-compose@androidxHilt`, `androidx.hilt:hilt-work@androidxHilt`, `androidx.hilt:hilt-compiler@androidxHilt` | 24 | [README](./hilt-di/README.md) |
| `koin-di` | Koin dependency injection | dependency-injection | Koin module DSL, startKoin, koinViewModel in navigation, WorkManager factory and a verify() graph test; the no-codegen alternative to Hilt. | `io.insert-koin:koin-bom`, `io.insert-koin:koin-android`, `io.insert-koin:koin-androidx-compose`, `io.insert-koin:koin-androidx-compose-navigation`, `io.insert-koin:koin-androidx-workmanager` | 24 | [README](./koin-di/README.md) |

## background

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `work-manager` | WorkManager background work | background | Hilt-injected CoroutineWorker with one-time, periodic, expedited and foreground work, constraints, unique policies, status Flow and a worker test. | `androidx.work:work-runtime-ktx@workmanager`, `androidx.work:work-testing@workmanager`, `androidx.hilt:hilt-work@androidxHilt` | 24 | [README](./work-manager/README.md) |
| `offline-first-sync` | Offline-first sync | background | Change-list synchronization of Room tables: Synchronizer/Syncable contract, changeListSync helper with versions in Proto DataStore, a HiltWorker CoroutineWorker running repositories in parallel, SyncManager exposing isSyncing, conflict strategy and tests. | `androidx.work:work-runtime-ktx@workmanager`, `androidx.work:work-testing@workmanager`, `androidx.hilt:hilt-work@androidxHilt`, `androidx.hilt:hilt-compiler@androidxHilt`, `androidx.tracing:tracing-ktx` | 24 | [README](./offline-first-sync/README.md) |

## notifications

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `notifications` | Notifications | notifications | Channels, POST_NOTIFICATIONS runtime flow on API 33+, action receivers, grouping with a summary, deep-link tap intents and a UI Automator test. | `androidx.core:core-ktx` | 26 | [README](./notifications/README.md) |
| `firebase-cloud-messaging` | Firebase Cloud Messaging | notifications | FCM service for data messages and token rotation, token upload through WorkManager, topics, and a test send with the HTTP v1 API. | `com.google.firebase:firebase-bom@firebaseBom`, `com.google.firebase:firebase-messaging`, `androidx.work:work-runtime-ktx@workmanager`, `com.google.gms.google-services` | 24 | [README](./firebase-cloud-messaging/README.md) |

## navigation

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `deep-links` | Deep links and App Links | navigation | Verified Android App Links with assetlinks.json, a custom-scheme fallback, a single untrusted-input parser and Navigation Compose typed deep links. | `androidx.navigation:navigation-compose@navigation`, `org.jetbrains.kotlinx:kotlinx-serialization-json` | 24 | [README](./deep-links/README.md) |

## authentication

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `credential-manager-sign-in` | Credential Manager sign-in | authentication | One Credential Manager 1.6.0 flow for passkeys, saved passwords and Sign in with Google (googleid), passkey registration and sign-out. | `androidx.credentials:credentials@credentials`, `androidx.credentials:credentials-play-services-auth@credentials`, `com.google.android.libraries.identity.googleid:googleid` | 24 | [README](./credential-manager-sign-in/README.md) |
| `firebase-auth` | Firebase Authentication | authentication | Firebase Auth repository with current-user Flow, email/password and Google via Credential Manager, ID tokens for your API, and Auth emulator tests. | `com.google.firebase:firebase-bom@firebaseBom`, `com.google.firebase:firebase-auth`, `androidx.credentials:credentials@credentials`, `com.google.android.libraries.identity.googleid:googleid`, `com.google.gms.google-services` | 24 | [README](./firebase-auth/README.md) |

## backend

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `firebase-firestore` | Firebase Firestore | backend | Firestore with offline persistence, a callbackFlow snapshot wrapper, server timestamps, pagination, a security-rules reminder and emulator tests. | `com.google.firebase:firebase-bom@firebaseBom`, `com.google.firebase:firebase-firestore`, `com.google.gms.google-services` | 24 | [README](./firebase-firestore/README.md) |

## payments

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `play-billing` | Play Billing | payments | Billing Library 9.0.0: BillingClient with reconnection, product details, purchase flow, server verification before acknowledgement, restore and license testing. | `com.android.billingclient:billing-ktx@billing` | 24 | [README](./play-billing/README.md) |

## security

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `biometric-unlock` | Biometric unlock | security | androidx.biometric prompt with device-credential fallback and an Android Keystore AES key bound to user authentication, with re-lock on background. | `androidx.biometric:biometric` | 24 | [README](./biometric-unlock/README.md) |
| `network-security-config` | Network security config | security | Cleartext blocked, per-domain certificate pinning with backup pins and expiry, debug-only user CA trust, OkHttp CertificatePinner and tests that prove failures. | `com.squareup.okhttp3:okhttp` | 24 | [README](./network-security-config/README.md) |

## media

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `camera-capture` | Camera capture | media | CameraX 1.6.2 preview and photo capture in Compose with CameraXViewfinder, CAMERA permission, MediaStore output, flash and lens switching. | `androidx.camera:camera-core@camera`, `androidx.camera:camera-camera2@camera`, `androidx.camera:camera-lifecycle@camera`, `androidx.camera:camera-compose@camera` | 24 | [README](./camera-capture/README.md) |
| `photo-picker` | Photo picker | media | PickVisualMedia and PickMultipleVisualMedia with no storage permission, copying picked media into app storage, and an Espresso Intents test. | `androidx.activity:activity-compose` | 24 | [README](./photo-picker/README.md) |
| `image-loading` | Image loading | media | Coil 3 AsyncImage with a singleton ImageLoader on the app's OkHttp client, memory and disk caches, placeholders, previews and a fake-engine test. | `io.coil-kt.coil3:coil-bom`, `io.coil-kt.coil3:coil-compose`, `io.coil-kt.coil3:coil-network-okhttp`, `io.coil-kt.coil3:coil-test` | 24 | [README](./image-loading/README.md) |
| `media-playback` | Media playback | media | Media3 1.11.1 ExoPlayer in a MediaSessionService, MediaController repository, PlayerSurface in Compose, foreground media type and an asset playback test. | `androidx.media3:media3-exoplayer@media3`, `androidx.media3:media3-session@media3`, `androidx.media3:media3-ui-compose@media3`, `androidx.media3:media3-test-utils@media3` | 24 | [README](./media-playback/README.md) |
| `media-session-service` | Media session service | media | UAMP architecture on Media3 1.11.1: MediaLibraryService with ExoPlayer, browse tree for Android Auto and Automotive, caller allowlisting in onConnect, DefaultMediaNotificationProvider, playback resumption, MediaBrowser repository with a Compose browse screen and Cast via media3-cast. | `androidx.media3:media3-exoplayer@media3`, `androidx.media3:media3-session@media3`, `androidx.media3:media3-ui-compose@media3`, `androidx.media3:media3-cast@media3`, `com.google.android.gms:play-services-cast-framework`, `org.jetbrains.kotlinx:kotlinx-coroutines-guava` | 24 | [README](./media-session-service/README.md) |

## maps-location

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `maps` | Maps | maps-location | Google Maps with Maps Compose, API key injected by the Secrets Gradle plugin, camera state, clustering, my-location layer gated on permission and dark styling. | `com.google.maps.android:maps-compose`, `com.google.maps.android:maps-compose-utils`, `com.google.android.gms:play-services-maps`, `com.google.android.libraries.mapsplatform.secrets-gradle-plugin` | 24 | [README](./maps/README.md) |
| `location` | Location | maps-location | FusedLocationProviderClient current fix and update Flow, coarse-then-fine permission flow with rationale, background-location policy and emulator injection. | `com.google.android.gms:play-services-location`, `org.jetbrains.kotlinx:kotlinx-coroutines-play-services` | 24 | [README](./location/README.md) |

## widgets-shortcuts

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `home-screen-widget` | Home screen widget | widgets-shortcuts | Jetpack Glance widget with responsive sizes, Hilt entry point for data, click and callback actions, updates from the app and a Glance unit test. | `androidx.glance:glance-appwidget`, `androidx.glance:glance-material3`, `androidx.glance:glance-appwidget-testing` | 24 | [README](./home-screen-widget/README.md) |
| `app-shortcuts` | App shortcuts | widgets-shortcuts | Static, dynamic and pinned launcher shortcuts via ShortcutManagerCompat, routed through the App Link parser, with usage reporting and a Robolectric test. | `androidx.core:core-ktx` | 24 | [README](./app-shortcuts/README.md) |

## app-structure

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `app-icon` | App icon | app-structure | Adaptive launcher icon with foreground, background and monochrome layers for themed icons, legacy PNG fallback and a Robolectric layer check. | none | 24 | [README](./app-icon/README.md) |
| `localization` | Localization | app-structure | String resources, plurals, locale-aware formatting, per-app language preferences on API 33+ with the AppCompat backport, RTL and pseudolocales. | `androidx.appcompat:appcompat` | 24 | [README](./localization/README.md) |
| `settings-screen` | Settings screen | app-structure | Material 3 settings screen in Compose backed by DataStore: switch, radio-dialog and navigation rows, a single UiState, theme applied at the root and a Compose test. | `androidx.datastore:datastore-preferences@datastore`, `androidx.lifecycle:lifecycle-runtime-compose@lifecycle`, `androidx.compose.material3:material3@material3` | 24 | [README](./settings-screen/README.md) |
| `onboarding-flow` | Onboarding flow | app-structure | HorizontalPager onboarding with indicators, skip/next, permission priming without requesting, completion in DataStore and flicker-free start destination. | `androidx.datastore:datastore-preferences@datastore`, `androidx.navigation:navigation-compose@navigation` | 24 | [README](./onboarding-flow/README.md) |
| `design-system-module` | Design system module | app-structure | A :core:designsystem module with AppTheme (light, dark, dynamic), typography, shapes, an AppIcons object, Material 3 component wrappers, ThemePreviews and DevicePreviews annotations, and an :app-catalog application for reviewing components. | `androidx.compose:compose-bom@composeBom`, `androidx.compose.material3:material3@material3`, `androidx.compose.ui:ui-tooling-preview` | 24 | [README](./design-system-module/README.md) |

## launch

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `splash-screen` | Splash screen | launch | androidx.core.splashscreen with themed icon and background, installSplashScreen before onCreate, keep-on-screen tied to a root ViewModel and an exit animation. | `androidx.core:core-splashscreen` | 24 | [README](./splash-screen/README.md) |

## performance

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `app-startup-and-baseline-profiles` | App startup and Baseline Profiles | performance | App Startup initializers for ordered lazy init, a baselineprofile module with Macrobenchmark 1.5.0, a profile generator, startup benchmark and release packaging checks. | `androidx.startup:startup-runtime`, `androidx.profileinstaller:profileinstaller`, `androidx.benchmark:benchmark-macro-junit4@benchmark`, `androidx.baselineprofile@benchmark`, `androidx.test.uiautomator:uiautomator` | 24 | [README](./app-startup-and-baseline-profiles/README.md) |

## diagnostics

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `crash-reporting` | Crash reporting | diagnostics | Firebase Crashlytics behind a CrashReporter interface, mapping upload, non-fatals with keys and breadcrumbs, consent toggle and a forced test crash. | `com.google.firebase:firebase-bom@firebaseBom`, `com.google.firebase:firebase-crashlytics`, `com.google.firebase.crashlytics`, `com.google.gms.google-services` | 24 | [README](./crash-reporting/README.md) |
| `analytics-events` | Analytics events | diagnostics | Firebase Analytics with a typed event catalog, consent mode defaults off in the manifest, screen tracking from Navigation Compose, DebugView verification and a recording fake. | `com.google.firebase:firebase-bom@firebaseBom`, `com.google.firebase:firebase-analytics`, `androidx.navigation:navigation-compose@navigation`, `com.google.gms.google-services` | 24 | [README](./analytics-events/README.md) |

## distribution

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `in-app-updates-and-review` | In-app updates and review | distribution | Play In-App Updates (flexible and immediate) and In-App Review through the split Play Core libraries, with fake managers for tests and internal app sharing for device checks. | `com.google.android.play:app-update-ktx`, `com.google.android.play:review-ktx` | 24 | [README](./in-app-updates-and-review/README.md) |

## ai-ml

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `on-device-ai` | On-device AI | ai-ml | ML Kit GenAI APIs on Gemini Nano via AICore with runtime availability checks, model download, streaming output and a consented Firebase AI Logic cloud fallback; device-gated. | `com.google.mlkit:genai-summarization`, `com.google.mlkit:genai-proofreading`, `com.google.firebase:firebase-bom@firebaseBom`, `com.google.firebase:firebase-ai` | 26 | [README](./on-device-ai/README.md) |

## wear

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `wear-os-companion` | Wear OS companion | wear | Minimal :wear module with Compose for Wear OS and the Data Layer API syncing a small state object from the phone; runtime-unverified in this repository. | `androidx.wear.compose:compose-material`, `androidx.wear.compose:compose-foundation`, `androidx.wear.compose:compose-navigation`, `com.google.android.gms:play-services-wearable` | 30 | [README](./wear-os-companion/README.md) |

## native

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `ndk-native-code` | NDK native code | native | C++ through CMake and JNI: externalNativeBuild, RegisterNatives in JNI_OnLoad, @JvmStatic external fun facade, version script, ABI filters, 16 KB page-size alignment, ndk-stack, Prefab, HWASan/UBSan build types and googletest on device. | `androidx.test.ext:junit-gtest`, `com.android.ndk.thirdparty:googletest` | 26 | [README](./ndk-native-code/README.md) |
| `oboe-low-latency-audio` | Oboe low-latency audio | native | Oboe through Prefab: a native AudioStream engine with a real-time data callback and reconnect on disconnect, device audio properties fed from Kotlin, a StateFlow repository, a Compose tone screen and the latency-tuning loop; runtime-unverified in this repository. | `com.google.oboe:oboe` | 26 | [README](./oboe-low-latency-audio/README.md) |
| `vulkan-and-gles-rendering` | Vulkan and GLES rendering | native | Choosing Activity + GLSurfaceView, GameActivity or NativeActivity, Vulkan versus OpenGL ES 3, surface lifecycle in C++, game-activity through Prefab with WHOLE_ARCHIVE, glslc shader compilation and a GLES renderer inside a Compose screen; runtime-unverified in this repository. | `androidx.games:games-activity` | 26 | [README](./vulkan-and-gles-rendering/README.md) |

## ui

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `rich-text-and-markdown` | Rich text and Markdown | ui | Paragraph model to AnnotatedString with bold, italic, code, LinkAnnotation URLs and clickable mentions, TextLinkStyles, inline content, bullets and code blocks in a LazyColumn, AnnotatedString.fromHtml, and a JVM parser test. | `androidx.compose.ui:ui-text` | 24 | [README](./rich-text-and-markdown/README.md) |
| `compose-drawing-and-graphics` | Compose drawing and graphics | ui | Canvas and draw modifiers, data-driven Path with drawWithCache, gradient Brush, graphicsLayer transforms without recomposition, scroll-provider lambdas, a custom Layout with a ParentDataModifier, and an AGSL shader Modifier.Node with a pre-API-33 fallback. | `androidx.compose.ui:ui`, `androidx.compose.foundation:foundation`, `androidx.compose.ui:ui-text` | 24 | [README](./compose-drawing-and-graphics/README.md) |

## tv

| Id | Name | Category | Summary | Dependencies | Min API | Link |
|---|---|---|---|---|---|---|
| `tv-and-large-screen-app` | TV and large-screen app | tv | A :tv application module with androidx.tv Material on shared core modules: Leanback launcher manifest and banner, overscan margins, navigation drawer with focusProperties and focusGroup, catalog rows with focusRestorer, D-pad key handling on a custom seek bar, and TV emulator checks; runtime-unverified in this repository. | `androidx.tv:tv-material`, `androidx.navigation:navigation-compose@navigation`, `androidx.hilt:hilt-navigation-compose@androidxHilt` | 26 | [README](./tv-and-large-screen-app/README.md) |
