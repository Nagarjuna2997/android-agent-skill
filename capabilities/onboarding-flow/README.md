# Onboarding flow

A first-run onboarding in Compose: a `HorizontalPager` of pages with indicators, skip and next actions, a permission priming page that only explains (the real request happens in context later), completion stored in DataStore so the flow shows once, start-destination selection in `NavHost` without flicker, and tests for the ViewModel and the pager.

## When to use

- The app benefits from a short explanation of what it does or needs to collect an initial choice (units, interests, account) before the main screen.
- Keep it to three or four pages; every page costs activation. Do not block the app behind sign-in in onboarding unless the product has no logged-out state.
- Pair with [splash-screen](../splash-screen/README.md) to hold the splash until the "has onboarded" value is read, so the user never sees the wrong first screen.

## Dependencies

`HorizontalPager` is in `androidx.compose.foundation` from the Compose BOM; no extra artifact. Persistence through [datastore-preferences](../datastore-preferences/README.md).

```toml
[versions]
datastore = "1.2.1"
navigation = "2.10.2"

[libraries]
datastore-preferences = { group = "androidx.datastore", name = "datastore-preferences", version.ref = "datastore" }
navigation-compose = { group = "androidx.navigation", name = "navigation-compose", version.ref = "navigation" }
```

```kotlin
dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.datastore.preferences)
    implementation(libs.navigation.compose)
}
```

## Manifest and permissions

None. Onboarding must not request permissions itself; it primes the user and the feature asks later.

## Implementation

### Pages model

```kotlin
package com.example.app.ui.onboarding

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import com.example.app.R

data class OnboardingPage(
    @DrawableRes val image: Int,
    @StringRes val title: Int,
    @StringRes val body: Int,
)

val onboardingPages = listOf(
    OnboardingPage(R.drawable.onboarding_capture, R.string.onb_capture_title, R.string.onb_capture_body),
    OnboardingPage(R.drawable.onboarding_organize, R.string.onb_organize_title, R.string.onb_organize_body),
    OnboardingPage(R.drawable.onboarding_notify, R.string.onb_notify_title, R.string.onb_notify_body),   // primes notifications
)
```

### ViewModel

```kotlin
package com.example.app.ui.onboarding

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.app.data.settings.SettingsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class OnboardingUiState(
    val page: Int = 0,
    val pageCount: Int = onboardingPages.size,
    val finishing: Boolean = false,
) {
    val isLast: Boolean get() = page == pageCount - 1
}

@HiltViewModel
class OnboardingViewModel @Inject constructor(private val settings: SettingsRepository) : ViewModel() {
    private val _state = MutableStateFlow(OnboardingUiState())
    val state: StateFlow<OnboardingUiState> = _state.asStateFlow()

    fun onPageChanged(page: Int) = _state.update { it.copy(page = page) }

    fun next(onDone: () -> Unit) {
        if (_state.value.isLast) finish(onDone) else _state.update { it.copy(page = it.page + 1) }
    }

    fun finish(onDone: () -> Unit) {
        if (_state.value.finishing) return
        _state.update { it.copy(finishing = true) }
        viewModelScope.launch {
            settings.markOnboardingComplete()
            onDone()
        }
    }
}
```

The ViewModel owns the current page so that rotation and process death restore it (add `SavedStateHandle` if you want it to survive process death too).

### Screen

