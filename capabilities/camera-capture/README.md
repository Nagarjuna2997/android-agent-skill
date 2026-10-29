# Camera capture

Camera preview and photo capture in Compose with CameraX 1.6.2: the `camera-compose` `CameraXViewfinder`, `Preview` and `ImageCapture` use cases bound through a `LifecycleCameraController`-free `ProcessCameraProvider` path, runtime `CAMERA` permission, saving to `MediaStore`, flash and lens switching, and an instrumented test.

## When to use

- The app needs to take a photo or show a live preview in its own UI: document capture, profile photo, scanning.
- If a system camera app photo is enough, use `ActivityResultContracts.TakePicture()` with a `FileProvider` URI and skip CameraX and the permission entirely.
- For picking existing photos use [photo-picker](../photo-picker/README.md), which needs no permission.

## Dependencies

```toml
[versions]
camerax = "1.6.2"

[libraries]
camera-core = { group = "androidx.camera", name = "camera-core", version.ref = "camerax" }
camera-camera2 = { group = "androidx.camera", name = "camera-camera2", version.ref = "camerax" }
camera-lifecycle = { group = "androidx.camera", name = "camera-lifecycle", version.ref = "camerax" }
camera-compose = { group = "androidx.camera", name = "camera-compose", version.ref = "camerax" }
```

```kotlin
dependencies {
    implementation(libs.camera.core)
    implementation(libs.camera.camera2)
    implementation(libs.camera.lifecycle)
    implementation(libs.camera.compose)
}
```

`camera-compose` provides `CameraXViewfinder`, the Compose-native preview surface; `camera-view`'s `PreviewView` is only needed with `AndroidView`.

## Manifest and permissions

```xml
<uses-feature android:name="android.hardware.camera.any" android:required="false" />
<uses-permission android:name="android.permission.CAMERA" />
```

`required="false"` keeps the app installable on devices without a camera; check `PackageManager.hasSystemFeature` before showing the capture screen. No storage permission is needed to write to `MediaStore` on API 29+; on 24 to 28 writing to the shared Pictures collection needs `WRITE_EXTERNAL_STORAGE` with `android:maxSdkVersion="28"`.

## Implementation

### Camera controller

```kotlin
package com.example.app.camera

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import androidx.camera.compose.CameraXViewfinder
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.SurfaceRequest
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

data class CameraUiState(
    val surfaceRequest: SurfaceRequest? = null,
    val lens: Int = CameraSelector.LENS_FACING_BACK,
    val flash: Int = ImageCapture.FLASH_MODE_OFF,
    val capturing: Boolean = false,
    val lastPhoto: Uri? = null,
    val error: String? = null,
)

@HiltViewModel
class CameraViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
) : ViewModel() {
    private val _state = MutableStateFlow(CameraUiState())
    val state: StateFlow<CameraUiState> = _state.asStateFlow()

    private val preview = Preview.Builder().build().apply {
        setSurfaceProvider { request -> _state.update { it.copy(surfaceRequest = request) } }
    }
    private val imageCapture = ImageCapture.Builder()
        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
        .build()

    private var provider: ProcessCameraProvider? = null

    fun bind(owner: LifecycleOwner) {
        viewModelScope.launch {
            val p = provider ?: ProcessCameraProvider.awaitInstance(context).also { provider = it }
            rebind(p, owner)
        }
    }

    private fun rebind(p: ProcessCameraProvider, owner: LifecycleOwner) {
        val selector = CameraSelector.Builder().requireLensFacing(_state.value.lens).build()
        p.unbindAll()
        try {
            p.bindToLifecycle(owner, selector, preview, imageCapture)
            imageCapture.flashMode = _state.value.flash
        } catch (e: IllegalArgumentException) {
            _state.update { it.copy(error = "Camera not available") }
        }
    }

    fun toggleLens(owner: LifecycleOwner) {
        _state.update {
            it.copy(lens = if (it.lens == CameraSelector.LENS_FACING_BACK) CameraSelector.LENS_FACING_FRONT else CameraSelector.LENS_FACING_BACK)
        }
        provider?.let { rebind(it, owner) }
    }

    fun cycleFlash() {
        val next = when (_state.value.flash) {
            ImageCapture.FLASH_MODE_OFF -> ImageCapture.FLASH_MODE_AUTO
            ImageCapture.FLASH_MODE_AUTO -> ImageCapture.FLASH_MODE_ON
            else -> ImageCapture.FLASH_MODE_OFF
        }
        imageCapture.flashMode = next
        _state.update { it.copy(flash = next) }
    }

    fun capture() {
        if (_state.value.capturing) return
        _state.update { it.copy(capturing = true, error = null) }
        viewModelScope.launch {
            try {
                val uri = takePhoto()
                _state.update { it.copy(capturing = false, lastPhoto = uri) }
            } catch (e: ImageCaptureException) {
                _state.update { it.copy(capturing = false, error = "Capture failed (${e.imageCaptureError})") }
            }
        }
    }

    private suspend fun takePhoto(): Uri? = suspendCancellableCoroutine { cont ->
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "IMG_${System.currentTimeMillis()}.jpg")
            put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/ExampleApp")   // API 29+
        }
        val output = ImageCapture.OutputFileOptions.Builder(
            context.contentResolver, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values,
        ).build()
        imageCapture.takePicture(output, ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(result: ImageCapture.OutputFileResults) { cont.resume(result.savedUri) }
            override fun onError(exception: ImageCaptureException) { cont.resumeWithException(exception) }
        })
    }

    override fun onCleared() { provider?.unbindAll() }
}
```

