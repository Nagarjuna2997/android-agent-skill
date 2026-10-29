# On-device AI

Gemini Nano through the ML Kit GenAI APIs (summarization, proofreading, rewriting, image description) running on AICore, with a runtime availability check, model download handling, streaming output into a `StateFlow`, and a cloud fallback through Firebase AI Logic when the device cannot run the model. Everything here is device-gated; the recipe tells the agent what to check at runtime and what to say to the user.

## When to use

- Short text tasks on the user's own content where privacy and offline use matter: summarize a note, fix spelling, rewrite in a different tone, describe an image for alt text.
- Gemini Nano is only available on a limited set of devices (recent Pixel and selected flagship devices with AICore installed). The app must degrade: hide the feature, run a cloud model, or do nothing. Never assume availability from the API level.
- The ML Kit GenAI APIs are task-specific. The lower-level Prompt API for free-form prompts to Gemini Nano is published as an experimental/alpha API; do not ship it in a production recipe without checking its current status on the ML Kit release notes.

## Dependencies

ML Kit artifacts are versioned independently and not in `data/versions.json`; resolve each from the ML Kit release notes. The Firebase AI Logic artifact comes from the Firebase BoM 34.18.0.

```toml
[versions]
mlkit-genai-summarization = "<version>"     # https://developers.google.com/ml-kit/release-notes
mlkit-genai-proofreading = "<version>"
mlkit-genai-rewriting = "<version>"
mlkit-genai-image-description = "<version>"
firebase-bom = "34.18.0"

[libraries]
mlkit-genai-summarization = { group = "com.google.mlkit", name = "genai-summarization", version.ref = "mlkit-genai-summarization" }
mlkit-genai-proofreading = { group = "com.google.mlkit", name = "genai-proofreading", version.ref = "mlkit-genai-proofreading" }
mlkit-genai-rewriting = { group = "com.google.mlkit", name = "genai-rewriting", version.ref = "mlkit-genai-rewriting" }
mlkit-genai-image-description = { group = "com.google.mlkit", name = "genai-image-description", version.ref = "mlkit-genai-image-description" }
firebase-bom = { group = "com.google.firebase", name = "firebase-bom", version.ref = "firebase-bom" }
firebase-ai = { group = "com.google.firebase", name = "firebase-ai" }
kotlinx-coroutines-guava = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-guava", version = "<version>" }
```

```kotlin
dependencies {
    implementation(libs.mlkit.genai.summarization)
    implementation(libs.mlkit.genai.proofreading)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.ai)                  // cloud fallback (Gemini Developer API via Firebase)
    implementation(libs.kotlinx.coroutines.guava)
}
```

Add only the task artifacts the feature uses. Confirm the exact class and method names against the current ML Kit GenAI documentation before writing code; the surface below follows the documented shape (a client built from options, a feature-status check, a download step, and streaming inference) but the API is newer than most of this catalog and has changed between releases.

## Manifest and permissions

No permissions for on-device inference. The cloud fallback needs `INTERNET` and a Firebase project with the Gemini Developer API enabled; keep the API key out of the app by using Firebase AI Logic (it goes through Firebase, with App Check recommended) rather than calling the Gemini API directly with a key.

## Implementation

### Availability and summarization

