# Oboe low-latency audio

Low-latency audio output and input with Oboe pulled in through Prefab: a native engine that opens an `AudioStream` with a data callback, a Kotlin facade that feeds device audio properties into Oboe, a `StateFlow`-backed repository, a Compose screen, and the latency-tuning loop. This capability is marked runtime-unverified: the recipe follows the Oboe and NDK documentation but has not been executed on a device by this repository. The `hello-oboe` and `audio-echo` directories in `android/ndk-samples` are now removed stubs that point to the Oboe repository's own samples, so this recipe was written from the Oboe documentation and the surviving NDK build conventions (see `references/ndk-samples.md`).

## When to use

- Synthesizers, drum machines, tuners, real-time effects, voice chat, rhythm games: anything where the user hears or reacts to audio within tens of milliseconds.
- For playing files and streams use Media3 (`capabilities/media-playback/README.md`); for ordinary sound effects `SoundPool` is enough. Oboe is for a callback you fill with samples.
- Oboe wraps AAudio (API 27+) and falls back to OpenSL ES on older devices; with the repository's minSdk 26 the OpenSL path only serves API 26. If minSdk is 27 or higher, AAudio is used everywhere.

## Dependencies

Oboe is not in `data/versions.json`; resolve the version from the release page. The native toolchain setup (NDK, CMake, `externalNativeBuild`, ABI filters, 16 KB pages) is in `capabilities/ndk-native-code/README.md` and is assumed here.

```toml
[versions]
oboe = "<version>"   # https://github.com/google/oboe/releases

[libraries]
oboe = { group = "com.google.oboe", name = "oboe", version.ref = "oboe" }
```

```kotlin
// app/build.gradle.kts
android {
    buildFeatures { prefab = true }
    defaultConfig {
        externalNativeBuild { cmake { arguments += "-DANDROID_STL=c++_shared" } }   // Oboe's AAR links against c++_shared
    }
}
dependencies { implementation(libs.oboe) }
```

```cmake
# app/src/main/cpp/CMakeLists.txt (in addition to the ndk-native-code setup)
find_package(oboe REQUIRED CONFIG)
add_app_library(audioengine SHARED audio_engine.cpp audio_jni.cpp)
target_link_libraries(audioengine PRIVATE oboe::oboe android log)
```

## Manifest and permissions

```xml
<!-- Output needs nothing. Input (echo, voice chat, tuner) needs RECORD_AUDIO, requested at runtime with a rationale. -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-feature android:name="android.hardware.audio.low_latency" android:required="false" />
<uses-feature android:name="android.hardware.audio.pro" android:required="false" />
<uses-feature android:name="android.hardware.microphone" android:required="false" />
```

`low_latency` and `pro` are feature flags you can read with `PackageManager.hasSystemFeature` to show the user what their device can do; marking them `required="false"` keeps the app installable everywhere. Runtime permission flow: `docs/android/permissions.md`.

## Implementation

### Native engine

```cpp
// app/src/main/cpp/audio_engine.h
#pragma once
#include <oboe/Oboe.h>
#include <atomic>
#include <memory>
#include <mutex>

class AudioEngine : public oboe::AudioStreamDataCallback, public oboe::AudioStreamErrorCallback {
public:
    oboe::Result start();
    void stop();
    void setFrequency(float hz) { frequency_.store(hz, std::memory_order_relaxed); }
    void setGain(float gain) { gain_.store(gain, std::memory_order_relaxed); }
    int32_t xRunCount() const;
    double latencyMillis() const;

    oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream, void* audioData, int32_t numFrames) override;
    void onErrorAfterClose(oboe::AudioStream* stream, oboe::Result error) override;

private:
    oboe::Result openStream();
    std::mutex lock_;                          // guards stream_ open/close only; never taken in the callback
    std::shared_ptr<oboe::AudioStream> stream_;
    std::atomic<float> frequency_{440.0f};
    std::atomic<float> gain_{0.2f};
    float phase_ = 0.0f;
};
```

