# Performance Checklist

Each item has a one-line reason and, where it helps, the command or snippet that checks it. Measure on a release build with R8 on a mid-range physical device; debug builds and emulators mislead on timing. Benchmark library: `androidx.benchmark:benchmark-macro-junit4:1.5.0`.

## Startup

- [ ] Cold start to first frame under 500 ms on a mid-range device, measured with Macrobenchmark `StartupTimingMetric`, because Play vitals flags cold starts over 5 s and users abandon far earlier.
- [ ] `Application.onCreate` does no I/O, no network and no synchronous SDK initialization; move SDK init to `androidx.startup` initializers or lazy injection so the main thread reaches the first Activity quickly.
- [ ] Baseline profile generated and shipped (`androidx.profileinstaller` plus `baseline-prof.txt` in `src/main`), because AOT-compiling the startup path cuts cold start by 20 to 40 percent on first launch after install.

```kotlin
// baselineprofile module, build.gradle.kts
plugins { id("androidx.baselineprofile") }
// app/build.gradle.kts
plugins { id("androidx.baselineprofile") }
dependencies { baselineProfile(project(":baselineprofile")); implementation("androidx.profileinstaller:profileinstaller:<version>") }
```

```sh
./gradlew :app:generateBaselineProfile      # needs a device or a Gradle-managed device
```

- [ ] Startup profile also generated (same plugin, `includeInStartupProfile = true` in the collector) so DEX layout puts startup classes together.
- [ ] Splash screen uses `androidx.core:core-splashscreen` and `setKeepOnScreenCondition` only while a real precondition loads; a fixed delay is a slower app, not a nicer one.
- [ ] Main-thread disk reads at startup caught with `StrictMode` in debug builds.

```kotlin
if (BuildConfig.DEBUG) {
    StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectAll().penaltyLog().build())
    StrictMode.setVmPolicy(StrictMode.VmPolicy.Builder().detectLeakedClosableObjects().detectActivityLeaks().penaltyLog().build())
}
```

## Compose rendering

- [ ] No jank in scrolling lists: Macrobenchmark `FrameTimingMetric` P90 under 16 ms at 60 Hz (8 ms at 120 Hz), because a dropped frame is visible and Play vitals reports slow rendering.
- [ ] Every `LazyColumn` / `LazyRow` / `LazyVerticalGrid` passes `key` and, for mixed content, `contentType`, because without keys an insert recomposes every item below it.
- [ ] Screen-level composables are skippable: `build/compose_reports/*-composables.txt` shows `restartable skippable` and `*-classes.txt` shows no `unstable` for your UI state types (see [../patterns/ui/compose-state.md](../patterns/ui/compose-state.md)).
- [ ] Per-frame values (scroll offset, animation progress) are read in `graphicsLayer {}`, `offset {}`, `drawBehind {}` lambdas rather than as composable parameters, so they invalidate draw or layout rather than composition.
- [ ] `derivedStateOf` wraps fast-changing inputs that produce rarely-changing outputs (`firstVisibleItemIndex > 0`), not cheap parameter transformations.
- [ ] No allocation in `Modifier.drawBehind` / `Canvas` lambdas; `remember` the `Paint`, `Path` and `Brush`.
- [ ] Layout Inspector recomposition counts checked for the heaviest screen: a row's count should not change while scrolling.
- [ ] Deep modifier chains on list items reduced; `Modifier` chains allocate per node, and `Modifier.Node`-based modifiers from the current Compose version are preferred over `composed {}`.

## Images

- [ ] Coil (`io.coil-kt.coil3:coil-compose:<version>`) or Glide used for all network and large local images; both decode off the main thread, downsample to the target size and cache on disk and in memory.
- [ ] Request size bounded (`Modifier.size` or `ImageRequest.size`), because decoding a 4000 px photo for a 96 dp avatar costs memory and time.
- [ ] Memory cache sized by Coil defaults (a fraction of app memory), not overridden upward.
- [ ] Vector drawables for icons; raster assets provided as WebP, not PNG, which cuts asset size by 25 to 35 percent.
- [ ] Hardware bitmaps allowed (default in Coil) except where the bitmap is read on CPU.

## Overdraw and layout

- [ ] "Debug GPU overdraw" in developer options shows mostly blue/none on main screens; red areas mean four or more layers and usually a redundant `background` on a `Surface` or `Scaffold`.
- [ ] No nested scrolling containers of the same orientation (`LazyColumn` inside `Column(verticalScroll)`); it crashes or measures infinitely.
- [ ] `Modifier.fillMaxSize()` on content that later gets `padding(innerPadding)`; order matters and inverted order double-pads.

## Memory

