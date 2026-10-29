# Wear OS companion

A minimal Wear OS companion module with Compose for Wear OS and the Data Layer API: a `:wear` module sharing a data model with the phone app, a `DataClient`-based repository that syncs a small state object, a `WearableListenerService` for background delivery, a `ScalingLazyColumn` screen, and the manifest glue. This capability is marked runtime-unverified: the recipe follows the documented APIs but has not been executed on a watch or Wear emulator by this repository.

## When to use

- The phone app has a small, glanceable slice of state worth putting on the wrist: today's progress, the next event, a quick action.
- Wear OS apps are separate APKs with the same `applicationId`, built from a separate module with the Wear system image as the target. A companion is only worth it when the use case is glanceable; porting phone screens to a watch is not.
- Play requires wear builds to target API 35 or higher (see `data/versions.json`, `policy.newAppsAndUpdates.wear`).

## Dependencies

Wear Compose and Wearable Data Layer versions are not in `data/versions.json`; resolve from the release pages.

`gradle/libs.versions.toml`:

```toml
[versions]
wear-compose = "<version>"            # https://developer.android.com/jetpack/androidx/releases/wear-compose
play-services-wearable = "<version>"  # https://developers.google.com/android/guides/releases
horologist = "<version>"              # optional; https://github.com/google/horologist/releases

[libraries]
wear-compose-material = { group = "androidx.wear.compose", name = "compose-material", version.ref = "wear-compose" }
wear-compose-foundation = { group = "androidx.wear.compose", name = "compose-foundation", version.ref = "wear-compose" }
wear-compose-navigation = { group = "androidx.wear.compose", name = "compose-navigation", version.ref = "wear-compose" }
play-services-wearable = { group = "com.google.android.gms", name = "play-services-wearable", version.ref = "play-services-wearable" }
kotlinx-coroutines-play-services = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-play-services", version = "<version>" }
```

`wear/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.example.app"               // same package family as the phone app
    compileSdk = 37
    defaultConfig {
        applicationId = "com.example.app"       // must match the phone app for Data Layer pairing
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }
    buildFeatures { compose = true }
}

dependencies {
    implementation(project(":shared"))           // the data model shared with :app
    implementation(platform(libs.compose.bom))
    implementation(libs.wear.compose.material)
    implementation(libs.wear.compose.foundation)
    implementation(libs.wear.compose.navigation)
    implementation(libs.play.services.wearable)
    implementation(libs.kotlinx.coroutines.play.services)
}
```

The phone module adds `implementation(libs.play.services.wearable)` and the same `:shared` module.

## Manifest and permissions

`wear/src/main/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-feature android:name="android.hardware.type.watch" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />

    <application
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:theme="@android:style/Theme.DeviceDefault">
        <meta-data android:name="com.google.android.wearable.standalone" android:value="false" />

        <activity android:name=".wear.MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <service android:name=".wear.DataLayerListenerService" android:exported="true">
            <intent-filter>
                <action android:name="com.google.android.gms.wearable.DATA_CHANGED" />
                <data android:scheme="wear" android:host="*" android:pathPrefix="/progress" />
            </intent-filter>
        </service>
    </application>
</manifest>
```

`standalone=false` declares the watch app depends on the phone app. The listener service filter must include the `<data>` element or the service is never started.

## Implementation

### Shared model (`:shared`)

```kotlin
package com.example.app.shared

data class DailyProgress(val steps: Int, val goal: Int, val updatedAtMillis: Long) {
    val fraction: Float get() = if (goal == 0) 0f else (steps.toFloat() / goal).coerceIn(0f, 1f)
}

object DataLayerPaths {
    const val PROGRESS = "/progress"
    const val KEY_STEPS = "steps"
    const val KEY_GOAL = "goal"
    const val KEY_UPDATED = "updated"
}
```

### Phone side: publish

```kotlin
package com.example.app.wear

import android.content.Context
import com.example.app.shared.DailyProgress
import com.example.app.shared.DataLayerPaths
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

class WearProgressPublisher @Inject constructor(@ApplicationContext private val context: Context) {
    private val dataClient = Wearable.getDataClient(context)

    suspend fun publish(progress: DailyProgress) {
        val request = PutDataMapRequest.create(DataLayerPaths.PROGRESS).apply {
            dataMap.putInt(DataLayerPaths.KEY_STEPS, progress.steps)
            dataMap.putInt(DataLayerPaths.KEY_GOAL, progress.goal)
            dataMap.putLong(DataLayerPaths.KEY_UPDATED, progress.updatedAtMillis)
        }.asPutDataRequest().setUrgent()
        dataClient.putDataItem(request).await()
    }
}
```

Data items are synced to every paired node; the same path overwrites. Call `publish` from the repository that updates progress. If Play services is missing, `await()` throws an `ApiException`; catch it and ignore on phones without a watch.