```kotlin
package com.example.app.ui.onboarding

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.app.R

@Composable
fun OnboardingScreen(onDone: () -> Unit, viewModel: OnboardingViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    OnboardingContent(
        state = state,
        pages = onboardingPages,
        onPageChanged = viewModel::onPageChanged,
        onNext = { viewModel.next(onDone) },
        onSkip = { viewModel.finish(onDone) },
    )
}

@Composable
fun OnboardingContent(
    state: OnboardingUiState,
    pages: List<OnboardingPage>,
    onPageChanged: (Int) -> Unit,
    onNext: () -> Unit,
    onSkip: () -> Unit,
) {
    val pagerState = rememberPagerState(initialPage = state.page) { pages.size }

    // Keep pager and ViewModel in sync in both directions.
    LaunchedEffect(pagerState) { snapshotFlow { pagerState.currentPage }.collect(onPageChanged) }
    LaunchedEffect(state.page) { if (pagerState.currentPage != state.page) pagerState.animateScrollToPage(state.page) }

    Scaffold { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            Row(Modifier.fillMaxWidth().padding(8.dp), horizontalArrangement = Arrangement.End) {
                if (!state.isLast) TextButton(onClick = onSkip) { Text(stringResource(R.string.skip)) }
            }
            HorizontalPager(state = pagerState, modifier = Modifier.weight(1f), key = { it }) { index ->
                val page = pages[index]
                Column(Modifier.fillMaxSize().padding(horizontal = 32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Image(painterResource(page.image), contentDescription = null, modifier = Modifier.size(220.dp))
                    Spacer(Modifier.height(32.dp))
                    Text(stringResource(page.title), style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(12.dp))
                    Text(stringResource(page.body), style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
                }
            }
            PageIndicator(count = pages.size, current = state.page, modifier = Modifier.align(Alignment.CenterHorizontally).padding(16.dp))
            Button(
                onClick = onNext,
                enabled = !state.finishing,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp).height(48.dp),
            ) { Text(stringResource(if (state.isLast) R.string.get_started else R.string.next)) }
        }
    }
}

@Composable
private fun PageIndicator(count: Int, current: Int, modifier: Modifier = Modifier) {
    Row(modifier.semantics { contentDescription = "Page ${current + 1} of $count" }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(count) { i ->
            Box(
                Modifier.size(if (i == current) 10.dp else 8.dp).clip(CircleShape)
                    .background(if (i == current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant)
            )
        }
    }
}
```

Page images are decorative (`contentDescription = null`); the title and body carry the meaning. The indicator exposes one semantic description rather than eight dots.

### Start destination

```kotlin
@Composable
fun AppNavHost(hasOnboarded: Boolean?) {
    val navController = rememberNavController()
    if (hasOnboarded == null) return   // splash still showing; see splash-screen capability
    NavHost(navController, startDestination = if (hasOnboarded) HomeRoute else OnboardingRoute) {
        composable<OnboardingRoute> {
            OnboardingScreen(onDone = {
                navController.navigate(HomeRoute) { popUpTo<OnboardingRoute> { inclusive = true } }
            })
        }
        composable<HomeRoute> { HomeScreen() }
    }
}
```

Read `hasOnboarded` from `settings.settings.map { it.onboardingComplete }` in a root ViewModel with an initial `null`, and keep the splash on screen while it is `null`.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*OnboardingViewModelTest*"
./gradlew :app:connectedDebugAndroidTest --tests "*OnboardingScreenTest*"
adb shell pm clear com.example.app      # reset DataStore to see onboarding again
```

ViewModel test:

```kotlin
@Test fun finishingMarksCompleteOnce() = runTest {
    val settings = FakeSettingsRepository()
    val vm = OnboardingViewModel(settings)
    var done = 0
    repeat(2) { vm.finish { done++ } }
    advanceUntilIdle()
    assertTrue(settings.current.onboardingComplete)
    assertEquals(1, done)
}
```

Compose test:

```kotlin
@Test fun lastPageShowsGetStarted() {
    compose.setContent {
        OnboardingContent(OnboardingUiState(page = 2), onboardingPages, onPageChanged = {}, onNext = {}, onSkip = {})
    }
    compose.onNodeWithText("Get started").assertIsDisplayed()
    compose.onNodeWithText("Skip").assertDoesNotExist()
}
```

## Pitfalls

- Deciding the start destination before DataStore has emitted shows onboarding to returning users for a frame; model the unknown state as `null`.
- Syncing pager and ViewModel in both directions without the `if` guard loops the `LaunchedEffect`.
- Requesting permissions inside onboarding yields high denial rates and Play review questions; prime, then ask in context.
- `HorizontalPager` without `key` recomposes all pages on data changes; with large images that is visible jank.
- Popping onboarding with `popUpTo(inclusive = true)` matters; otherwise back returns to it.
- Text at 200% font scale must still fit; wrap page content in `verticalScroll` if the copy is long.

## Sources

- https://developer.android.com/develop/ui/compose/layouts/pager
- https://developer.android.com/guide/navigation/design/type-safety
- https://developer.android.com/topic/libraries/architecture/datastore
- https://developer.android.com/develop/ui/compose/accessibility
- https://developer.android.com/training/permissions/requesting