```cpp
// app/src/main/cpp/audio_engine.cpp
#include "audio_engine.h"
#include <android/log.h>
#include <cmath>

namespace {
constexpr float kTwoPi = 6.283185307f;
}

oboe::Result AudioEngine::openStream() {
    oboe::AudioStreamBuilder builder;
    builder.setDirection(oboe::Direction::Output)
        ->setPerformanceMode(oboe::PerformanceMode::LowLatency)   // fast mixer path when the device offers it
        ->setSharingMode(oboe::SharingMode::Exclusive)            // lowest latency; falls back to Shared automatically
        ->setFormat(oboe::AudioFormat::Float)
        ->setChannelCount(oboe::ChannelCount::Stereo)
        ->setSampleRate(oboe::kUnspecified)                       // let Oboe pick the device native rate (set from Kotlin below)
        ->setSampleRateConversionQuality(oboe::SampleRateConversionQuality::Medium)
        ->setUsage(oboe::Usage::Game)
        ->setDataCallback(this)
        ->setErrorCallback(this);
    oboe::Result result = builder.openStream(stream_);
    if (result != oboe::Result::OK) return result;
    // Two bursts is the usual starting point: one burst risks glitches, more adds latency.
    stream_->setBufferSizeInFrames(stream_->getFramesPerBurst() * 2);
    return oboe::Result::OK;
}

oboe::Result AudioEngine::start() {
    std::lock_guard<std::mutex> guard(lock_);
    if (stream_ == nullptr) {
        oboe::Result result = openStream();
        if (result != oboe::Result::OK) {
            __android_log_print(ANDROID_LOG_ERROR, "AudioEngine", "open failed: %s", oboe::convertToText(result));
            return result;
        }
    }
    return stream_->requestStart();
}

void AudioEngine::stop() {
    std::lock_guard<std::mutex> guard(lock_);
    if (stream_ != nullptr) { stream_->stop(); stream_->close(); stream_.reset(); }
}

// Real-time thread: no allocation, no locks, no logging, no JNI, no blocking calls.
oboe::DataCallbackResult AudioEngine::onAudioReady(oboe::AudioStream* stream, void* audioData, int32_t numFrames) {
    auto* out = static_cast<float*>(audioData);
    const int32_t channels = stream->getChannelCount();
    const float increment = kTwoPi * frequency_.load(std::memory_order_relaxed) / static_cast<float>(stream->getSampleRate());
    const float gain = gain_.load(std::memory_order_relaxed);
    for (int32_t frame = 0; frame < numFrames; ++frame) {
        const float sample = std::sin(phase_) * gain;
        phase_ += increment;
        if (phase_ >= kTwoPi) phase_ -= kTwoPi;
        for (int32_t c = 0; c < channels; ++c) out[frame * channels + c] = sample;
    }
    return oboe::DataCallbackResult::Continue;
}

// The stream was disconnected (headphones unplugged, route change). Reopen on a non-callback thread.
void AudioEngine::onErrorAfterClose(oboe::AudioStream*, oboe::Result error) {
    if (error == oboe::Result::ErrorDisconnected) {
        std::lock_guard<std::mutex> guard(lock_);
        stream_.reset();
        if (openStream() == oboe::Result::OK) stream_->requestStart();
    }
}

int32_t AudioEngine::xRunCount() const { return stream_ ? stream_->getXRunCount().value() : 0; }

double AudioEngine::latencyMillis() const {
    if (!stream_) return 0.0;
    auto latency = stream_->calculateLatencyMillis();
    return latency ? latency.value() : 0.0;
}
```

### JNI bridge

