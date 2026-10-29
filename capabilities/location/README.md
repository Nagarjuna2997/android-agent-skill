# Location

Device location with `FusedLocationProviderClient`: a repository exposing a last-known read and a `Flow` of updates, the incremental coarse-then-fine permission flow in Compose with rationale, background-location policy and the separate `ACCESS_BACKGROUND_LOCATION` request, a foreground-service note for tracking, and a test with a fake repository plus emulator location injection.

## When to use

- Showing "near me" results, centering a map, tagging a photo, or tracking a run.
- Ask for the least precision that works: coarse for weather and nearby stores, fine for navigation. Background location needs a Play policy declaration and a prominent in-app disclosure; most apps do not need it.
- Pair with [maps](../maps/README.md) to render the position.

## Dependencies

Play Services Location is versioned independently and not in `data/versions.json`; resolve from the Play services release notes.

```toml
[versions]
play-services-location = "<version>"   # https://developers.google.com/android/guides/releases
kotlinx-coroutines-play-services = "<version>"   # https://github.com/Kotlin/kotlinx.coroutines/releases

[libraries]
play-services-location = { group = "com.google.android.gms", name = "play-services-location", version.ref = "play-services-location" }
kotlinx-coroutines-play-services = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-play-services", version.ref = "kotlinx-coroutines-play-services" }
```

```kotlin
dependencies {
    implementation(libs.play.services.location)
    implementation(libs.kotlinx.coroutines.play.services)
}
```

## Manifest and permissions

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<!-- Only if the feature genuinely needs location while the app is not visible -->
<!-- <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" /> -->
<!-- For continuous tracking while in use (fitness, navigation): -->
<!-- <uses-permission android:name="android.permission.FOREGROUND_SERVICE" /> -->
<!-- <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" /> -->
```

Rules the agent must follow:

- Request `COARSE` and `FINE` together; on API 31+ the user can choose "approximate", and the app must work with it.
- `ACCESS_BACKGROUND_LOCATION` can only be requested after foreground location is granted, in a separate request, and it opens Settings on API 30+. Play requires a declaration form and a video for apps that use it.
- Tracking while the screen is off but the user is actively using the feature (a run) is a foreground service with type `location`, not background location.

## Implementation

### Repository

```kotlin
package com.example.app.data.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Looper
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

data class GeoPoint(val lat: Double, val lng: Double, val accuracyMeters: Float?, val timestampMillis: Long)

enum class LocationAccess { NONE, COARSE, FINE }

interface LocationRepository {
    fun access(): LocationAccess
    suspend fun current(): GeoPoint?                       // fresh fix, bounded time
    fun updates(intervalMillis: Long): Flow<GeoPoint>      // continuous while collected
}

@Singleton
class FusedLocationRepository @Inject constructor(
    @ApplicationContext private val context: Context,
) : LocationRepository {

    private val client: FusedLocationProviderClient = LocationServices.getFusedLocationProviderClient(context)

    override fun access(): LocationAccess = when {
        granted(Manifest.permission.ACCESS_FINE_LOCATION) -> LocationAccess.FINE
        granted(Manifest.permission.ACCESS_COARSE_LOCATION) -> LocationAccess.COARSE
        else -> LocationAccess.NONE
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")   // guarded by access() check
    override suspend fun current(): GeoPoint? {
        val access = access()
        if (access == LocationAccess.NONE) return null
        val priority = if (access == LocationAccess.FINE) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY
        val cts = CancellationTokenSource()
        return try {
            client.getCurrentLocation(priority, cts.token).await()?.toGeoPoint()
        } catch (e: kotlinx.coroutines.CancellationException) {
            cts.cancel(); throw e
        } catch (e: SecurityException) {
            null
        }
    }

    @SuppressLint("MissingPermission")
    override fun updates(intervalMillis: Long): Flow<GeoPoint> = callbackFlow {
        val access = access()
        if (access == LocationAccess.NONE) { close(SecurityException("No location permission")); return@callbackFlow }
        val priority = if (access == LocationAccess.FINE) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY
        val request = LocationRequest.Builder(priority, intervalMillis)
            .setMinUpdateIntervalMillis(intervalMillis / 2)
            .setWaitForAccurateLocation(false)
            .build()
        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { trySend(it.toGeoPoint()) }
            }
        }
        client.requestLocationUpdates(request, callback, Looper.getMainLooper())
        awaitClose { client.removeLocationUpdates(callback) }
    }
}