`RELATIVE_PATH` is ignored below API 29; wrap it in an SDK check if minSdk is below 29 and fall back to app-private storage with `File` output.

### Compose screen

```kotlin
package com.example.app.camera

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.compose.CameraXViewfinder
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun CameraScreen(viewModel: CameraViewModel = hiltViewModel()) {
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED)
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }

    if (!granted) {
        Button(onClick = { launcher.launch(Manifest.permission.CAMERA) }) { Text("Allow camera to take photos") }
        return
    }

    val owner = LocalLifecycleOwner.current
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(owner) { viewModel.bind(owner) }

    Box(Modifier.fillMaxSize()) {
        state.surfaceRequest?.let { CameraXViewfinder(surfaceRequest = it, modifier = Modifier.fillMaxSize()) }

        FilledIconButton(
            onClick = viewModel::capture,
            enabled = !state.capturing,
            modifier = Modifier.align(Alignment.BottomCenter).padding(24.dp).size(72.dp)
                .semantics { contentDescription = "Take photo" },
        ) { Icon(Icons.Default.Camera, contentDescription = null) }

        FilledIconButton(
            onClick = { viewModel.toggleLens(owner) },
            modifier = Modifier.align(Alignment.BottomEnd).padding(24.dp).size(48.dp)
                .semantics { contentDescription = "Switch camera" },
        ) { Icon(Icons.Default.Cameraswitch, contentDescription = null) }

        state.error?.let { Text(it, Modifier.align(Alignment.TopCenter).padding(16.dp)) }
    }
}
```

Material icons come from `androidx.compose.material:material-icons-extended` or your own vectors. The preview is bound to the composable's lifecycle owner, so it stops when the screen is backgrounded.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell pm grant com.example.app android.permission.CAMERA
adb shell content query --uri content://media/external/images/media --projection _display_name | tail -3   # new IMG_*.jpg
./gradlew :app:connectedDebugAndroidTest --tests "*CameraCaptureTest*"
```

Instrumented test (the emulator has a virtual scene camera):

```kotlin
@RunWith(AndroidJUnit4::class)
class CameraCaptureTest {
    @get:Rule val permission = GrantPermissionRule.grant(Manifest.permission.CAMERA)
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun capturingProducesAnImage() {
        compose.setContent { CameraScreen() }
        compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("Take photo").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Take photo").performClick()
        compose.waitUntil(10_000) {
            compose.activity.contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, null, null, null, null)
                ?.use { it.count > 0 } == true
        }
    }
}
```

Mark the result as "built and tested on emulator" rather than on real hardware unless you ran it there; camera behavior differs per device.

## Pitfalls

- Binding use cases before the lifecycle is `STARTED` is fine; binding from a `ViewModel` with an `Activity` lifecycle owner leaks the Activity on rotation. Use the composable's lifecycle owner and `unbindAll()` in `onCleared`.
- Requesting the permission on screen entry without a rationale is a common Play review complaint; request from a button with text that says why.
- `ImageCapture` default resolution is the largest available; for thumbnails set a `ResolutionSelector` to avoid slow captures and large files.
- Front-camera images are mirrored in the preview but not in the saved file; tell users or flip in post-processing.
- `takePicture` with a `File` in `getExternalFilesDir` is private to the app; for the user's gallery use `MediaStore` as above.
- Without `CAPTURE_MODE_MINIMIZE_LATENCY` some devices take over a second per shot in `MAXIMIZE_QUALITY`.
- CameraX extensions (night, HDR) are device-gated; check `ExtensionsManager.isExtensionAvailable` before offering a toggle.

## Sources

- https://developer.android.com/media/camera/camerax
- https://developer.android.com/media/camera/camerax/take-photo
- https://developer.android.com/media/camera/camerax/compose
- https://developer.android.com/jetpack/androidx/releases/camera
- https://developer.android.com/training/data-storage/shared/media
