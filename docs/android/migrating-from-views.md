# Migrating from Views to Compose

How to move an XML, Fragment and ViewBinding codebase to Compose one screen at a time without a rewrite: the two interop bridges, the order to migrate in, what to do with Fragments, ViewModels and `LiveData`, and how to keep one theme across both worlds while they coexist.

## Strategy

Compose and Views interoperate in both directions, so migration is incremental and shippable at every step.

1. Add Compose to the build (Compose compiler plugin, BOM, `activity-compose`, `lifecycle-runtime-compose`). Build and ship; nothing changed yet.
2. Build every new screen in Compose. Stop writing XML layouts.
3. Migrate shared UI elements (buttons, cards, list rows) into composables and use them inside existing screens through `ComposeView`.
4. Migrate screens leaf-first: simple, self-contained screens before the ones with complex custom Views.
5. Migrate navigation last: Fragments hosting composables, then one `NavHost` in Compose and the Fragment layer removed.
6. Delete the XML, the ViewBinding, the Fragment, and the `LiveData`.

Do not migrate a screen and redesign it at the same time. Match the existing behavior, verify with the existing tests, then improve.

## Build setup

```kotlin
// app/build.gradle.kts
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    buildFeatures {
        compose = true
        viewBinding = true   // keep until the last XML layout is gone
    }
}

dependencies {
    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
```

With Kotlin 2.x the Compose compiler is the `org.jetbrains.kotlin.plugin.compose` plugin at the Kotlin version; there is no `kotlinCompilerExtensionVersion` to set.

If the app uses `AppCompatActivity`, keep it; `setContent` works on any `ComponentActivity` subclass. Material Components (`com.google.android.material`) and Compose Material3 can coexist.

## Compose inside Views: ComposeView

Put a `ComposeView` in an XML layout or create one in code:

```xml
<androidx.compose.ui.platform.ComposeView
    android:id="@+id/noteSummary"
    android:layout_width="match_parent"
    android:layout_height="wrap_content" />
```

```kotlin
class NoteDetailFragment : Fragment() {
    private var _binding: FragmentNoteDetailBinding? = null
    private val binding get() = checkNotNull(_binding)
    private val viewModel: NoteDetailViewModel by viewModels()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentNoteDetailBinding.inflate(inflater, container, false)
        binding.noteSummary.apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent {
                AppTheme {
                    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
                    NoteSummary(uiState.summary, onEdit = viewModel::onEdit)
                }
            }
        }
        return binding.root
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
```

`ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed` is required in Fragments; the default disposes when the view detaches, which happens during Fragment transitions and would lose state. In a `RecyclerView` item use `DisposeOnViewTreeLifecycleDestroyed` as well and call `setContent` in `onBindViewHolder`; Compose handles reuse.

A Fragment that is entirely Compose:

```kotlin
class NotesFragment : Fragment() {
    private val viewModel: NotesViewModel by viewModels()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        ComposeView(requireContext()).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent {
                AppTheme {
                    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
                    NotesScreen(uiState = uiState, onEvent = viewModel::onEvent)
                }
            }
        }
}
```

This is the standard intermediate step: Fragment navigation stays, the screen is Compose, and later the Fragment is replaced by a route.

## Views inside Compose: AndroidView

For a View that has no Compose equivalent yet (a `MapView`, `WebView`, a custom chart, an ad view):

```kotlin
@Composable
fun NoteWebPreview(html: String, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = false
                layoutParams = ViewGroup.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
            }
        },
        update = { webView -> webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null) },
        onRelease = { webView -> webView.destroy() },
    )
}
```

`factory` runs once per composition; `update` runs on every recomposition where its captured state changed, so keep it idempotent. `onRelease` is where a View with resources is torn down.

An existing XML layout inside Compose, with ViewBinding:

```kotlin
AndroidViewBinding(factory = LegacyChartBinding::inflate, modifier = Modifier.fillMaxWidth()) {
    chart.setData(points)
}
```

`AndroidViewBinding` comes from `androidx.compose.ui:ui-viewbinding`. A layout containing a `FragmentContainerView` works through it too, which is how a legacy Fragment can be hosted inside Compose during migration.

Views inside Compose do not participate in Compose scrolling or insets automatically; a `RecyclerView` in a `LazyColumn` will fight for touch events. Prefer migrating the list.

## ViewModels and LiveData

Keep the ViewModel; migrate its outputs.

- `LiveData` to `StateFlow`: replace `MutableLiveData<T>` with `MutableStateFlow<T>` and expose `StateFlow<T>`. Replace `Transformations.map` with `.map { }.stateIn(viewModelScope, WhileSubscribed(5_000), initial)`.
- During the transition, Views can observe a `StateFlow` with `repeatOnLifecycle`, and Compose can consume `LiveData` through `observeAsState()` from `androidx.compose.runtime:runtime-livedata`. Use that bridge only while the ViewModel is still on `LiveData`; do not write new `LiveData`.
- Several `LiveData` fields usually become one `UiState` data class. Do it when the screen migrates.
- `SingleLiveEvent` and `Event` wrappers become state the UI acknowledges (see `docs/compose/state-and-side-effects.md`).
- Obtain the ViewModel in Compose with `hiltViewModel()` (Hilt) or `viewModel()`; when a Fragment still owns the screen, pass the Fragment's ViewModel into `setContent` as above so both sides share one instance.

