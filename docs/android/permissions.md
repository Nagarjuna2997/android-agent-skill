# Permissions

Runtime permissions in a Compose app: when to ask, how to ask with `rememberLauncherForActivityResult`, what to do when the user says no once or for good, the special permissions that need a settings screen, and the APIs that let you avoid asking at all.

## Rules

1. Least privilege. Every permission in the manifest is a question at review time and a reason for a user to uninstall. If a system picker, intent or Jetpack API gets the data without a permission, use it.
2. Ask in context. Request camera when the user taps "Take photo", not on launch.
3. Explain before the second ask. If `shouldShowRequestPermissionRationale` is true, the user denied once; show a short rationale, then request again.
4. Handle "denied forever". After the second denial (or "Don't ask again" on older versions) the system dialog never appears again. Offer a path to app settings and a degraded experience that still works.
5. Check at use, not only at request. Permissions can be revoked while the app is in the background and auto-reset after months of non-use.
6. Model permission state in the ViewModel's `UiState` so the screen can render the right thing after rotation.

## Manifest

Declare install-time and runtime permissions, with `maxSdkVersion` where a permission is obsolete on newer levels:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
<uses-feature android:name="android.hardware.camera.any" android:required="false" />
```

`uses-feature ... required="false"` keeps the app installable on devices without that hardware; check `PackageManager.hasSystemFeature` at runtime.

## Single permission in Compose

```kotlin
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

@Composable
fun CameraCaptureButton(
    onPermissionResult: (granted: Boolean, canAskAgain: Boolean) -> Unit,
    onCapture: () -> Unit,
) {
    val context = LocalContext.current
    val activity = LocalActivity.current

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val canAskAgain = !granted && activity != null &&
            ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.CAMERA)
        onPermissionResult(granted, canAskAgain)
        if (granted) onCapture()
    }

    Button(onClick = {
        val alreadyGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (alreadyGranted) onCapture() else launcher.launch(Manifest.permission.CAMERA)
    }) {
        Text(stringResource(R.string.take_photo))
    }
}
```

`LocalActivity` is in `androidx.activity:activity-compose`. After a denial with `canAskAgain == false` the only remaining path is settings:

```kotlin
fun Context.openAppSettings() {
    startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}
```

## Modeling it in state

```kotlin
enum class PermissionStatus { Unknown, Granted, Denied, DeniedPermanently }

data class ScanUiState(
    val cameraPermission: PermissionStatus = PermissionStatus.Unknown,
    val showRationale: Boolean = false,
)

