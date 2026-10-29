# Testing Checklist

What to test at which level, and the commands CI runs. The detailed how-to lives in [../patterns/testing/unit-testing.md](../patterns/testing/unit-testing.md), [../patterns/testing/compose-ui-testing.md](../patterns/testing/compose-ui-testing.md) and [../patterns/testing/screenshot-testing.md](../patterns/testing/screenshot-testing.md).

## The pyramid for Android

```
          ┌──────────────┐
          │  Instrumented │  few: critical flows on a device, Hilt-wired
          ├──────────────┤
          │  Screenshot   │  per component and screen state, JVM
          ├──────────────┤
          │  Compose UI   │  per screen state, Robolectric on the JVM
          ├──────────────┤
          │  Unit         │  many: ViewModels, reducers, use cases, repositories, mappers
          └──────────────┘
```

Rule: push every assertion to the lowest level that can express it. A business rule is a unit test, not a UI test. A layout regression is a screenshot, not a device test.

## Unit tests (JVM, `testDebugUnitTest`)

- [ ] Every ViewModel has tests for: initial state, each loading/empty/success/error path, each public action, and the one-off message or navigation state being cleared; these are the cheapest tests and the ones that catch most logic bugs.
- [ ] Every reducer (if MVI) has a pure test per result type; no coroutines needed.
- [ ] Every repository has tests against an in-memory Room database and a fake API covering: read emits from cache, write updates the cache, refresh maps each failure class, pending changes survive a failed push.
- [ ] Every use case with logic has tests; forwarding use cases do not exist (see [../patterns/clean-architecture.md](../patterns/clean-architecture.md)).
- [ ] Error mapping (`Throwable.toAppError`) has one test per exception class, because a missed class silently becomes `Unknown`.
- [ ] Retry and backoff tested with virtual time (`runTest`, `advanceTimeBy`), including the non-retryable path.
- [ ] Mappers with renamed or transformed fields have a round-trip test.
- [ ] `CancellationException` behavior tested where code catches broadly: cancel the scope and assert no state update happened afterward.
- [ ] All tests use `MainDispatcherRule` and an injected test dispatcher; no `Thread.sleep`, no `runBlocking` against `Dispatchers.Main`.
- [ ] Fakes live in `:core:testing` and are shared with previews; MockK only for third-party interfaces.
- [ ] Room migrations tested with `MigrationTestHelper` whenever the schema version increments (instrumented, because SQLite versions differ).

## Compose UI tests (JVM under Robolectric, also `testDebugUnitTest`)

- [ ] Every screen's stateless composable is tested in each `UiState` variant: loading shows an indicator, empty shows the empty message, error shows the message and the retry button, success renders the items.
- [ ] Each callback is asserted: clicking the row calls `onToggle` with the right item, typing and pressing Add calls `onAdd`.
- [ ] Nodes are found by text or content description first, `testTag` only for nodes without user-visible text; this doubles as an accessibility check.
- [ ] Lazy lists tested with enough items to require `performScrollToNode`.
- [ ] Animations handled with `mainClock` control, never `Thread.sleep`.
- [ ] Navigation between two screens tested with `TestNavHostController` for at least the main forward and back path.

## Screenshot tests (JVM, `validateDebugScreenshotTest`)

- [ ] Each reusable component has previews in light, dark and font scale 2.0 in the `screenshotTest` source set.
- [ ] Each screen has at least the success state in phone and tablet widths.
- [ ] Previews are deterministic: fixed data, fixed clock, `dynamicColor = false`, bundled fonts, placeholder images.
- [ ] Reference images committed and reviewed in pull requests; regeneration happens only for intentional changes.

## Instrumented tests (device or emulator, `connectedDebugAndroidTest`)

- [ ] A small number of Hilt-wired flow tests through `MainActivity` with `@TestInstallIn` fakes: sign in, the primary create/edit flow, and the purchase or submit flow if any.
- [ ] One test per deep link entry point that opens the app from an intent and asserts the destination.
- [ ] Permission flows tested with `GrantPermissionRule` for the granted path and a UI test for the rationale path.
- [ ] Room migration tests (see above).
- [ ] Tests run on a Gradle-managed device in CI so results are reproducible without a device farm.

```kotlin
// app/build.gradle.kts
android.testOptions.managedDevices.localDevices {
    create("pixel7Api35") {
        device = "Pixel 7"
        apiLevel = 35
        systemImageSource = "aosp-atd"   // automated test device image: faster, no Play services
    }
}
```

## Accessibility and performance tests

- [ ] Semantics assertions in UI tests: icon buttons have content descriptions, custom controls have roles, rows merge into one node.
- [ ] Macrobenchmark startup and one scroll benchmark exist and run nightly (see [performance.md](performance.md)).
- [ ] Accessibility Scanner or the pre-launch report reviewed before each release (see [accessibility.md](accessibility.md)).

## Coverage and gates

- [ ] Coverage measured with JaCoCo or Kover on the JVM tests and reported per module; use the number to find untested ViewModels, not as a target to game.
- [ ] CI fails on any test failure, on lint errors, and on a screenshot diff; flaky tests are quarantined with an issue, not retried silently.
- [ ] Tests run on every pull request: `test`, `lint`, `validateDebugScreenshotTest`. Instrumented tests and benchmarks run on merge to main or nightly because they need an emulator.
- [ ] The test task finishes in under five minutes for the JVM suite; longer usually means real dispatchers, real I/O or Robolectric where plain JUnit would do.

## CI commands

```sh
# Pull request gate (JVM only, ~minutes)
./gradlew assembleDebug lintDebug testDebugUnitTest validateDebugScreenshotTest --continue

# Merge / nightly (needs an emulator)
./gradlew pixel7Api35DebugAndroidTest
./gradlew :macrobenchmark:pixel7Api35BenchmarkReleaseAndroidTest

# Single module or class while iterating
./gradlew :feature:todo:testDebugUnitTest --tests "*TodoViewModelTest*"
```

Reports: `**/build/reports/tests/`, `**/build/reports/lint-results-debug.html`, `**/build/reports/screenshotTest/`, `**/build/reports/androidTests/`.

## Verification language

When reporting status, say which of these you did, because they are different claims:

- "Inspected source": read the code, found no issue. Weakest.
- "Compiled": `assembleDebug` succeeded.
- "Unit tested": `testDebugUnitTest` passed, and name the tests.
- "UI tested": Compose tests passed under Robolectric or on a device; say which.
- "Verified on device": ran the app on a named device or emulator and exercised the flow.

Do not claim a level you did not reach.

## Sources

- https://developer.android.com/training/testing/fundamentals
- https://developer.android.com/training/testing/fundamentals/strategies
- https://developer.android.com/training/testing/local-tests
- https://developer.android.com/training/testing/instrumented-tests
- https://developer.android.com/develop/ui/compose/testing
- https://developer.android.com/studio/preview/compose-screenshot-testing
- https://developer.android.com/studio/test/gradle-managed-devices
- https://developer.android.com/training/testing/fundamentals/test-doubles