## Fragments to composables

A Fragment maps to a route-level composable:

| Fragment concept | Compose equivalent |
|---|---|
| `onCreateView` | the composable body |
| `onViewCreated` observers | `collectAsStateWithLifecycle()` |
| `arguments` / Safe Args | typed route object (`@Serializable data class NoteDetail(val id: Long)`) |
| `setFragmentResult` | shared ViewModel or `SavedStateHandle` on the previous back stack entry |
| `onDestroyView` cleanup | `DisposableEffect` |
| `childFragmentManager` | nested composables or nested `NavHost` |
| `DialogFragment` | `AlertDialog` / `ModalBottomSheet` / `dialog` route |
| `onBackPressedDispatcher` | `BackHandler` |
| `MenuProvider` | `TopAppBar` actions |

Navigation migration order: while Fragments remain, keep the XML nav graph and host Compose screens in Fragments. Once every screen on a flow is Compose, replace that flow's Fragments with a Compose `NavHost` (see `patterns/navigation.md`). Deep links move from `<deepLink>` in the graph to `navDeepLink<Route>` on the composable destination.

## Theme bridging

Two themes exist during migration: the XML theme (`Theme.Material3.DayNight` or `Theme.MaterialComponents`) and the Compose `MaterialTheme`. Keep them from drifting:

- Define colors once. Simplest: keep the XML color resources and read them in Compose with `colorResource(R.color.primary)` when building the Compose `ColorScheme`; or the reverse, generate `colors.xml` from the Compose tokens.
- `com.google.android.material:compose-theme-adapter-3` (`Mdc3Theme`) reads the Activity's Material 3 XML theme and builds a matching `MaterialTheme` automatically; use it until all screens are Compose, then replace with a hand-written `AppTheme`. Resolve the version from its release page.
- Dynamic color: set `DynamicColors.applyToActivitiesIfAvailable(this)` in the `Application` for Views and `dynamicLightColorScheme(context)` in Compose; both read the same system palette.
- Typography: map `textAppearance` styles to `Typography` text styles by name; fonts load from the same `res/font`.
- Dark mode: `isSystemInDarkTheme()` in Compose follows the same `uiMode` as `-night` resources.
- Window insets: with `enableEdgeToEdge()`, XML screens need `ViewCompat.setOnApplyWindowInsetsListener` where they previously relied on `fitsSystemWindows`; Compose screens follow `docs/android/edge-to-edge-and-insets.md`.

## Tests during migration

- Existing Espresso tests keep passing against `ComposeView`-hosted screens only where they match on View ids; Compose nodes are not Views. Rewrite those tests with `createAndroidComposeRule` and semantics matchers as each screen migrates.
- Both frameworks can run in one test: Espresso for the View parts, Compose rule for the Compose parts, in the same `ActivityScenario`.
- Snapshot the screen before and after with screenshot tests to catch unintentional visual changes.

## Common mistakes

- Forgetting `setViewCompositionStrategy` in a Fragment: state resets on every transition.
- Creating a `ComposeView` per `RecyclerView` bind without the lifecycle strategy: leaks and slow scrolling.
- Running `AndroidView` `update` with non-idempotent calls (`addView`, `adapter = ...`) so each recomposition stacks another one.
- Wrapping a whole legacy screen in `AndroidViewBinding` and calling it migrated.
- Keeping `LiveData` for new ViewModel fields "to be consistent". Consistency with the destination matters, not the origin.
- Two different primary colors because the Compose theme was hand-written while the XML theme stayed.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:lintDebug
./gradlew :app:connectedDebugAndroidTest
grep -rln "LiveData" app/src/main --include=*.kt         # should shrink to zero over the migration
find app/src/main/res/layout -name "*.xml" | wc -l        # should shrink to zero
```

For each migrated screen: open it, rotate, navigate away and back, background and foreground, and compare with the screenshot of the View version.

## Sources

- https://developer.android.com/develop/ui/compose/migrate
- https://developer.android.com/develop/ui/compose/migrate/strategy
- https://developer.android.com/develop/ui/compose/migrate/interoperability-apis
- https://developer.android.com/develop/ui/compose/migrate/interoperability-apis/compose-in-views
- https://developer.android.com/develop/ui/compose/migrate/interoperability-apis/views-in-compose
- https://developer.android.com/develop/ui/compose/migrate/other-considerations
- https://developer.android.com/develop/ui/compose/designsystems/views-to-compose