sealed interface ScanEvent {
    data object CameraTapped : ScanEvent
    data class PermissionResult(val granted: Boolean, val canAskAgain: Boolean) : ScanEvent
    data object RationaleAccepted : ScanEvent
}
```

The ViewModel moves between states; the screen reads `showRationale` to show a dialog, `DeniedPermanently` to show the settings prompt. Re-check the permission in a `LifecycleEventObserver` on `ON_RESUME` (through `DisposableEffect`) so returning from settings updates the UI.

## Rationale flow

Rationale is a small, honest dialog: what the permission enables and what happens without it. Then one button that launches the request.

```kotlin
if (uiState.showRationale) {
    AlertDialog(
        onDismissRequest = { onEvent(ScanEvent.RationaleDismissed) },
        title = { Text(stringResource(R.string.camera_rationale_title)) },
        text = { Text(stringResource(R.string.camera_rationale_body)) },
        confirmButton = {
            TextButton(onClick = { onEvent(ScanEvent.RationaleAccepted); launcher.launch(Manifest.permission.CAMERA) }) {
                Text(stringResource(R.string.continue_label))
            }
        },
        dismissButton = {
            TextButton(onClick = { onEvent(ScanEvent.RationaleDismissed) }) { Text(stringResource(R.string.not_now)) }
        },
    )
}
```

Do not show a custom pre-permission screen before every request; that doubles the taps for users who would have said yes. Show it only when `shouldShowRequestPermissionRationale` is true.

## Multiple permissions

```kotlin
val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
    val fine = results[Manifest.permission.ACCESS_FINE_LOCATION] == true
    val coarse = results[Manifest.permission.ACCESS_COARSE_LOCATION] == true
    onLocationResult(precise = fine, approximate = coarse)
}
launcher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
```

Request both location permissions together so the user can choose "approximate". Design for approximate location working.

## Avoiding permissions

| Need | Use instead of a permission |
|---|---|
| Pick photos or videos | Photo picker (`PickVisualMedia`), no storage permission on any level |
| Pick a document | `OpenDocument` / `CreateDocument` through the Storage Access Framework |
| Save a file the user can find | `MediaStore` inserts for media; `Downloads` through SAF; app-specific storage needs nothing |
| Take a photo for your app | `TakePicture` contract with a `FileProvider` URI, no `CAMERA` permission; `CAMERA` only for an in-app viewfinder |
| Share | `Intent.ACTION_SEND` and `ShareCompat` |
| Make a call, send SMS | `ACTION_DIAL`, `ACTION_SENDTO` (user confirms in the system app) |
| Read contacts for one pick | `PickContact` contract |
| Schedule work | WorkManager, no `SCHEDULE_EXACT_ALARM` |
| Bluetooth scan for a specific device | Companion Device Manager pairing flow |

Photo picker:

```kotlin
val pickMedia = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
    if (uri != null) onPicked(uri)
}
Button(onClick = { pickMedia.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
    Text(stringResource(R.string.choose_photo))
}
```

Returned URIs are readable while the process lives. Persist access with `contentResolver.takePersistableUriPermission` only if the picker granted it (use `ACTION_OPEN_DOCUMENT` for persistent grants), otherwise copy the bytes into app storage.

## Notifications (API 33+)

`POST_NOTIFICATIONS` is a runtime permission. Create channels first, then ask when the user turns on a feature that notifies. Use `NotificationManagerCompat.areNotificationsEnabled()` to detect the state on every level. Media playback and foreground services still show their notification without the permission; alerts do not.

## Special permissions

These are not granted through the dialog; the app sends the user to a system settings screen and re-checks on resume.

| Permission | Check | Settings intent |
|---|---|---|
| `SYSTEM_ALERT_WINDOW` | `Settings.canDrawOverlays(context)` | `Settings.ACTION_MANAGE_OVERLAY_PERMISSION` |
| `MANAGE_EXTERNAL_STORAGE` | `Environment.isExternalStorageManager()` | `Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION`; Play restricts to file-manager apps |
| `SCHEDULE_EXACT_ALARM` | `AlarmManager.canScheduleExactAlarms()` | `Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM` |
| `REQUEST_INSTALL_PACKAGES` | `PackageManager.canRequestPackageInstalls()` | `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` |
| Battery optimization exemption | `PowerManager.isIgnoringBatteryOptimizations` | `Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (Play policy restricts use) |
| Accessibility service, notification listener, usage access | respective `Settings.ACTION_*` | Play requires a declaration form |

Most apps need none of these. Each one is a Play policy review item.

## Background location

`ACCESS_BACKGROUND_LOCATION` is requested separately, only after foreground location is granted, and only on API 30+ through the settings screen ("Allow all the time"). The app must have a visible feature that requires it and a Play declaration. Steps:

1. Request `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` in context.
2. Later, when the user enables the background feature, explain why, then `launcher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)`; the system opens settings.
3. Re-check on resume. Accept that many users will stay on "while using the app" and make that work.

For location while the app is visible but the screen is off, a foreground service with `foregroundServiceType="location"` and `FOREGROUND_SERVICE_LOCATION` is the right tool, not background location.

## Testing permissions

Unit-test the ViewModel's state transitions with fake results. On a device:

```sh
adb shell pm grant com.example.app android.permission.CAMERA
adb shell pm revoke com.example.app android.permission.CAMERA
adb shell appops set com.example.app SYSTEM_ALERT_WINDOW allow
```

In instrumentation tests, `GrantPermissionRule.grant(Manifest.permission.CAMERA)` pre-grants. Test the denied path by not granting and asserting the rationale or settings prompt is shown; `UiAutomator` can tap the system dialog if you must test the dialog itself.

## Verify

```sh
./gradlew :app:lintDebug           # MissingPermission, no unused permissions
android-agent permissions audit --project /absolute/path
adb shell dumpsys package com.example.app | grep -A 20 "runtime permissions"
```

Then: revoke each runtime permission, open the feature, confirm the app neither crashes nor dead-ends; grant from settings, return, confirm the UI updates without restart.

## Sources

- https://developer.android.com/training/permissions/requesting
- https://developer.android.com/training/permissions/evaluating
- https://developer.android.com/guide/topics/permissions/overview
- https://developer.android.com/training/data-storage/shared/photopicker
- https://developer.android.com/develop/ui/views/notifications/notification-permission
- https://developer.android.com/develop/sensors-and-location/location/permissions
- https://developer.android.com/training/basics/intents/result
