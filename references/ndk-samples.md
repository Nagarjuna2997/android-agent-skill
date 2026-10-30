# Reference study: android/ndk-samples

What the official NDK sample repository teaches about native code on Android, which parts are current, which are legacy, and where each technique now lives in this repository as an original re-implementation.

## What it is

`android/ndk-samples` is a single Gradle project of small apps that each demonstrate one NDK API or build feature: JNI bridging, callbacks into Kotlin, exceptions across the JNI boundary, OpenGL ES, Vulkan, `NativeActivity`, camera, codec, MIDI, sensors, sanitizers, native unit tests, order files and vectorization. Its own README says the samples "are generally not a good starting point for a production quality app"; they aim to show one API each and make sacrifices for brevity. Read them for build plumbing and API usage, not for app structure.

Studied at commit `abb0d8e` (2026-09-25).

## Toolchain it is on right now

The repository is on its own toolchain, deliberately separate from the Jetpack world. Versions come from `gradle/libs.versions.toml`, `gradle/wrapper/gradle-wrapper.properties` and the convention plugins in `build-logic/`:

| Component | ndk-samples | This repository (`data/versions.json`) | Relation |
|---|---|---|---|
| AGP | 8.13.0 | 9.4.0 | lags |
| Gradle wrapper | 8.13 | 9.6.0 (AGP-documented) | lags |
| Kotlin | 1.9.0 (build-logic on 1.7.21) | 2.4.20 | lags badly |
| compileSdk / targetSdk | 35 / 35 | 37 / 36 | lags |
| minSdk | 21 (hello-vulkan 30, native-activity 24, hwasan variant 34) | product decision, templates 26 | n/a |
| Java | 1.8 (`JavaVersion.VERSION_1_8`) | 17 | lags |
| NDK | r29 (`29.0.14206865`) | not pinned; resolve from the NDK release page | leads, current |
| CMake | 4.1.0 (must be installed manually through the SDK Manager; see the README's issue link) | not pinned | leads |
| GameActivity (`androidx.games:games-activity`) | 3.0.5 | not pinned | n/a |
| googletest / junit-gtest | `com.android.ndk.thirdparty:googletest` 1.11.0-beta-1, `androidx.test.ext:junit-gtest` 1.0.0-alpha02 | not pinned | pre-release |
| Oboe | `com.google.oboe:oboe` 1.9.0 is in the catalog but no sample consumes it (hello-oboe was removed) | not pinned | n/a |

The convention plugins in `build-logic/` are where SDK, NDK and CMake versions are set because the AGP DSL cannot read version catalog entries for `ndkVersion` or `compileSdk`. They also set `-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON`, the ABI list, and `keepDebugSymbols += "**/*.so"` on debug builds so `ndk-stack` has symbols.

Conclusion: the NDK, CMake and page-size handling are current; the Gradle, Kotlin, Java and UI side is several major versions behind this repository and must not be copied.

## Which samples are current and which are legacy

The repository marks its own state in each sample's README and in `settings.gradle`.

Current (built in CI, worth learning from):

- `base` – shared static library published through Prefab (`prefabPublishing`), used by every other sample. Shows how a `:nativelib`-style module exposes headers.
- `hello-jni`, `hello-jniCallback` – the JNI bridge and calling back into Kotlin. `hello-jni` uses `RegisterNatives` in `JNI_OnLoad` plus a version script.
- `exceptions` – catching C++ exceptions and rethrowing as `RuntimeException`.
- `unit-test` – googletest on device through `junit-gtest`, with the test library kept out of the release APK.
- `sanitizers` – one build type per sanitizer (`hwasan`, `asan`, `ubsan`).
- `hello-vulkan` – Vulkan triangle on `GameActivity`, with validation layers and pre-rotation notes.
- `gles3jni`, `hello-gl2` – OpenGL ES 3 and 2 rendered from JNI inside a `GLSurfaceView`.
- `camera`, `native-codec`, `native-midi`, `sensor-graph`, `bitmap-plasma`, `endless-tunnel`, `teapots`, `orderfile`, `vectorization` – one NDK API each. `vectorization` explicitly says not to reuse its matrix code.

Legacy or warned against (still in the tree):

- `native-activity` – its README opens with a warning that most apps should not use this model; `NativeActivity` and `GameActivity` translate the Activity lifecycle into a desktop-style `main()` loop that apps end up undoing. Kept only to show the core event and draw loop.
- `native-audio` – OpenSL ES, deprecated since Android 11. Use Oboe.
- `teapots/classic-teapot` – `NativeActivity` based.

Removed (directory holds a stub README only):

- `audio-echo` and `hello-oboe` – removed; the Oboe repository has its own samples.
- `native-media` – OpenMAX AL, no longer recommended; see `native-codec`.
- `nn-samples` – NNAPI deprecated; use LiteRT.
- `prefab` – folded into `base` and the consumers (`buildFeatures { prefab = true }`).
- `san-angeles` – redundant.

## Techniques worth adopting

Each is re-expressed here in this repository's placeholder package and current toolchain. Attributions point at the sample that taught it.

### 1. Pin the NDK and CMake in Gradle, not in the IDE

```kotlin
// app/build.gradle.kts
android {
    ndkVersion = "<version>"            // https://developer.android.com/ndk/downloads
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "<version>"       // the CMake listed in the SDK Manager; the samples pin 4.1.0
        }
    }
}
```

The samples do this in a convention plugin; a single-module app does it inline. Now taught in `capabilities/ndk-native-code/README.md`.

### 2. `RegisterNatives` in `JNI_OnLoad` instead of name-based lookup

The README explains why: name-based `Java_pkg_Class_method` matching is shorter for one function, but `RegisterNatives` gives compile-time checking of the table, lets every function be `static` and hidden, and makes a mismatch fail at load time with a clear error instead of an `UnsatisfiedLinkError` at first call.

```cpp
// Technique from android/ndk-samples hello-jni (Apache-2.0): register natives once at load.
#include <jni.h>
#include <string>

namespace {
jstring Greet(JNIEnv* env, jclass, jstring name) {
    const char* chars = env->GetStringUTFChars(name, nullptr);
    if (chars == nullptr) return nullptr;            // OOM already thrown
    std::string out = std::string("Hello, ") + chars;
    env->ReleaseStringUTFChars(name, chars);
    return env->NewStringUTF(out.c_str());
}
const JNINativeMethod kMethods[] = {
    {"greet", "(Ljava/lang/String;)Ljava/lang/String;", reinterpret_cast<void*>(Greet)},
};
}  // namespace

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void*) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass clazz = env->FindClass("com/example/app/nativebridge/NativeBridge");
    if (clazz == nullptr) return JNI_ERR;
    if (env->RegisterNatives(clazz, kMethods, sizeof(kMethods) / sizeof(kMethods[0])) != JNI_OK) return JNI_ERR;
    return JNI_VERSION_1_6;
}
```

Now taught in `capabilities/ndk-native-code/README.md` and `templates/native-module/`.

### 3. Version scripts to export only `JNI_OnLoad`

Every sample library links with `-Wl,--version-script,lib<name>.map.txt` and `-Wl,--no-undefined-version`. The map exports `JNI_OnLoad` and hides everything else, which shrinks the `.so`, removes relocations and keeps internal symbols out of attackers' view.

```text
LIBNATIVELIB {
  global:
    JNI_OnLoad;
  local:
    *;
};
```

Now taught in `capabilities/ndk-native-code/README.md`, `docs/android/native-code.md` and `templates/native-module/src/main/cpp/`.

### 4. One CMake helper for warnings and the version script

`cmake/AppLibrary.cmake` wraps `add_library` to add `-Wall -Wextra -Werror` and the version script. The idea (a project-wide function so every target gets the same flags) carries over; the implementation here is written fresh in the template's `CMakeLists.txt`.

### 5. 16 KB page-size support

`-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON` is passed to every CMake build from the convention plugin. On NDK r28 and newer this is the default; the flag keeps older NDKs honest. Taught with the verification commands in `capabilities/ndk-native-code/README.md` and `docs/android/native-code.md`.

### 6. Keep debug symbols in debug builds for `ndk-stack`

`packaging { jniLibs { keepDebugSymbols += "**/*.so" } }` on the debug build type, with the comment that Studio does not pass logcat through `ndk-stack` automatically. Taught in `docs/android/native-code.md`.

### 7. Prefab for native dependencies

`base` publishes headers with `prefabPublishing = true` and `prefab { create("base") { headers = "src/main/cpp/include" } }`; consumers set `buildFeatures { prefab = true }` and `find_package(base CONFIG REQUIRED)` then link `base::base`. The same mechanism pulls `com.android.ndk.thirdparty:googletest`, `curl`, `openssl` and `com.google.oboe:oboe`. Taught in `capabilities/ndk-native-code/README.md` and `capabilities/oboe-low-latency-audio/README.md`.

### 8. Sanitizers as build types

One `buildType` per sanitizer, each `initWith(debug)`, passing `-DSANITIZE=<name>` to CMake; `hwasan` restricted to `arm64-v8a` with `minSdk = 34` set through `androidComponents.beforeVariants`, and `useLegacyPackaging = true` so the `wrap.sh` script is extracted. CMake copies the runtime library and wrapper from the NDK into the variant's `jniLibs` and `resources`. Taught, simplified to HWASan plus UBSan, in `capabilities/ndk-native-code/README.md`.

### 9. Native unit tests with googletest and junit-gtest

Business logic in an `OBJECT` library shared by the app `.so` and a `libapp_tests.so`; `testOnly += ["**/libapp_tests.so"]` keeps it out of the shipped APK; an empty Kotlin class annotated `@RunWith(GtestRunner::class) @TargetLibrary(libraryName = "app_tests")` runs it as an instrumentation test. Taught in `capabilities/ndk-native-code/README.md`.

### 10. Exceptions never cross JNI

Catch `std::exception` and `...` in every JNI entry point and throw a `RuntimeException` through `env->ThrowNew`. Taught in `capabilities/ndk-native-code/README.md` and the security section of `docs/android/native-code.md`.

### 11. GameActivity for render-loop apps

`hello-vulkan` links `game-activity::game-activity_static` with `$<LINK_LIBRARY:WHOLE_ARCHIVE,...>` so `GameActivity_onCreate` is kept, enables `buildFeatures { shaders = true }` so `glslc` compiles `.vert`/`.frag` assets, and subclasses `GameActivity` in Kotlin to hide system bars. Taught in `capabilities/vulkan-and-gles-rendering/README.md`.

### 12. `GLSurfaceView` driving a JNI renderer

`gles3jni` keeps the EGL context in `GLSurfaceView` and calls three static natives (`init`, `resize`, `step`) from the renderer thread. Taught in `capabilities/vulkan-and-gles-rendering/README.md`.

## Techniques not to copy, and why

- Groovy `build.gradle`, `viewBinding`, `AppCompatActivity` with XML layouts, Java 1.8 `compileOptions`, Kotlin 1.9.0: all predate this repository's baseline (Kotlin 2.4.20, Compose, JDK 17). Use the Gradle Kotlin DSL and Compose from `templates/compose-app`.
- `riscv64` in `abiFilters`: the convention plugin's own comment says Play blocks uploads containing riscv64 libraries. Ship `arm64-v8a` (plus `armeabi-v7a`, `x86_64` as needed).
- `native-activity` and `native_app_glue` as an app model: the sample's own warning. Use an `Activity`/`ComponentActivity` host with JNI, or `GameActivity` only for a full-screen render loop.
- `native-audio` (OpenSL ES): deprecated. Use Oboe.
- `hello-vulkan`'s `onBackPressed` override calling `System.exit(0)`: a sample shortcut marked with a TODO; use `OnBackPressedCallback` and let the activity finish normally.
- `minSdk 21`: below the AndroidX default of 24 and below what this repository's templates use.
- The `file(GLOB ...)` search for sanitizer runtime libraries inside the NDK install: it works for the sample but depends on the NDK's internal layout. For HWASan on API 34+ no runtime copy is needed; prefer that path.
- Pre-release `junit-gtest` and `googletest` artifacts: use them for on-device native tests but resolve the current version from the release page and report that they are alpha/beta.
- `-DANDROID_STL=c++_static` in apps with more than one native library: the samples switch to `c++_shared` when they need it (sanitizers); a project with several `.so` files must use `c++_shared` consistently.

## Technique to repository file map

| Technique | Taught in |
|---|---|
| `externalNativeBuild`, `ndkVersion`, CMake pin, ABI filters | `capabilities/ndk-native-code/README.md`, `templates/native-module/build.gradle.kts` |
| `RegisterNatives` in `JNI_OnLoad`, `@JvmStatic external fun`, `System.loadLibrary` | `capabilities/ndk-native-code/README.md`, `templates/native-module/` |
| Version script and symbol hiding | `capabilities/ndk-native-code/README.md`, `docs/android/native-code.md`, `templates/native-module/src/main/cpp/` |
| 16 KB page-size flags and checks | `capabilities/ndk-native-code/README.md`, `docs/android/native-code.md` |
| `ndk-stack`, `keepDebugSymbols`, symbol upload | `docs/android/native-code.md` |
| Prefab publish and consume | `capabilities/ndk-native-code/README.md`, `capabilities/oboe-low-latency-audio/README.md` |
| HWASan, ASan, UBSan build types | `capabilities/ndk-native-code/README.md` |
| googletest + junit-gtest | `capabilities/ndk-native-code/README.md` |
| Exceptions across JNI, input validation | `capabilities/ndk-native-code/README.md`, `docs/android/native-code.md` |
| GameActivity vs NativeActivity vs Activity, Vulkan, GLES | `capabilities/vulkan-and-gles-rendering/README.md` |
| Low-latency audio | `capabilities/oboe-low-latency-audio/README.md` |

## Attribution

Sample: `android/ndk-samples`, https://github.com/android/ndk-samples, Copyright The Android Open Source Project, licensed under the Apache License, Version 2.0. The code in this repository is an original re-implementation of the techniques studied there, written in the `com.example.app` placeholder package against the toolchain in `data/versions.json`; no sample files were copied. Short excerpts, where present, are attributed inline.