```cpp
// app/src/main/cpp/audio_jni.cpp
#include <jni.h>
#include <memory>
#include "audio_engine.h"

namespace {
std::unique_ptr<AudioEngine> gEngine;   // one engine per process; created on first use from the Kotlin side

void SetDefaults(JNIEnv*, jclass, jint sampleRate, jint framesPerBurst) {
    // Technique from the Oboe documentation: pass AudioManager properties so Oboe's OpenSL path can match the device.
    oboe::DefaultStreamValues::SampleRate = sampleRate;
    oboe::DefaultStreamValues::FramesPerBurst = framesPerBurst;
}
jboolean Start(JNIEnv*, jclass) {
    if (!gEngine) gEngine = std::make_unique<AudioEngine>();
    return gEngine->start() == oboe::Result::OK ? JNI_TRUE : JNI_FALSE;
}
void Stop(JNIEnv*, jclass) { if (gEngine) gEngine->stop(); }
void SetFrequency(JNIEnv*, jclass, jfloat hz) { if (gEngine) gEngine->setFrequency(hz); }
jint XRuns(JNIEnv*, jclass) { return gEngine ? gEngine->xRunCount() : 0; }
jdouble Latency(JNIEnv*, jclass) { return gEngine ? gEngine->latencyMillis() : 0.0; }

const JNINativeMethod kMethods[] = {
    {"setDefaults", "(II)V", reinterpret_cast<void*>(SetDefaults)},
    {"start", "()Z", reinterpret_cast<void*>(Start)},
    {"stop", "()V", reinterpret_cast<void*>(Stop)},
    {"setFrequency", "(F)V", reinterpret_cast<void*>(SetFrequency)},
    {"xRunCount", "()I", reinterpret_cast<void*>(XRuns)},
    {"latencyMillis", "()D", reinterpret_cast<void*>(Latency)},
};
}  // namespace

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void*) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass cls = env->FindClass("com/example/app/audio/OboeBridge");
    if (cls == nullptr || env->RegisterNatives(cls, kMethods, sizeof(kMethods) / sizeof(kMethods[0])) != JNI_OK) return JNI_ERR;
    return JNI_VERSION_1_6;
}
```

### Kotlin facade, repository and ViewModel

```kotlin
package com.example.app.audio

import android.content.Context
import android.media.AudioManager
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

object OboeBridge {
    init { System.loadLibrary("audioengine") }
    @JvmStatic external fun setDefaults(sampleRate: Int, framesPerBurst: Int)
    @JvmStatic external fun start(): Boolean
    @JvmStatic external fun stop()
    @JvmStatic external fun setFrequency(hz: Float)
    @JvmStatic external fun xRunCount(): Int
    @JvmStatic external fun latencyMillis(): Double
}

data class ToneState(val playing: Boolean = false, val frequencyHz: Float = 440f, val xRuns: Int = 0, val latencyMs: Double = 0.0, val error: String? = null)

interface ToneRepository {
    val state: StateFlow<ToneState>
    suspend fun start()
    suspend fun stop()
    suspend fun setFrequency(hz: Float)
    suspend fun refreshStats()
}

@Singleton
class OboeToneRepository @Inject constructor(
    @ApplicationContext context: Context,
    @DefaultDispatcher private val dispatcher: CoroutineDispatcher,
) : ToneRepository {
    private val _state = MutableStateFlow(ToneState())
    override val state: StateFlow<ToneState> = _state

    init {
        val audio = context.getSystemService(AudioManager::class.java)
        val rate = audio.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull() ?: 48_000
        val burst = audio.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toIntOrNull() ?: 192
        OboeBridge.setDefaults(rate, burst)
    }

    override suspend fun start() = withContext(dispatcher) {
        val ok = OboeBridge.start()
        _state.update { it.copy(playing = ok, error = if (ok) null else "Could not open audio stream") }
    }
    override suspend fun stop() = withContext(dispatcher) { OboeBridge.stop(); _state.update { it.copy(playing = false) } }
    override suspend fun setFrequency(hz: Float) = withContext(dispatcher) { OboeBridge.setFrequency(hz); _state.update { it.copy(frequencyHz = hz) } }
    override suspend fun refreshStats() = withContext(dispatcher) {
        _state.update { it.copy(xRuns = OboeBridge.xRunCount(), latencyMs = OboeBridge.latencyMillis()) }
    }
}
```

