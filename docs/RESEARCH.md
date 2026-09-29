# Current technology research

Checked 2026-09-29 using official Android, Google, Firebase, Kotlin and Gradle sources. The machine-readable catalog is `data/versions.json`. These are dated observations, not perpetual "latest" claims. Recheck before changing a project. No automatic upgrades are performed.

## Toolchain and policy

| Topic | Observed | Official source |
|---|---|---|
| Android | Android 17 / API 37 | https://developer.android.com/about/versions/17 |
| AGP | 9.4.0; documented Gradle minimum/default 9.6.0, JDK 17, maximum API 37 | https://developer.android.com/build/releases/agp-9-4-0-release-notes |
| Gradle | Standalone latest 9.8.0; not a reason to override AGP compatibility | https://docs.gradle.org/current/release-notes.html |
| Android Studio | Quail 4, 2026.1.4 Patch 1 | https://developer.android.com/studio/releases |
| Kotlin / KMP | Kotlin 2.4.20; Android KMP plugin compatibility still needs project-specific validation | https://kotlinlang.org/docs/releases.html |
| Platform Tools / adb | 37.0.1 | https://developer.android.com/tools/releases/platform-tools |
| Play submissions | From 2026-08-31: phone/tablet 36, Wear/Automotive 35, TV/XR 34; exceptions/extensions need Console review | https://developer.android.com/google/play/requirements/target-sdk |
| minSdk | Product decision plus actual dependency requirements; AndroidX currently documents default 24 | https://developer.android.com/jetpack/androidx/versions |

## Libraries

Compose BOM 2026.09.00 is sourced from [the BOM guide](https://developer.android.com/develop/ui/compose/bom). Library families and stable versions are recorded from [the AndroidX release table](https://developer.android.com/jetpack/androidx/versions): Compose 1.12.1, Material3 1.4.0, Navigation 2.10.2, Navigation3 1.2.0, Room 2.8.5 and Room3 3.0.3, Lifecycle/ViewModel 2.11.0, WorkManager 2.12.0, DataStore 1.2.1, Camera 1.6.2, Media3 1.11.1, Credentials 1.6.0, Paging 3.5.1, AndroidX Hilt 1.4.0, Benchmark 1.5.0, Window 1.5.1 and Car App 1.7.0. AndroidX Hilt is not the Dagger Hilt compiler version.

[Firebase release notes](https://firebase.google.com/support/release-notes/android) list BoM 34.18.0. [Play Billing release notes](https://developer.android.com/google/play/billing/release-notes) list 9.0.0. A BoM coordinates its own library family, not every Google dependency. Material Expressive support must be checked per API annotation; the stable Material3 package is not a blanket guarantee.

## Execution and provider sources

- [ADB](https://developer.android.com/tools/adb), [AVD manager](https://developer.android.com/tools/avdmanager), [emulator CLI](https://developer.android.com/studio/run/emulator-commandline).
- [Firebase rules basics](https://firebase.google.com/docs/rules/basics). Audit source locally; verify rules behavior with the Emulator Suite before deployment.
- [Gemini libraries](https://ai.google.dev/gemini-api/docs/libraries), [function calling](https://ai.google.dev/gemini-api/docs/function-calling), [structured output](https://ai.google.dev/gemini-api/docs/structured-output). The adapter uses documented REST endpoints; no deprecated Android client API is embedded.
- [OpenAI quickstart](https://developers.openai.com/api/docs/quickstart). The adapter uses Responses with explicit model IDs and storage disabled.
- [Macrobenchmark](https://developer.android.com/topic/performance/benchmarking/macrobenchmark-overview), [Compose screenshot testing](https://developer.android.com/studio/preview/compose-screenshot-testing), [Android XR](https://developer.android.com/develop/xr).

## Explicitly unresolved

The catalog records unknowns rather than filling them with guesses: exact current emulator/bundletool versions, selected Maps/Places artifacts, Play Integrity version, Dagger Hilt pair, Wear OS image and screenshot-plugin compatibility. Google Play services and ML Kit have independently versioned artifacts. LiteRT needs runtime/API selection. Android Auto, Automotive, TV, large-screen/foldable and XR scenarios require their own device and SDK acceptance tests. The initial research does not satisfy every production-readiness requirement; these items remain release gates.

Documentation search is a curated source index. Offline results include a URL and null retrieval date. `--refresh` explicitly fetches official pages and records the actual retrieval timestamp/hash in a local cache. Redirects are refused instead of silently leaving the allowlist. No search-engine API or stale embedded documentation corpus is claimed.