private fun android.location.Location.toGeoPoint() =
    GeoPoint(latitude, longitude, if (hasAccuracy()) accuracy else null, time)
```

Updates stop when the `Flow` collector cancels, which with `collectAsStateWithLifecycle` or `WhileSubscribed` means when the screen leaves the foreground. That is the correct default; anything that should continue is a foreground service.

### Permission flow in Compose

```kotlin
package com.example.app.ui.location

import android.Manifest
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.app.ActivityCompat

@Composable
fun LocationPermissionRequest(onGranted: () -> Unit, onDeniedPermanently: () -> Unit) {
    val activity = LocalActivity.current ?: return
    var showRationale by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        when {
            result.values.any { it } -> onGranted()
            ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.ACCESS_COARSE_LOCATION) -> showRationale = true
            else -> onDeniedPermanently()     // offer a Settings deep link
        }
    }
    val permissions = arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)

    if (showRationale) {
        Text("Your location is used to show stores near you. It is not stored.")
    }
    Button(onClick = { launcher.launch(permissions) }) { Text("Find stores near me") }
}
```

Request from the feature's button, with the rationale text visible, and accept an approximate-only grant.

### ViewModel

```kotlin
sealed interface NearbyUiState {
    data object NeedsPermission : NearbyUiState
    data object Locating : NearbyUiState
    data class Content(val here: GeoPoint, val approximate: Boolean, val results: List<Store>) : NearbyUiState
    data class Error(val message: String) : NearbyUiState
}

@HiltViewModel
class NearbyViewModel @Inject constructor(
    private val location: LocationRepository,
    private val stores: StoreRepository,
) : ViewModel() {
    private val _state = MutableStateFlow<NearbyUiState>(
        if (location.access() == LocationAccess.NONE) NearbyUiState.NeedsPermission else NearbyUiState.Locating
    )
    val state: StateFlow<NearbyUiState> = _state.asStateFlow()

    fun onPermissionGranted() { _state.value = NearbyUiState.Locating; locate() }

    fun locate() {
        viewModelScope.launch {
            val here = location.current() ?: run { _state.value = NearbyUiState.Error("Could not get your location"); return@launch }
            val results = stores.near(here.lat, here.lng)
            _state.value = NearbyUiState.Content(here, approximate = location.access() == LocationAccess.COARSE, results)
        }
    }
}
```

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*NearbyViewModelTest*"
adb shell pm grant com.example.app android.permission.ACCESS_FINE_LOCATION
adb emu geo fix -122.084 37.422          # emulator: set a position (lng lat)
adb shell cmd location providers         # see which providers are enabled
```

ViewModel test:

```kotlin
@Test fun locatesAndLoadsStores() = runTest {
    val vm = NearbyViewModel(
        location = FakeLocationRepository(access = LocationAccess.COARSE, point = GeoPoint(37.42, -122.08, 500f, 0)),
        stores = FakeStoreRepository(listOf(Store("s1", "Shop"))),
    )
    vm.onPermissionGranted()
    advanceUntilIdle()
    val content = vm.state.value as NearbyUiState.Content
    assertTrue(content.approximate)
    assertEquals(1, content.results.size)
}
```

Mark the device path as "verified on emulator with injected location" unless you tested on hardware.

## Pitfalls

- Requesting `FINE` alone on API 31+ is treated as requesting both, but the UI should still handle an approximate grant; reading `access()` after the result tells you which.
- `getLastLocation` returns `null` on fresh emulators and after reboot; use `getCurrentLocation` for a real fix.
- A `LocationCallback` registered without removal keeps GPS on and drains the battery; the `callbackFlow` above removes it on cancellation.
- Requesting background location together with foreground permissions is rejected by the system on API 30+ and by Play review.
- `PRIORITY_HIGH_ACCURACY` with a short interval on a list screen is wasteful; most screens only need `current()` once.
- Location services can be disabled system-wide; check `LocationManagerCompat.isLocationEnabled` and prompt with `SettingsClient.checkLocationSettings` for the resolution dialog.
- Do not store precise locations server-side without telling the user in the privacy policy and the Data safety form.

## Sources

- https://developer.android.com/develop/sensors-and-location/location/retrieve-current
- https://developer.android.com/develop/sensors-and-location/location/request-updates
- https://developer.android.com/develop/sensors-and-location/location/permissions
- https://developer.android.com/develop/sensors-and-location/location/background
- https://developers.google.com/android/guides/releases
