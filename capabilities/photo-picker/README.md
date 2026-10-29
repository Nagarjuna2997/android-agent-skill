# Photo picker

Select images and videos with the Android photo picker through `ActivityResultContracts.PickVisualMedia` and `PickMultipleVisualMedia`: no storage permission, backported to API 19+ through Google Play system updates, persistable access when the file is needed later, and a copy-into-app-storage repository for uploads.

## When to use

- The user chooses one or several photos or videos from their library: avatar, attachments, gallery import.
- Replaces `READ_MEDIA_IMAGES`, `READ_EXTERNAL_STORAGE` and custom gallery grids. Play policy restricts broad media permissions to apps with a core need (gallery apps, backup); the picker is what everyone else should use.
- For capturing a new photo see [camera-capture](../camera-capture/README.md). For arbitrary documents use `OpenDocument` with the Storage Access Framework.

## Dependencies

`activity-compose` ships with the Compose BOM; no additional artifact. If the project pins `androidx.activity` separately, use a version that includes `PickVisualMedia` (1.7.0 and later; the BOM 2026.09.00 is well past that).

```toml
[libraries]
androidx-activity-compose = { group = "androidx.activity", name = "activity-compose" }   # version from the Compose BOM
```

```kotlin
dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.androidx.activity.compose)
}
```

## Manifest and permissions

None for picking. On devices where the system picker is not available (API < 30 without the Play backport), the contract falls back to `ACTION_OPEN_DOCUMENT`, which also needs no permission.

If the app must open the selected file again after process death, take a persistable permission (shown below); if it uploads or copies immediately, do not.

## Implementation

### Launching the picker

```kotlin
package com.example.app.ui.media

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

@Composable
fun PickAvatarButton(onPicked: (Uri) -> Unit) {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) onPicked(uri)        // null means the user cancelled
    }
    Button(onClick = {
        launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }) { Text("Choose photo") }
}

@Composable
fun PickAttachmentsButton(max: Int = 5, onPicked: (List<Uri>) -> Unit) {
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(maxItems = max),
    ) { uris -> if (uris.isNotEmpty()) onPicked(uris) }
    Button(onClick = {
        launcher.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
    }) { Text("Add attachments") }
}
```

`maxItems` must be at least 2 and at most `MediaStore.getPickImagesMaxLimit()` (100 on current platforms). Use `SingleMimeType("image/gif")` to restrict further.

On API 34+ you can also ask for the "ordered selection" mode and default tab via `PickVisualMediaRequest.Builder().setOrderedSelection(true).setDefaultTab(PickVisualMediaRequest.DefaultTab.AlbumsTab)`; both are optional and ignored on older pickers.

### Repository: copy or persist

```kotlin
package com.example.app.data.media

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import javax.inject.Inject

data class PickedMedia(val localFile: File, val displayName: String, val mimeType: String?, val sizeBytes: Long)

interface MediaImportRepository {
    suspend fun import(uri: Uri): Result<PickedMedia>
    fun persistAccess(uri: Uri)
}

class ContentResolverMediaImportRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    @IoDispatcher private val io: CoroutineDispatcher,
) : MediaImportRepository {

    /** Copies into app-private storage so the file survives the picker's temporary grant. */
    override suspend fun import(uri: Uri): Result<PickedMedia> = withContext(io) {
        try {
            val resolver = context.contentResolver
            val mime = resolver.getType(uri)
            var name = "media_${System.currentTimeMillis()}"
            var size = 0L
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.let { name = it }
                    size = c.getLong(1)
                }
            }
            val dir = File(context.filesDir, "imports").apply { mkdirs() }
            val target = File(dir, name.sanitizedFileName())
            resolver.openInputStream(uri)?.use { input -> target.outputStream().use { input.copyTo(it) } }
                ?: return@withContext Result.failure(IOException("Cannot open $uri"))
            Result.success(PickedMedia(target, name, mime, if (size > 0) size else target.length()))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: IOException) {
            Result.failure(e)
        } catch (e: SecurityException) {
            Result.failure(e)   // grant expired; ask the user to pick again
        }
    }

    /** Only when the URI must be reopened after process death; the picker grants read access by default. */
    override fun persistAccess(uri: Uri) {
        try {
            context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: SecurityException) {
            // Not persistable on this provider; import() instead.
        }
    }
}

private fun String.sanitizedFileName() = replace(Regex("[^A-Za-z0-9._-]"), "_").take(100)
```

### ViewModel

```kotlin
sealed interface AvatarUiState {
    data object Empty : AvatarUiState
    data object Importing : AvatarUiState
    data class Ready(val file: File) : AvatarUiState
    data class Error(val message: String) : AvatarUiState
}

@HiltViewModel
class AvatarViewModel @Inject constructor(private val media: MediaImportRepository) : ViewModel() {
    private val _state = MutableStateFlow<AvatarUiState>(AvatarUiState.Empty)
    val state: StateFlow<AvatarUiState> = _state.asStateFlow()

    fun onPicked(uri: Uri) {
        viewModelScope.launch {
            _state.value = AvatarUiState.Importing
            _state.value = media.import(uri).fold(
                onSuccess = { AvatarUiState.Ready(it.localFile) },
                onFailure = { AvatarUiState.Error("Could not read that photo") },
            )
        }
    }
}
```

Display the picked image with Coil's `AsyncImage(model = file)`; see [image-loading](../image-loading/README.md).

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*AvatarViewModelTest*"
# Put a test image on the emulator so the picker has something to show
adb push test.jpg /sdcard/Pictures/test.jpg && adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/test.jpg
```

Instrumented test with a stubbed result (avoids driving the system picker UI):

```kotlin
@Test fun pickedUriReachesViewModel() {
    val expected = Uri.parse("content://media/picker/0/com.android.providers.media.photopicker/media/1")
    Intents.init()
    intending(hasAction(MediaStore.ACTION_PICK_IMAGES))
        .respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(expected)))
    var picked: Uri? = null
    compose.setContent { PickAvatarButton(onPicked = { picked = it }) }
    compose.onNodeWithText("Choose photo").performClick()
    assertEquals(expected, picked)
    Intents.release()
}
```

Needs `androidx.test.espresso:espresso-intents`. On API < 30 the launched action is `ACTION_OPEN_DOCUMENT`; match both if the test runs on older emulators.

## Pitfalls

- The URI the picker returns is valid only while the Activity lives, unless persisted. Copy immediately or call `persistAccess` before storing the URI.
- `takePersistableUriPermission` throws for providers that do not support it (some cloud providers in the fallback document picker); catch and import instead.
- Declaring `READ_MEDIA_IMAGES` alongside the picker triggers Play's media permission review. Do not add it unless the app is a gallery-type app.
- `PickMultipleVisualMedia(maxItems = 1)` throws; use `PickVisualMedia` for single selection.
- Large videos should not be copied on the main thread or held in memory; stream to a file as above and upload from the file.
- Cancelling returns `null` / empty list, not an error; do not show an error toast.
- The picker's returned MIME type can be `null` for some providers; sniff from the file header if the type matters.

## Sources

- https://developer.android.com/training/data-storage/shared/photopicker
- https://developer.android.com/reference/androidx/activity/result/contract/ActivityResultContracts.PickVisualMedia
- https://developer.android.com/training/data-storage/shared/documents-files
- https://support.google.com/googleplay/android-developer/answer/14115180