```kotlin
@HiltViewModel
class ToneViewModel @Inject constructor(private val tones: ToneRepository) : ViewModel() {
    val state: StateFlow<ToneState> = tones.state
    init { viewModelScope.launch { while (true) { delay(1_000); if (state.value.playing) tones.refreshStats() } } }
    fun toggle() = viewModelScope.launch { if (state.value.playing) tones.stop() else tones.start() }
    fun setFrequency(hz: Float) = viewModelScope.launch { tones.setFrequency(hz) }
    override fun onCleared() { viewModelScope.launch { tones.stop() } }
}

@Composable
fun ToneScreen(viewModel: ToneViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Button(onClick = viewModel::toggle, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(if (state.playing) "Stop" else "Play ${state.frequencyHz.toInt()} Hz")
        }
        Slider(value = state.frequencyHz, onValueChange = viewModel::setFrequency, valueRange = 110f..1760f,
            modifier = Modifier.semantics { contentDescription = "Frequency" })
        Text("Latency ${"%.1f".format(state.latencyMs)} ms, underruns ${state.xRuns}")
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}
```

### Latency tuning

1. Start with `setBufferSizeInFrames(framesPerBurst * 2)`. Poll `getXRunCount()`; if it climbs while the app is idle in the foreground, increase to three bursts. If it stays at zero for minutes, try one burst.
2. Keep `LowLatency` + `Exclusive`; check `stream->getPerformanceMode()` and `getSharingMode()` after opening, because the device may have downgraded them.
3. Do not resample: open with the device rate (`setSampleRate(kUnspecified)` with `DefaultStreamValues` set) and generate audio at `stream->getSampleRate()`.
4. The callback must be allocation-free, lock-free and under the burst duration (about 4 ms at 192 frames / 48 kHz). Pass parameters through `std::atomic`, not mutexes.
5. For input, open the output stream first, then the input with `setDirection(Input)` and `setInputPreset(oboe::InputPreset::VoiceRecognition)`; read in the output callback with `inputStream->read(..., 0)` (non-blocking) so one callback drives both.
6. Stop the stream in `onStop` of the hosting screen and restart in `onStart`; an open low-latency stream drains battery and blocks other apps' exclusive streams.

## Verify

```sh
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell dumpsys media.aaudio | head -40          # open streams with performance mode, sharing mode, burst size
adb logcat -s AudioEngine AAudio                    # open errors and route changes
```

Instrumented smoke test (runs only on a device or emulator with audio output; the emulator usually reports Shared mode and higher latency):

```kotlin
@Test fun streamOpensAndStarts() {
    assertTrue(OboeBridge.start())
    Thread.sleep(500)
    assertTrue(OboeBridge.latencyMillis() >= 0.0)
    OboeBridge.stop()
}
```

Report "source inspected and compiled for <ABIs>" after `assembleDebug`, and "runtime unverified" unless the stream was opened on hardware and the latency and underrun counts were read back.

## Pitfalls

- Doing anything blocking in `onAudioReady` (logging, JNI calls, `malloc`, mutexes) produces glitches that only show on slower devices.
- Returning `DataCallbackResult::Stop` on a transient condition: the stream stops and will not restart on its own.
- Ignoring `onErrorAfterClose`: unplugging headphones closes the stream; without reopening, playback goes silent.
- Keeping one `AudioEngine` per screen: streams are a scarce resource; one per process, owned by a singleton repository.
- Opening the input stream without `RECORD_AUDIO` returns `ErrorInvalidState`, not an exception; surface it in `UiState`.
- Releasing in `onCleared` without `stop()` leaks the AAudio stream until process death.
- Emulator numbers mean nothing for latency; only hardware results count.

## Sources

- https://developer.android.com/games/sdk/oboe
- https://github.com/google/oboe/blob/main/docs/FullGuide.md
- https://developer.android.com/ndk/guides/audio/aaudio/aaudio
- https://developer.android.com/ndk/guides/audio/audio-latency
- https://developer.android.com/build/native-dependencies
- https://github.com/google/oboe/releases
