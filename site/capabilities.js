window.capabilityCatalog = [
  {
    "id": "room-database",
    "name": "Room database",
    "category": "persistence",
    "summary": "Local relational storage with entities, DAOs exposing Flow, Hilt-provided database, migrations and an in-memory DAO test.",
    "path": "capabilities/room-database/README.md",
    "minSdk": 24
  },
  {
    "id": "datastore-preferences",
    "name": "DataStore preferences",
    "category": "persistence",
    "summary": "Typed user settings on Preferences DataStore with a Flow-backed repository, atomic edits and a JVM test.",
    "path": "capabilities/datastore-preferences/README.md",
    "minSdk": 24
  },
  {
    "id": "retrofit-networking",
    "name": "Retrofit networking",
    "category": "networking",
    "summary": "Retrofit + OkHttp + kotlinx.serialization with auth and logging interceptors, sealed error mapping and a MockWebServer test.",
    "path": "capabilities/retrofit-networking/README.md",
    "minSdk": 24
  },
  {
    "id": "ktor-client",
    "name": "Ktor client",
    "category": "networking",
    "summary": "Ktor HttpClient on the OkHttp engine with content negotiation, bearer auth refresh, error mapping and a MockEngine test; the Retrofit alternative.",
    "path": "capabilities/ktor-client/README.md",
    "minSdk": 24
  },
  {
    "id": "hilt-di",
    "name": "Hilt dependency injection",
    "category": "dependency-injection",
    "summary": "Dagger Hilt with KSP: application and entry points, binding modules, dispatcher qualifiers, hiltViewModel in navigation, WorkManager factory and a module-swapping test.",
    "path": "capabilities/hilt-di/README.md",
    "minSdk": 24
  },
  {
    "id": "koin-di",
    "name": "Koin dependency injection",
    "category": "dependency-injection",
    "summary": "Koin module DSL, startKoin, koinViewModel in navigation, WorkManager factory and a verify() graph test; the no-codegen alternative to Hilt.",
    "path": "capabilities/koin-di/README.md",
    "minSdk": 24
  },
  {
    "id": "work-manager",
    "name": "WorkManager background work",
    "category": "background",
    "summary": "Hilt-injected CoroutineWorker with one-time, periodic, expedited and foreground work, constraints, unique policies, status Flow and a worker test.",
    "path": "capabilities/work-manager/README.md",
    "minSdk": 24
  },
  {
    "id": "notifications",
    "name": "Notifications",
    "category": "notifications",
    "summary": "Channels, POST_NOTIFICATIONS runtime flow on API 33+, action receivers, grouping with a summary, deep-link tap intents and a UI Automator test.",
    "path": "capabilities/notifications/README.md",
    "minSdk": 26
  },
  {
    "id": "deep-links",
    "name": "Deep links and App Links",
    "category": "navigation",
    "summary": "Verified Android App Links with assetlinks.json, a custom-scheme fallback, a single untrusted-input parser and Navigation Compose typed deep links.",
    "path": "capabilities/deep-links/README.md",
    "minSdk": 24
  },
  {
    "id": "biometric-unlock",
    "name": "Biometric unlock",
    "category": "security",
    "summary": "androidx.biometric prompt with device-credential fallback and an Android Keystore AES key bound to user authentication, with re-lock on background.",
    "path": "capabilities/biometric-unlock/README.md",
    "minSdk": 24
  },
  {
    "id": "credential-manager-sign-in",
    "name": "Credential Manager sign-in",
    "category": "authentication",
    "summary": "One Credential Manager 1.6.0 flow for passkeys, saved passwords and Sign in with Google (googleid), passkey registration and sign-out.",
    "path": "capabilities/credential-manager-sign-in/README.md",
    "minSdk": 24
  },
  {
    "id": "firebase-auth",
    "name": "Firebase Authentication",
    "category": "authentication",
    "summary": "Firebase Auth repository with current-user Flow, email/password and Google via Credential Manager, ID tokens for your API, and Auth emulator tests.",
    "path": "capabilities/firebase-auth/README.md",
    "minSdk": 24
  },
  {
    "id": "firebase-firestore",
    "name": "Firebase Firestore",
    "category": "backend",
    "summary": "Firestore with offline persistence, a callbackFlow snapshot wrapper, server timestamps, pagination, a security-rules reminder and emulator tests.",
    "path": "capabilities/firebase-firestore/README.md",
    "minSdk": 24
  },
  {
    "id": "firebase-cloud-messaging",
    "name": "Firebase Cloud Messaging",
    "category": "notifications",
    "summary": "FCM service for data messages and token rotation, token upload through WorkManager, topics, and a test send with the HTTP v1 API.",
    "path": "capabilities/firebase-cloud-messaging/README.md",
    "minSdk": 24
  },
  {
    "id": "play-billing",
    "name": "Play Billing",
    "category": "payments",
    "summary": "Billing Library 9.0.0: BillingClient with reconnection, product details, purchase flow, server verification before acknowledgement, restore and license testing.",
    "path": "capabilities/play-billing/README.md",
    "minSdk": 24
  },
  {
    "id": "camera-capture",
    "name": "Camera capture",
    "category": "media",
    "summary": "CameraX 1.6.2 preview and photo capture in Compose with CameraXViewfinder, CAMERA permission, MediaStore output, flash and lens switching.",
    "path": "capabilities/camera-capture/README.md",
    "minSdk": 24
  },
  {
    "id": "photo-picker",
    "name": "Photo picker",
    "category": "media",
    "summary": "PickVisualMedia and PickMultipleVisualMedia with no storage permission, copying picked media into app storage, and an Espresso Intents test.",
    "path": "capabilities/photo-picker/README.md",
    "minSdk": 24
  },
  {
    "id": "image-loading",
    "name": "Image loading",
    "category": "media",
    "summary": "Coil 3 AsyncImage with a singleton ImageLoader on the app's OkHttp client, memory and disk caches, placeholders, previews and a fake-engine test.",
    "path": "capabilities/image-loading/README.md",
    "minSdk": 24
  },
  {
    "id": "paging",
    "name": "Paging",
    "category": "persistence",
    "summary": "Paging 3.5.1 with Room as source of truth and a RemoteMediator with remote keys, cachedIn, load-state UI in Compose and a mediator test.",
    "path": "capabilities/paging/README.md",
    "minSdk": 24
  },
  {
    "id": "maps",
    "name": "Maps",
    "category": "maps-location",
    "summary": "Google Maps with Maps Compose, API key injected by the Secrets Gradle plugin, camera state, clustering, my-location layer gated on permission and dark styling.",
    "path": "capabilities/maps/README.md",
    "minSdk": 24
  },
  {
    "id": "location",
    "name": "Location",
    "category": "maps-location",
    "summary": "FusedLocationProviderClient current fix and update Flow, coarse-then-fine permission flow with rationale, background-location policy and emulator injection.",
    "path": "capabilities/location/README.md",
    "minSdk": 24
  },
  {
    "id": "home-screen-widget",
    "name": "Home screen widget",
    "category": "widgets-shortcuts",
    "summary": "Jetpack Glance widget with responsive sizes, Hilt entry point for data, click and callback actions, updates from the app and a Glance unit test.",
    "path": "capabilities/home-screen-widget/README.md",
    "minSdk": 24
  },
  {
    "id": "app-shortcuts",
    "name": "App shortcuts",
    "category": "widgets-shortcuts",
    "summary": "Static, dynamic and pinned launcher shortcuts via ShortcutManagerCompat, routed through the App Link parser, with usage reporting and a Robolectric test.",
    "path": "capabilities/app-shortcuts/README.md",
    "minSdk": 24
  },
  {
    "id": "in-app-updates-and-review",
    "name": "In-app updates and review",
    "category": "distribution",
    "summary": "Play In-App Updates (flexible and immediate) and In-App Review through the split Play Core libraries, with fake managers for tests and internal app sharing for device checks.",
    "path": "capabilities/in-app-updates-and-review/README.md",
    "minSdk": 24
  },
  {
    "id": "media-playback",
    "name": "Media playback",
    "category": "media",
    "summary": "Media3 1.11.1 ExoPlayer in a MediaSessionService, MediaController repository, PlayerSurface in Compose, foreground media type and an asset playback test.",
    "path": "capabilities/media-playback/README.md",
    "minSdk": 24
  },
  {
    "id": "on-device-ai",
    "name": "On-device AI",
    "category": "ai-ml",
    "summary": "ML Kit GenAI APIs on Gemini Nano via AICore with runtime availability checks, model download, streaming output and a consented Firebase AI Logic cloud fallback; device-gated.",
    "path": "capabilities/on-device-ai/README.md",
    "minSdk": 26
  },
  {
    "id": "app-icon",
    "name": "App icon",
    "category": "app-structure",
    "summary": "Adaptive launcher icon with foreground, background and monochrome layers for themed icons, legacy PNG fallback and a Robolectric layer check.",
    "path": "capabilities/app-icon/README.md",
    "minSdk": 24
  },
  {
    "id": "localization",
    "name": "Localization",
    "category": "app-structure",
    "summary": "String resources, plurals, locale-aware formatting, per-app language preferences on API 33+ with the AppCompat backport, RTL and pseudolocales.",
    "path": "capabilities/localization/README.md",
    "minSdk": 24
  },
  {
    "id": "settings-screen",
    "name": "Settings screen",
    "category": "app-structure",
    "summary": "Material 3 settings screen in Compose backed by DataStore: switch, radio-dialog and navigation rows, a single UiState, theme applied at the root and a Compose test.",
    "path": "capabilities/settings-screen/README.md",
    "minSdk": 24
  },
  {
    "id": "onboarding-flow",
    "name": "Onboarding flow",
    "category": "app-structure",
    "summary": "HorizontalPager onboarding with indicators, skip/next, permission priming without requesting, completion in DataStore and flicker-free start destination.",
    "path": "capabilities/onboarding-flow/README.md",
    "minSdk": 24
  },
  {
    "id": "splash-screen",
    "name": "Splash screen",
    "category": "launch",
    "summary": "androidx.core.splashscreen with themed icon and background, installSplashScreen before onCreate, keep-on-screen tied to a root ViewModel and an exit animation.",
    "path": "capabilities/splash-screen/README.md",
    "minSdk": 24
  },
  {
    "id": "app-startup-and-baseline-profiles",
    "name": "App startup and Baseline Profiles",
    "category": "performance",
    "summary": "App Startup initializers for ordered lazy init, a baselineprofile module with Macrobenchmark 1.5.0, a profile generator, startup benchmark and release packaging checks.",
    "path": "capabilities/app-startup-and-baseline-profiles/README.md",
    "minSdk": 24
  },
  {
    "id": "crash-reporting",
    "name": "Crash reporting",
    "category": "diagnostics",
    "summary": "Firebase Crashlytics behind a CrashReporter interface, mapping upload, non-fatals with keys and breadcrumbs, consent toggle and a forced test crash.",
    "path": "capabilities/crash-reporting/README.md",
    "minSdk": 24
  },
  {
    "id": "analytics-events",
    "name": "Analytics events",
    "category": "diagnostics",
    "summary": "Firebase Analytics with a typed event catalog, consent mode defaults off in the manifest, screen tracking from Navigation Compose, DebugView verification and a recording fake.",
    "path": "capabilities/analytics-events/README.md",
    "minSdk": 24
  },
  {
    "id": "network-security-config",
    "name": "Network security config",
    "category": "security",
    "summary": "Cleartext blocked, per-domain certificate pinning with backup pins and expiry, debug-only user CA trust, OkHttp CertificatePinner and tests that prove failures.",
    "path": "capabilities/network-security-config/README.md",
    "minSdk": 24
  },
  {
    "id": "wear-os-companion",
    "name": "Wear OS companion",
    "category": "wear",
    "summary": "Minimal :wear module with Compose for Wear OS and the Data Layer API syncing a small state object from the phone; runtime-unverified in this repository.",
    "path": "capabilities/wear-os-companion/README.md",
    "minSdk": 30
  },
  {
    "id": "auto-backup-and-data-extraction-rules",
    "name": "Auto Backup and data extraction rules",
    "category": "persistence",
    "summary": "fullBackupContent and dataExtractionRules excluding secrets, device ids and caches, secrets in noBackupFilesDir, restore detection and bmgr-based restore testing.",
    "path": "capabilities/auto-backup-and-data-extraction-rules/README.md",
    "minSdk": 24
  }
];