```kotlin
package com.example.app.ai

import android.content.Context
import com.google.mlkit.genai.common.DownloadCallback
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.summarization.Summarization
import com.google.mlkit.genai.summarization.SummarizationRequest
import com.google.mlkit.genai.summarization.Summarizer
import com.google.mlkit.genai.summarization.SummarizerOptions
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.suspendCancellableCoroutine
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

enum class OnDeviceModelState { UNAVAILABLE, DOWNLOADABLE, DOWNLOADING, READY }

interface SummarizerRepository {
    suspend fun state(): OnDeviceModelState
    suspend fun download(onProgress: (Long) -> Unit): Boolean
    fun summarize(text: String): Flow<String>    // emits accumulated text as it streams
    fun close()
}

@Singleton
class MlKitSummarizerRepository @Inject constructor(@ApplicationContext context: Context) : SummarizerRepository {

    private val summarizer: Summarizer = Summarization.getClient(
        SummarizerOptions.builder(context)
            .setInputType(SummarizerOptions.InputType.ARTICLE)
            .setOutputType(SummarizerOptions.OutputType.THREE_BULLETS)
            .setLanguage(SummarizerOptions.Language.ENGLISH)
            .build()
    )

    override suspend fun state(): OnDeviceModelState = when (summarizer.checkFeatureStatus().await()) {
        FeatureStatus.AVAILABLE -> OnDeviceModelState.READY
        FeatureStatus.DOWNLOADABLE -> OnDeviceModelState.DOWNLOADABLE
        FeatureStatus.DOWNLOADING -> OnDeviceModelState.DOWNLOADING
        else -> OnDeviceModelState.UNAVAILABLE
    }

    override suspend fun download(onProgress: (Long) -> Unit): Boolean = suspendCancellableCoroutine { cont ->
        summarizer.downloadFeature(object : DownloadCallback {
            override fun onDownloadStarted(bytesToDownload: Long) = Unit
            override fun onDownloadProgress(totalBytesDownloaded: Long) = onProgress(totalBytesDownloaded)
            override fun onDownloadCompleted() { if (cont.isActive) cont.resume(true) }
            override fun onDownloadFailed(e: GenAiException) { if (cont.isActive) cont.resume(false) }
        })
    }

    override fun summarize(text: String): Flow<String> = callbackFlow {
        val builder = StringBuilder()
        val future = summarizer.runInference(SummarizationRequest.builder(text).build()) { chunk ->
            builder.append(chunk)
            trySend(builder.toString())
        }
        try {
            future.await()
            close()
        } catch (e: CancellationException) {
            future.cancel(true); throw e
        } catch (e: GenAiException) {
            close(e)
        }
        awaitClose { future.cancel(true) }
    }

    override fun close() = summarizer.close()
}
```

The streaming callback delivers partial text; the returned future completes when generation ends. Input length is capped by the model (a few thousand tokens); truncate long inputs and tell the user.

### Cloud fallback

```kotlin
class FirebaseAiSummarizerRepository @Inject constructor() : SummarizerRepository {
    private val model = Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel("gemini-2.5-flash")

    override suspend fun state() = OnDeviceModelState.READY
    override suspend fun download(onProgress: (Long) -> Unit) = true
    override fun summarize(text: String): Flow<String> = flow {
        val acc = StringBuilder()
        model.generateContentStream("Summarize in three bullet points:\n\n$text").collect { chunk ->
            chunk.text?.let { acc.append(it); emit(acc.toString()) }
        }
    }
    override fun close() = Unit
}
```

`com.google.firebase.ai.*`. Model names change; take the current one from the Firebase AI Logic documentation. Ask for consent before sending user content to the cloud, and say in UI which path is in use.

### Selecting a path

```kotlin
@Module @InstallIn(SingletonComponent::class)
object AiModule {
    @Provides @Singleton
    fun summarizer(onDevice: MlKitSummarizerRepository, cloud: FirebaseAiSummarizerRepository, settings: SettingsRepository): SummarizerRepository =
        SummarizerSelector(onDevice, cloud, settings)
}

class SummarizerSelector(
    private val onDevice: SummarizerRepository,
    private val cloud: SummarizerRepository,
    private val settings: SettingsRepository,
) : SummarizerRepository {
    private suspend fun pick(): SummarizerRepository =
        if (onDevice.state() == OnDeviceModelState.READY) onDevice
        else if (settings.settings.first().cloudAiConsent) cloud
        else onDevice   // caller sees UNAVAILABLE/DOWNLOADABLE and shows the right UI
    override suspend fun state() = pick().state()
    override suspend fun download(onProgress: (Long) -> Unit) = onDevice.download(onProgress)
    override fun summarize(text: String) = flow { emitAll(pick().summarize(text)) }
    override fun close() { onDevice.close(); cloud.close() }
}
```

