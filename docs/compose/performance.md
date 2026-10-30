# Compose performance

How Compose decides what to re-run, how to measure that instead of guessing, and the handful of changes that remove most jank: stable types, lazy layout keys, deferred state reads, reused modifiers, right-sized images and baseline profiles.

## Measure first

Profile a release build (or at least `debuggable false` with R8) on a real device. Debug builds and emulators are slow in ways that have nothing to do with your code.

1. Layout Inspector in Android Studio: enable "Show Recomposition Counts". Each composable shows how many times it recomposed and was skipped. A count that climbs while nothing visible changes is the thing to fix.
2. Compose compiler reports: tell you which classes the compiler considers stable and which composables are skippable or restartable.

```kotlin
// app/build.gradle.kts
composeCompiler {
    reportsDestination = layout.buildDirectory.dir("compose_compiler")
    metricsDestination = layout.buildDirectory.dir("compose_compiler")
}
```

```sh
./gradlew :app:assembleRelease
cat app/build/compose_compiler/app_release-classes.txt     # stable / unstable per class
cat app/build/compose_compiler/app_release-composables.txt # restartable skippable fun ...
```

3. Macrobenchmark (`androidx.benchmark:benchmark-macro-junit4`, Benchmark 1.5.0) for startup and scroll jank, with `FrameTimingMetric` and `StartupTimingMetric`.
4. `adb shell dumpsys gfxinfo com.example.app` for janky frame percentages on a device during a manual scroll.

Fix what the numbers show. Do not sprinkle `@Stable` or `remember` across a codebase on suspicion.

## Stability and skipping

Compose skips a composable on recomposition when all of its parameters are unchanged and their types are stable. A type is stable when the compiler can prove its public properties do not change without Compose knowing:

- Primitives, `String`, functional types: stable.
- A `data class` whose properties are all `val` of stable types: stable.
- A class with a `var` property, or a `val` of an unstable type: unstable.
- `List`, `Set`, `Map` interfaces: unstable, because the implementation could be mutable.
- Classes from modules without the Compose compiler (most third-party libraries, your own `:domain` module if it does not apply the plugin): unstable unless listed in a stability configuration file.

### Strong skipping mode

With Kotlin 2.0 and later the Compose compiler enables strong skipping mode by default. Under strong skipping:

- Composables with unstable parameters are still skippable; unstable parameters are compared by instance equality (`===`), stable ones by `equals`.
- Lambdas in composables are memoized automatically, including those that capture unstable values.

This removes most of the historical need to wrap collections or annotate classes. What still matters:

- A new `List` instance created on every recomposition (`notes.filter { }` in the body) defeats instance equality. `remember` it keyed on its inputs, or compute it in the ViewModel.
- Unstable types in `derivedStateOf` or `key` comparisons still compare by reference.
- Stability still affects `LazyColumn` item content reuse and `Modifier.composed`-style APIs.

Verify with the compiler report; do not assume.

### Making types stable when it matters

```kotlin
@Immutable
data class NoteListUiModel(val notes: List<NoteUiModel>)
```

`@Immutable` is a promise to the compiler that the object never changes after construction. Breaking the promise causes missed recompositions. `@Stable` is the weaker promise that changes will be notified through Compose state.

For collections, `kotlinx.collections.immutable` (`ImmutableList`, `PersistentList`) is recognized as stable without annotation. Resolve its version from the project's release page; it is not in `data/versions.json`.

For classes you do not own, a stability configuration file:

```kotlin
composeCompiler {
    stabilityConfigurationFiles.add(rootProject.layout.projectDirectory.file("compose_stability.conf"))
}
```

```
// compose_stability.conf
java.time.Instant
kotlinx.datetime.LocalDate
com.example.domain.*
```

## Stability configuration and compiler reports in a multi-module project

Now in Android (see [../../references/nowinandroid.md](../../references/nowinandroid.md)) keeps one stability file at the repository root, named `compose_compiler_config.conf`, and wires it plus the report tasks from the Compose convention plugin so every Compose module gets the same configuration without touching its build file.

### The configuration file

```
// compose_compiler_config.conf (repository root)
// Classes the Compose compiler treats as stable even though it cannot see their source.
// https://developer.android.com/develop/ui/compose/performance/stability/fix#configuration-file

// The model module is a JVM library without the Compose plugin; every class in it is an immutable
// data class, so declare the whole package stable instead of annotating each type or applying the plugin there.
com.example.app.core.model.*

// JDK types used in UiState that the compiler would otherwise call unstable.
java.time.Instant
java.time.ZoneId
java.time.ZoneOffset
java.time.LocalDate
```

Wildcards cover a package, not subpackages; list each package. Listing a class here is a promise identical to `@Immutable`: if a listed class gains a `var`, composables taking it will skip when they should not and the bug will look like "the UI did not update". Keep the file to types that are actually immutable and review it in the same pull request as the model change.