- [ ] LeakCanary in debug builds only (`debugImplementation("com.squareup.leakcanary:leakcanary-android:<version>")`), because it finds Activity and ViewModel leaks automatically with no code.
- [ ] No `Context`, `View` or `Activity` references in ViewModels, singletons or companion objects; use `@ApplicationContext` where a context is unavoidable.
- [ ] Coroutines launched in `viewModelScope` or `lifecycleScope`, never `GlobalScope`, so they are cancelled with their owner.
- [ ] Listeners and callbacks registered in `DisposableEffect` are unregistered in `onDispose`.
- [ ] Large lists paged with Paging 3.5.1 rather than loaded whole; a 10,000-row `List` in a `StateFlow` is copied on every update.
- [ ] Heap dump checked once per release in Android Studio Profiler for retained bitmaps and duplicate strings.

## Network and data

- [ ] OkHttp cache configured for GET responses the server marks cacheable, so repeated screens do not refetch.
- [ ] Room queries return only needed columns for list screens (projection data classes), with indices on columns in `WHERE` and `ORDER BY`.
- [ ] Room `Flow` queries scoped with `stateIn(WhileSubscribed(5_000))` so a backgrounded app stops observing.
- [ ] JSON parsed with kotlinx.serialization on `Dispatchers.Default` for large payloads; Retrofit converters run on the calling dispatcher.
- [ ] WorkManager 2.12.0 for deferred uploads with constraints, not a foreground service polling in a loop.

## Build output

- [ ] R8 full mode (`android.enableR8.fullMode=true` in `gradle.properties`, default since AGP 8) with `isMinifyEnabled = true` and `isShrinkResources = true` on release; shrinks code and resources and removes unused SDK code paths.
- [ ] Keep rules minimal and justified; a blanket `-keep class com.example.** { *; }` disables most of the benefit.
- [ ] App bundle download size checked in the Play Console (App bundle explorer) per device; aim for under 30 MB on phones unless the app ships media.
- [ ] Unused resources removed (`lint` `UnusedResources`), language resources limited with `androidResources.localeFilters` if the app ships few translations.
- [ ] Native libraries built for `arm64-v8a` (required) and `armeabi-v7a` only if the minSdk and market need it; `x86_64` for emulator and ChromeOS. Each ABI is a separate split in the bundle, so extra ABIs do not increase the per-device download.
- [ ] Dependencies reviewed for size with `./gradlew :app:dependencies`; a utility pulled in for one function is a candidate for removal.

## Benchmarks in CI

- [ ] A `:macrobenchmark` module with at least `StartupTimingMetric` (cold, `CompilationMode.Partial()` with baseline profile) and one `FrameTimingMetric` scroll test on the main list.

```kotlin
@RunWith(AndroidJUnit4::class)
class StartupBenchmark {
    @get:Rule val rule = MacrobenchmarkRule()

    @Test fun coldStartup() = rule.measureRepeated(
        packageName = "com.example.app",
        metrics = listOf(StartupTimingMetric()),
        iterations = 5,
        startupMode = StartupMode.COLD,
        compilationMode = CompilationMode.Partial(),
    ) {
        pressHome()
        startActivityAndWait()
    }
}
```

- [ ] Benchmarks run on a physical device or a Gradle-managed device in CI on a schedule (nightly), not on every PR, with results exported as JSON and compared to the previous run; a 10 percent regression fails the job.
- [ ] Microbenchmarks (`benchmark-junit4`) only for hot pure-Kotlin code (parsers, diff algorithms); they are not a substitute for frame timing.

## Verify

```sh
./gradlew :app:assembleRelease
./gradlew :macrobenchmark:connectedBenchmarkReleaseAndroidTest
# Results: macrobenchmark/build/outputs/connected_android_test_additional_output/**/*.json
./gradlew :app:lintRelease                                  # UnusedResources and others
adb shell am start -W -n com.example.app/.MainActivity      # quick TotalTime for cold start
adb shell dumpsys gfxinfo com.example.app framestats        # frame histogram after scrolling
```

Report numbers from a release build on a named device. "Feels fast on the emulator" is not a measurement.

## Sources

- https://developer.android.com/topic/performance/overview
- https://developer.android.com/topic/performance/vitals/launch-time
- https://developer.android.com/topic/performance/baselineprofiles/overview
- https://developer.android.com/topic/performance/benchmarking/macrobenchmark-overview
- https://developer.android.com/develop/ui/compose/performance
- https://developer.android.com/develop/ui/compose/performance/bestpractices
- https://developer.android.com/topic/performance/memory
- https://developer.android.com/build/shrink-code
- https://developer.android.com/jetpack/androidx/releases/benchmark
- https://square.github.io/leakcanary/
- https://coil-kt.github.io/coil/