### Watch side: observe

```kotlin
package com.example.app.wear

import android.content.Context
import com.example.app.shared.DailyProgress
import com.example.app.shared.DataLayerPaths
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

class WearProgressRepository(context: Context) {
    private val dataClient = Wearable.getDataClient(context)

    fun progress(): Flow<DailyProgress?> = callbackFlow {
        // Initial value from the local Data Layer cache.
        val items = dataClient.dataItems.await()
        items.firstOrNull { it.uri.path == DataLayerPaths.PROGRESS }?.let { trySend(DataMapItem.fromDataItem(it).toProgress()) }
        items.release()

        val listener = DataClient.OnDataChangedListener { events ->
            events.forEach { event ->
                if (event.type == DataEvent.TYPE_CHANGED && event.dataItem.uri.path == DataLayerPaths.PROGRESS) {
                    trySend(DataMapItem.fromDataItem(event.dataItem).toProgress())
                }
            }
        }
        dataClient.addListener(listener)
        awaitClose { dataClient.removeListener(listener) }
    }
}

private fun DataMapItem.toProgress() = DailyProgress(
    steps = dataMap.getInt(DataLayerPaths.KEY_STEPS),
    goal = dataMap.getInt(DataLayerPaths.KEY_GOAL),
    updatedAtMillis = dataMap.getLong(DataLayerPaths.KEY_UPDATED),
)
```

### Background listener (watch)

```kotlin
class DataLayerListenerService : WearableListenerService() {
    override fun onDataChanged(events: DataEventBuffer) {
        events.forEach { event ->
            if (event.dataItem.uri.path == DataLayerPaths.PROGRESS) {
                // Update a tile or complication here; the Activity reads the Data Layer directly when visible.
            }
        }
    }
}
```

### Watch UI

```kotlin
@Composable
fun ProgressScreen(repository: WearProgressRepository) {
    val progress by repository.progress().collectAsStateWithLifecycle(initialValue = null)
    val listState = rememberScalingLazyListState()
    Scaffold(timeText = { TimeText() }, positionIndicator = { PositionIndicator(listState) }) {
        ScalingLazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item {
                when (val p = progress) {
                    null -> Text("Waiting for phone", textAlign = TextAlign.Center)
                    else -> {
                        CircularProgressIndicator(progress = p.fraction, modifier = Modifier.size(80.dp))
                        Text("${p.steps} / ${p.goal} steps", textAlign = TextAlign.Center)
                    }
                }
            }
            item { Chip(onClick = { /* send a message back with MessageClient */ }, label = { Text("Refresh") }) }
        }
    }
}
```

`Scaffold`, `TimeText`, `ScalingLazyColumn`, `Chip` and `CircularProgressIndicator` come from `androidx.wear.compose.material` and `androidx.wear.compose.foundation`, not the phone Material 3 artifacts.

## Verify

```sh
./gradlew :wear:assembleDebug :app:assembleDebug
# Create a Wear emulator (API 35 Wear image) and a phone emulator, pair them through the Wear OS app or:
adb -s <wear-emulator> forward tcp:5601 tcp:5601
adb -s <wear-emulator> install -r wear/build/outputs/apk/debug/wear-debug.apk
adb -s <phone-emulator> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <wear-emulator> logcat -s WearableService DataLayerListenerService
```

Then trigger `publish` on the phone and confirm the watch screen updates. Unit test the mapping only:

```kotlin
@Test fun fractionClampsToOne() {
    assertEquals(1f, DailyProgress(steps = 12_000, goal = 10_000, updatedAtMillis = 0).fraction)
}
```

Status to report: "source inspected, phone and wear modules compile" after `assembleDebug`, and "runtime unverified" unless the pairing steps above were executed and the watch displayed synced data.

## Pitfalls

- Different `applicationId` or signing keys between phone and watch builds break the Data Layer silently; nothing arrives.
- `WearableListenerService` without the `<data>` filter element is never bound.
- `DataClient` delivers only changes; the first value must be read from `dataItems` as above or the screen stays empty until the phone writes again.
- Phone Material 3 composables render incorrectly on round screens; use Wear Compose Material.
- Data items are limited to 100 KB; send assets (`Asset.createFromBytes`) for images.
- The Wear emulator pairs with a phone emulator only with matching Play services images; use the pairing assistant in Android Studio Device Manager.
- Play requires separate watch screenshots and a Wear-specific review; the companion is a distinct release track.

## Sources

- https://developer.android.com/training/wearables
- https://developer.android.com/training/wearables/data/data-layer
- https://developer.android.com/training/wearables/compose
- https://developer.android.com/jetpack/androidx/releases/wear-compose
- https://developer.android.com/google/play/requirements/target-sdk
