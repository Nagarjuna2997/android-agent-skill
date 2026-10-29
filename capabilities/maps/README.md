# Maps

Google Maps in Compose with the Maps Compose library: the API key injected through the Secrets Gradle plugin instead of source, `GoogleMap` with camera state, markers, clustering, user-location layer gated on the permission, map styling for dark mode and a Compose test with a fake location.

## When to use

- The app shows places, routes or the user's position on a map. Maps SDK for Android requires a Google Cloud project with billing enabled and the Maps SDK for Android API turned on; map loads are billed past the free monthly credit.
- Location acquisition itself is in [location](../location/README.md); this recipe only consumes a `LatLng`.
- For a static image of a map (an address card) the Maps Static API with an image loader is cheaper than a live map.

## Dependencies

Maps SDK, Maps Compose and the Secrets plugin versions are not in `data/versions.json`; resolve them from the release pages.

```toml
[versions]
maps-compose = "<version>"        # https://github.com/googlemaps/android-maps-compose/releases
play-services-maps = "<version>"  # https://developers.google.com/maps/documentation/android-sdk/release-notes
secrets-plugin = "<version>"      # https://github.com/google/secrets-gradle-plugin/releases

[libraries]
maps-compose = { group = "com.google.maps.android", name = "maps-compose", version.ref = "maps-compose" }
maps-compose-utils = { group = "com.google.maps.android", name = "maps-compose-utils", version.ref = "maps-compose" }
play-services-maps = { group = "com.google.android.gms", name = "play-services-maps", version.ref = "play-services-maps" }

[plugins]
secrets = { id = "com.google.android.libraries.mapsplatform.secrets-gradle-plugin", version.ref = "secrets-plugin" }
```

`app/build.gradle.kts`:

```kotlin
plugins { alias(libs.plugins.secrets) }

secrets {
    propertiesFileName = "secrets.properties"          // git-ignored
    defaultPropertiesFileName = "local.defaults.properties"   // committed, holds a placeholder
}

dependencies {
    implementation(libs.maps.compose)
    implementation(libs.maps.compose.utils)             // clustering
    implementation(libs.play.services.maps)
}
```

`secrets.properties`:

```text
MAPS_API_KEY=AIza...
```

`local.defaults.properties`: `MAPS_API_KEY=DEFAULT_API_KEY`. Restrict the key in Google Cloud to the Android app's package name and SHA-1 fingerprints so a leaked key is useless elsewhere.

## Manifest and permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />

<application ...>
    <meta-data android:name="com.google.android.geo.API_KEY" android:value="${MAPS_API_KEY}" />
</application>
```

The `${MAPS_API_KEY}` placeholder is filled by the Secrets plugin at build time. Location permissions are optional and only for the my-location layer.

## Implementation

### Map screen

```kotlin
package com.example.app.ui.map

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.MapStyleOptions
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapProperties
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.Marker
import com.google.maps.android.compose.rememberCameraPositionState
import com.google.maps.android.compose.rememberMarkerState
import com.google.maps.android.compose.clustering.Clustering
import com.example.app.R

@Composable
fun PlacesMapScreen(viewModel: PlacesMapViewModel = hiltViewModel()) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val dark = isSystemInDarkTheme()

    var hasLocation by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED)
    }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        hasLocation = result.values.any { it }
    }

    val camera = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(state.initialCenter, 12f)
    }

    // Fit all places once they load.
    LaunchedEffect(state.places) {
        if (state.places.size > 1) {
            val bounds = LatLngBounds.builder().apply { state.places.forEach { include(it.position) } }.build()
            camera.animate(CameraUpdateFactory.newLatLngBounds(bounds, 96))
        }
    }

    GoogleMap(
        modifier = Modifier.fillMaxSize(),
        cameraPositionState = camera,
        properties = MapProperties(
            isMyLocationEnabled = hasLocation,
            mapStyleOptions = if (dark) MapStyleOptions.loadRawResourceStyle(context, R.raw.map_style_dark) else null,
        ),
        uiSettings = MapUiSettings(myLocationButtonEnabled = hasLocation, zoomControlsEnabled = false),
        onMapLoaded = { viewModel.onMapLoaded() },
        contentDescription = "Map of nearby places",
    ) {
        Clustering(
            items = state.places,
            onClusterItemClick = { viewModel.onPlaceSelected(it.id); true },
        )
        state.selected?.let { place ->
            Marker(state = rememberMarkerState(position = place.position), title = place.title, zIndex = 1f)
        }
    }

    if (!hasLocation && state.askForLocation) {
        LaunchedEffect(Unit) {
            permissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))
        }
    }
}
```

`Clustering` from `maps-compose-utils` takes items implementing `ClusterItem`. Request location only when the user taps a "show my location" affordance (`askForLocation` set by the ViewModel), not on map open. Generate `map_style_dark.json` with the Google styling tool or use Cloud-based map styling with a map id (`GoogleMapOptions().mapId(...)` through `googleMapOptionsFactory`).

### ViewModel

```kotlin
package com.example.app.ui.map

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.maps.model.LatLng
import com.google.maps.android.clustering.ClusterItem
import com.example.app.data.PlaceRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PlaceMarker(val id: String, val title: String, val position: LatLng) : ClusterItem {
    override fun getPosition() = position
    override fun getTitle() = title
    override fun getSnippet(): String? = null
    override fun getZIndex(): Float? = null
}