### ViewModel

```kotlin
sealed interface SummaryUiState {
    data object Checking : SummaryUiState
    data object NotSupported : SummaryUiState
    data class NeedsDownload(val downloading: Boolean, val bytes: Long) : SummaryUiState
    data object Ready : SummaryUiState
    data class Streaming(val text: String) : SummaryUiState
    data class Done(val text: String) : SummaryUiState
    data class Error(val message: String) : SummaryUiState
}

@HiltViewModel
class SummaryViewModel @Inject constructor(private val repo: SummarizerRepository) : ViewModel() {
    private val _state = MutableStateFlow<SummaryUiState>(SummaryUiState.Checking)
    val state: StateFlow<SummaryUiState> = _state.asStateFlow()

    init { refreshState() }

    fun refreshState() = viewModelScope.launch {
        _state.value = when (repo.state()) {
            OnDeviceModelState.READY -> SummaryUiState.Ready
            OnDeviceModelState.DOWNLOADABLE -> SummaryUiState.NeedsDownload(false, 0)
            OnDeviceModelState.DOWNLOADING -> SummaryUiState.NeedsDownload(true, 0)
            OnDeviceModelState.UNAVAILABLE -> SummaryUiState.NotSupported
        }
    }

    fun download() = viewModelScope.launch {
        _state.value = SummaryUiState.NeedsDownload(true, 0)
        val ok = repo.download { bytes -> _state.value = SummaryUiState.NeedsDownload(true, bytes) }
        _state.value = if (ok) SummaryUiState.Ready else SummaryUiState.Error("Model download failed")
    }

    fun summarize(text: String) = viewModelScope.launch {
        repo.summarize(text)
            .onEach { _state.value = SummaryUiState.Streaming(it) }
            .catch { _state.value = SummaryUiState.Error("Could not summarize") }
            .onCompletion { cause -> if (cause == null) (_state.value as? SummaryUiState.Streaming)?.let { _state.value = SummaryUiState.Done(it.text) } }
            .collect()
    }

    override fun onCleared() = repo.close()
}
```

`NotSupported` hides the entry point or shows "Not available on this device"; do not show a broken button.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell pm list packages | grep -E "aicore|com.google.android.aicore"   # AICore present on supported devices only
adb logcat -s MLKit AICore
./gradlew :app:testDebugUnitTest --tests "*SummaryViewModelTest*"
```

ViewModel tests use a `FakeSummarizerRepository` that returns a scripted state and a `flowOf("Part", "Part two")`. On-device inference cannot be verified on a standard emulator; report it as "built, unit-tested with fakes, on-device path unverified" unless you ran it on a device where `state()` returned `READY`.

```kotlin
@Test fun unsupportedDeviceHidesFeature() = runTest {
    val vm = SummaryViewModel(FakeSummarizerRepository(state = OnDeviceModelState.UNAVAILABLE))
    advanceUntilIdle()
    assertEquals(SummaryUiState.NotSupported, vm.state.value)
}
```

## Pitfalls

- Checking the API level instead of `checkFeatureStatus()` is wrong; availability depends on the device, AICore version and region.
- The model download is large and happens through AICore; trigger it only from a user action and show progress.
- Inference runs on-device but is not instant; keep it off the main thread (the ML Kit client already does) and show streaming output.
- Each GenAI client should be closed when the owner is cleared; leaking clients holds native memory.
- Sending content to the cloud fallback without consent violates the privacy promise that justifies on-device AI; gate it on a stored setting.
- Do not describe outputs as facts; summaries and rewrites can be wrong. Let users edit before saving.
- The Prompt API (free-form prompts to Gemini Nano) and any "Gemini Nano experimental access" program are not stable APIs; mention them only as experimental if the user asks.

## Sources

- https://developers.google.com/ml-kit/genai
- https://developer.android.com/ai/gemini-nano
- https://developers.google.com/ml-kit/release-notes
- https://firebase.google.com/docs/ai-logic
- https://developer.android.com/ai