### Wiring it once in build logic

```kotlin
// build-logic/convention/src/main/kotlin/com/example/app/buildlogic/AndroidCompose.kt (excerpt)
import org.jetbrains.kotlin.compose.compiler.gradle.ComposeCompilerGradlePluginExtension

extensions.configure<ComposeCompilerGradlePluginExtension> {
    // Same file for every module; relative to the root project, works with isolated projects.
    stabilityConfigurationFiles.add(isolated.rootProject.projectDirectory.file("compose_compiler_config.conf"))

    // Reports and metrics only on demand: they slow compilation and churn build/ output.
    val enabled = providers.gradleProperty("enableComposeCompilerReports").map(String::toBoolean).orElse(false)
    val outDir = isolated.rootProject.projectDirectory.dir("build/compose-reports").dir(path.replace(':', '_'))
    if (enabled.get()) {
        reportsDestination.set(outDir)
        metricsDestination.set(outDir)
    }
}
```

The full convention plugin is in [../../patterns/clean-architecture.md](../../patterns/clean-architecture.md). In a single-module app the same two settings go in `app/build.gradle.kts` under `composeCompiler { }`, as shown in the "Measure first" section above.

### Strong skipping is the default; what the file still buys you

With Kotlin 2.0+ strong skipping is on, so a composable with an unstable `List<Note>` parameter still skips when the same instance is passed again. The configuration file matters for the cases strong skipping does not cover:

- Parameters compared by `equals` rather than identity. A `UiState` rebuilt by `copy()` with equal contents is a new instance; if its type is unstable, instance comparison says "changed" and the screen recomposes. Listing the model package makes the comparison structural.
- `remember(key)` and `derivedStateOf` keys of unstable types compare by reference.
- Lambdas capturing unstable values are memoized under strong skipping, but their equality is still reference-based, so a lambda rebuilt around a new-but-equal unstable object invalidates its consumer.

Opting out of strong skipping (`featureFlags.add(ComposeFeatureFlag.StrongSkipping.disabled())`) is only for diagnosing a suspected skipping bug; do not ship with it off.

### Running the report task

```sh
./gradlew :app:assembleRelease -PenableComposeCompilerReports=true
ls build/compose-reports/_app/
#   app_release-classes.txt       stable / unstable verdict per class with the reason
#   app_release-composables.txt   restartable / skippable / readonly per composable, with parameter stability
#   app_release-composables.csv   same, for spreadsheets
#   app_release-module.json       counts: skippable, restartable, readonly, lambdas memoized
```

Read `classes.txt` for a class you expected to be stable; the line names the first unstable property. Read `composables.txt` for `restartable scheme(...)` entries without `skippable`; each lists the parameter whose type blocked skipping. Fix the type (immutable, listed in the configuration file, or `@Immutable`) and re-run; the report is the test. Run it per module (`:feature:orders:impl:assembleRelease -PenableComposeCompilerReports=true`) when the app module is large; the output directory is keyed by module path.

Do not commit the reports; `build/` is already ignored. Do not leave the property set in `gradle.properties`; it slows every compile.

## Lazy layouts

- Always pass `key`. Without it, inserting at the top re-binds every row and loses per-item state.
- Pass `contentType` when a list mixes row types so Compose reuses the right composition slots.
- Do not nest a scrollable `LazyColumn` inside a vertically scrollable `Column`. Use one `LazyColumn` with multiple `item`/`items` sections.
- Do not use `items(list.size) { index -> list[index] }` with `key = { index }`; the index is not an identity.
- Keep item composables small and stateless. State they need (`expanded`) should be keyed to the item id in the ViewModel or in `rememberSaveable` inside the item, which works because `key` makes the item's saved state follow it.
- Avoid `Modifier.animateItem()` on huge lists unless measured; it is cheap per item but not free.
- For images in lists, request a bounded size (see Images).

```kotlin
LazyColumn(state = listState, contentPadding = innerPadding) {
    item(key = "header", contentType = "header") { Header() }
    items(notes, key = { it.id.raw }, contentType = { "note" }) { note ->
        NoteRow(note = note, onClick = { onOpen(note.id) })
    }
}
```

The `onClick` lambda above captures `note` and is re-created per item; under strong skipping it is memoized per item. If the report shows `NoteRow` not skipping, pass `onOpen` and `note.id` down and build the lambda inside instead.

## Defer state reads

Compose has three phases: composition, layout, draw. Reading a state object in a later phase restricts the invalidation to that phase. A scroll offset read during composition recomposes the whole tree every frame; read in layout or draw it only re-lays-out or redraws.