data class PlacesMapUiState(
    val initialCenter: LatLng = LatLng(0.0, 0.0),
    val places: List<PlaceMarker> = emptyList(),
    val selected: PlaceMarker? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val askForLocation: Boolean = false,
)

@HiltViewModel
class PlacesMapViewModel @Inject constructor(private val repo: PlaceRepository) : ViewModel() {
    private val _uiState = MutableStateFlow(PlacesMapUiState())
    val uiState: StateFlow<PlacesMapUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            repo.places().fold(
                onSuccess = { list ->
                    _uiState.update { s ->
                        s.copy(places = list.map { PlaceMarker(it.id, it.name, LatLng(it.lat, it.lng)) },
                            initialCenter = list.firstOrNull()?.let { LatLng(it.lat, it.lng) } ?: s.initialCenter, loading = false)
                    }
                },
                onFailure = { _uiState.update { it.copy(loading = false, error = "Could not load places") } },
            )
        }
    }

    fun onMapLoaded() = _uiState.update { it.copy(loading = false) }
    fun onPlaceSelected(id: String) = _uiState.update { s -> s.copy(selected = s.places.firstOrNull { it.id == id }) }
    fun onShowMyLocation() = _uiState.update { it.copy(askForLocation = true) }
}
```

## Verify

```sh
./gradlew :app:assembleDebug          # fails if secrets.properties is missing and no default is set
grep -c "AIza" app/build/intermediates/merged_manifest/debug/AndroidManifest.xml   # 1 means the key was injected
adb logcat -s Google-Maps-Android-API  # "Authorization failure" means the key or restriction is wrong
./gradlew :app:connectedDebugAndroidTest --tests "*PlacesMapScreenTest*"
```

Compose test (the map tiles need network and a valid key; test the surrounding state, not tile rendering):

```kotlin
@Test fun mapShowsAndSelectsPlace() {
    val fakeRepo = FakePlaceRepository(listOf(Place("1", "Cafe", 37.42, -122.08)))
    compose.setContent { PlacesMapScreen(PlacesMapViewModel(fakeRepo)) }
    compose.onNodeWithContentDescription("Map of nearby places").assertExists()
}
```

Maps Compose markers are not Compose semantics nodes; drive selection through the ViewModel in unit tests.

## Pitfalls

- Hard-coding the key in the manifest or `strings.xml` ships it in every APK. Use the Secrets plugin and key restrictions.
- An unrestricted key that leaks gets billed to your project. Restrict by package and SHA-1 (debug and release).
- `isMyLocationEnabled = true` without the permission throws `SecurityException`. Gate on the runtime check.
- Mutating `cameraPositionState.position` on every recomposition fights the user's gestures; animate from `LaunchedEffect` keyed on data changes only.
- `Marker` composables for hundreds of points are slow; use `Clustering` or `MarkerComposable` sparingly.
- The map is a `SurfaceView` in a `AndroidView`; overlapping Compose content needs `zIndex` and the map must not be inside a scrollable without `nestedScroll` handling.
- Emulators without Google APIs show a blank grid; use a Play or Google APIs system image.

## Sources

- https://developers.google.com/maps/documentation/android-sdk/maps-compose
- https://developers.google.com/maps/documentation/android-sdk/secrets-gradle-plugin
- https://developers.google.com/maps/documentation/android-sdk/release-notes
- https://github.com/googlemaps/android-maps-compose
- https://developers.google.com/maps/api-security-best-practices
