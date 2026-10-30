# Reference studies

Studies of official Android sample apps: what each sample is, which toolchain it is on compared with `data/versions.json`, which techniques this repository adopted (and where they now live), and which techniques it deliberately did not copy. The samples are Apache-2.0 from Google; the code in this repository is an original re-implementation in the `com.example.app` package, never a copy.

An agent does not need these files to write code. Read one when a user asks "how does Google's sample do X", when deciding whether a pattern in an older project is still current, or when extending a pattern file and wanting the source of a technique.

| Study | Sample | Covers |
|---|---|---|
| [nowinandroid.md](nowinandroid.md) | `android/nowinandroid` | Convention plugins and an included `build-logic`, `:feature:x:api`/`impl` split, `:core:*` taxonomy, Proto DataStore, change-list offline-first sync with WorkManager, design system module and catalog app, custom lint module, test-double modules with `@TestInstallIn`, Roborazzi screenshots, Compose compiler stability file, CI with Spotless, Dependency Guard and baseline profiles |
| [architecture-samples.md](architecture-samples.md) | `android/architecture-samples` | `UiState` built by `combine` with an `Async` wrapper, `WhileUiSubscribed`, one-off messages as state, a `shared-test` module of fakes used by JVM and instrumented tests, navigation tests through a debug-only Hilt Activity and the real graph |
| [compose-samples.md](compose-samples.md) | `android/compose-samples` (JetNews, Jetsnack, Jetchat, Jetcaster, JetLagged, Reply) | Adaptive navigation and two-pane shells, custom design systems, shared element and keyboard-aware animation, Compose state holders, rich text, custom drawing, TV module, semantics |
| [sunflower.md](sunflower.md) | `android/sunflower` | Room seeding from assets through WorkManager, `@Relation` and `@Transaction` queries as `Flow`, image placeholders in lists |
| [ndk-samples.md](ndk-samples.md) | `android/ndk-samples` | JNI bridge with `RegisterNatives`, version scripts, 16 KB pages, Prefab, sanitizer build types, googletest on device, GameActivity/Vulkan/GLES hosts; current vs legacy samples |
| [uamp.md](uamp.md) | `android/uamp` | Single playback service, browse tree for Android Auto/Automotive, caller allowlisting, notification, Cast, re-expressed on Media3 1.11.1 (sample is legacy ExoPlayer 2 / MediaBrowserServiceCompat) |

Each study ends with `## Attribution` naming the sample, its GitHub URL and the license.