```kotlin
// Anti-pattern: reads scroll state in composition, recomposes every frame while scrolling.
val offset = listState.firstVisibleItemScrollOffset
Image(modifier = Modifier.offset(y = (offset * 0.5f).dp), /* ... */)

// Lambda modifier reads the state during layout only.
Image(modifier = Modifier.offset { IntOffset(x = 0, y = (listState.firstVisibleItemScrollOffset * 0.5f).roundToInt()) }, /* ... */)
```

The same applies to `Modifier.graphicsLayer { alpha = ... }` versus `Modifier.alpha(...)`, `Modifier.drawBehind { }` versus passing a `Color` parameter, and `animateFloatAsState` values consumed in lambdas rather than in composition.

`derivedStateOf` helps when a frequently changing input maps to a rarely changing output (`firstVisibleItemIndex > 0`).

## Modifiers

- Build a `Modifier` chain once and reuse it when the same chain applies to many siblings. Hoist it to a `val` outside the loop or into a `remember`.
- Order matters and affects allocations: `padding` before `background` paints a smaller area than after.
- Prefer `Modifier.Node`-based custom modifiers over `Modifier.composed { }`, which recomposes per use.
- Pass `modifier: Modifier = Modifier` as the first optional parameter of every public composable and apply it once, to the root element.

```kotlin
val chipModifier = Modifier.padding(horizontal = 4.dp).height(32.dp)
Row { tags.forEach { tag -> TagChip(tag, modifier = chipModifier) } }
```

## Images

- Load with Coil (`io.coil-kt.coil3:coil-compose`; resolve the version from the Coil release page). Never decode a `Bitmap` on the main thread.
- Request a size close to the display size so the decoder downsamples. `AsyncImage` with a sized `Modifier` does this automatically; for `ImageRequest` set `.size(...)`.
- Use `ContentScale.Crop` with a fixed aspect ratio in lists so rows do not reflow when images arrive.
- Give list images a stable `key` through the item key; the request is cached by URL in memory and on disk.
- Vector drawables for icons; `painterResource` of a large PNG in a list is a common source of jank.
- Prefer WebP or AVIF assets; lint flags oversized PNGs.

## Startup and baseline profiles

Baseline profiles tell ART which methods to precompile, cutting cold start and first-scroll jank significantly in release builds.

1. Add a `:baselineprofile` module with `androidx.baselineprofile` plugin (Benchmark 1.5.0 toolchain).
2. Write a `BaselineProfileRule` test that launches the app and scrolls the main screens.
3. `./gradlew :app:generateBaselineProfile` writes `app/src/main/generated/baselineProfiles/baseline-prof.txt`.
4. Ship it; `profileinstaller` installs it on first run. Measure with a `StartupTimingMetric` macrobenchmark, compiling with `CompilationMode.Partial()`.

Other startup rules: no synchronous disk or network in `Application.onCreate`; initialize SDKs lazily or with App Startup; keep the splash theme to `Theme.SplashScreen` and `installSplashScreen()` so first frame is cheap.

## Recomposition checklist

When a composable recomposes more than expected:

1. Is a parameter a new instance each time (a `List` built in the body, a lambda that captures an unstable value in non-strong-skipping mode, an object constructed without `remember`)?
2. Is the composable reading a state object it does not need (a whole `uiState` when it only uses one field)? Pass the field.
3. Is a frequently changing value (scroll, animation) read in composition? Defer to layout or draw.
4. Does the compiler report list the composable as not skippable? Look at the unstable parameter it names.
5. Is `LazyColumn` missing `key`?

## Verify

```sh
./gradlew :app:assembleRelease
grep -c "unstable" app/build/compose_compiler/app_release-classes.txt
grep "restartable" app/build/compose_compiler/app_release-composables.txt | grep -v skippable
./gradlew :macrobenchmark:connectedBenchmarkReleaseAndroidTest
```

Then Layout Inspector recomposition counts on the screen you changed while performing the interaction you optimized. Report the before and after frame timings, not an impression.

## Sources

- https://developer.android.com/develop/ui/compose/performance
- https://developer.android.com/develop/ui/compose/performance/bestpractices
- https://developer.android.com/develop/ui/compose/performance/stability
- https://developer.android.com/develop/ui/compose/performance/stability/diagnose
- https://developer.android.com/develop/ui/compose/performance/stability/fix
- https://developer.android.com/develop/ui/compose/performance/stability/strongskipping
- https://developer.android.com/develop/ui/compose/compiler
- https://developer.android.com/develop/ui/compose/phases
- https://developer.android.com/develop/ui/compose/lists
- https://developer.android.com/topic/performance/baselineprofiles/overview
- https://developer.android.com/topic/performance/benchmarking/macrobenchmark-overview
- https://developer.android.com/develop/ui/compose/tooling/layout-inspector
