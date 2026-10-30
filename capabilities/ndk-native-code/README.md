# NDK native code

C++ in an Android app through CMake and JNI: `externalNativeBuild` in `build.gradle.kts`, a `CMakeLists.txt` with a version script, a JNI bridge registered in `JNI_OnLoad`, `@JvmStatic external fun` declarations loaded with `System.loadLibrary`, ABI filters, 16 KB page-size alignment, `ndk-stack` symbolication, Prefab for prebuilt libraries, HWASan and UBSan build types, and googletest unit tests run on device.

## When to use

- An existing C or C++ library must be reused (codec, DSP, physics, crypto already audited, a cross-platform core shared with iOS).
- A hot loop measured in a profiler is too slow in Kotlin even after Baseline Profiles and algorithmic fixes. Measure first; the JIT and ART are fast, and JNI calls cost a few hundred nanoseconds each plus marshalling.
- Low-latency audio (`oboe-low-latency-audio`) or a custom renderer (`vulkan-and-gles-rendering`) needs native APIs.
- Do not use native code to hide secrets (a `.so` is trivially disassembled), to "speed up" ordinary app logic, or to port code that Kotlin could express in a page. See `docs/android/native-code.md` for the decision and the project layout.

## Dependencies

The NDK and CMake are SDK components, not Maven artifacts. Pin them in Gradle so every machine and CI runner builds with the same compiler.

```sh
# Resolve both versions first: NDK from https://developer.android.com/ndk/downloads,
# CMake from the SDK Manager list. Never write a version you did not look up.
sdkmanager --install "ndk;<version>" "cmake;<version>"
```

`gradle/libs.versions.toml` (only test dependencies are Maven artifacts; both are pre-release and must be resolved from the release pages):

```toml
[versions]
junitGtest = "<version>"   # https://developer.android.com/jetpack/androidx/releases/test
googletest = "<version>"   # https://maven.google.com/web/index.html?q=com.android.ndk.thirdparty

[libraries]
androidx-test-junit-gtest = { group = "androidx.test.ext", name = "junit-gtest", version.ref = "junitGtest" }
ndk-googletest = { group = "com.android.ndk.thirdparty", name = "googletest", version.ref = "googletest" }
```

```kotlin
// app/build.gradle.kts
android {
    namespace = "com.example.app"
    compileSdk = 37
    ndkVersion = "<version>"   // https://developer.android.com/ndk/downloads

    defaultConfig {
        minSdk = 26
        targetSdk = 36
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++20"
                arguments += listOf(
                    "-DANDROID_STL=c++_shared",                 // one STL for every .so in the process
                    "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON", // 16 KB pages; default on NDK r28+, harmless there
                )
            }
        }
        ndk {
            // Ship 64-bit ARM; add armeabi-v7a for old devices and x86_64 for emulators. Never riscv64 (Play rejects it).
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "<version>"   // the CMake installed above
        }
    }

    buildFeatures { prefab = true }   // consume AARs that export native libraries (googletest, Oboe, your own :nativelib)

    buildTypes {
        debug {
            // Keep symbols so ndk-stack can read crashes; release builds strip and upload symbols instead.
            packaging { jniLibs { keepDebugSymbols += "**/*.so" } }
        }
        release {
            isMinifyEnabled = true
            ndk { debugSymbolLevel = "SYMBOL_TABLE" }   // native symbols into the App Bundle for Play crash reports
        }
    }

    packaging {
        jniLibs {
            testOnly += "**/libnativetests.so"   // the googletest library must not ship in the app APK
        }
    }
}

dependencies {
    implementation(libs.androidx.test.junit.gtest)   // runtime needed in main so the test .so links; it is small
    implementation(libs.ndk.googletest)
}
```

## Manifest and permissions

Native code needs no permission of its own. Two manifest facts matter:

- `android:extractNativeLibs` defaults to `false` on API 23+ targets, so `.so` files are loaded directly from the APK. That is why they must be page-aligned (see 16 KB below). Set `useLegacyPackaging = true` only for a sanitizer variant that needs `wrap.sh`.
- A `.so` that opens sockets or files still needs the same permissions as Kotlin code would (`INTERNET`, scoped storage rules). The sandbox is the same.

## Implementation

### CMakeLists.txt

```cmake
# app/src/main/cpp/CMakeLists.txt
cmake_minimum_required(VERSION 3.22.1)
project(nativebridge LANGUAGES CXX)

# Technique from android/ndk-samples (Apache-2.0): one helper so every target gets strict warnings and a version script.
function(add_app_library name)
    add_library(${name} ${ARGN})
    target_compile_options(${name} PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
    target_link_options(${name} PRIVATE
        -Wl,--no-undefined-version
        -Wl,--version-script,${CMAKE_CURRENT_SOURCE_DIR}/lib${name}.map.txt
        -Wl,-z,max-page-size=16384)                        # explicit even where the NDK defaults to it
    set_target_properties(${name} PROPERTIES LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/lib${name}.map.txt)
endfunction()

# Pure C++ logic in an OBJECT library so the app .so and the test .so share it without JNI.
add_library(checksum OBJECT checksum.cpp)
target_compile_options(checksum PRIVATE -Wall -Wextra -Werror)

add_app_library(nativebridge SHARED nativebridge.cpp $<TARGET_OBJECTS:checksum>)
target_link_libraries(nativebridge PRIVATE android log)

# Optional sanitizer build types pass -DSANITIZE=<hwasan|ubsan> from Gradle.
if(SANITIZE STREQUAL "hwasan")
    target_compile_options(nativebridge PUBLIC -fsanitize=hwaddress -fno-omit-frame-pointer)
    target_link_options(nativebridge PUBLIC -fsanitize=hwaddress)
elseif(SANITIZE STREQUAL "ubsan")
    target_compile_options(nativebridge PUBLIC -fsanitize=undefined -fno-sanitize-recover=undefined)
    target_link_options(nativebridge PUBLIC -fsanitize=undefined)
endif()

# On-device unit tests: googletest and junit-gtest arrive through Prefab.
find_package(googletest REQUIRED CONFIG)
find_package(junit-gtest REQUIRED CONFIG)
add_library(nativetests SHARED checksum_test.cpp $<TARGET_OBJECTS:checksum>)
target_link_libraries(nativetests PRIVATE googletest::gtest junit-gtest::junit-gtest)
```

`libnativebridge.map.txt` exports only the loader entry point:

```text
LIBNATIVEBRIDGE {
  global:
    JNI_OnLoad;
  local:
    *;
};
```

### The C++ side

```cpp
// app/src/main/cpp/checksum.h
#pragma once
#include <cstddef>
#include <cstdint>
std::uint32_t Fnv1a(const std::uint8_t* data, std::size_t length);
```

```cpp
// app/src/main/cpp/checksum.cpp
#include "checksum.h"
std::uint32_t Fnv1a(const std::uint8_t* data, std::size_t length) {
    std::uint32_t hash = 2166136261u;
    for (std::size_t i = 0; i < length; ++i) { hash ^= data[i]; hash *= 16777619u; }
    return hash;
}
```

```cpp
// app/src/main/cpp/nativebridge.cpp
#include <jni.h>
#include <android/log.h>
#include <stdexcept>
#include "checksum.h"

#define LOG_TAG "nativebridge"

namespace {

void ThrowIllegalArgument(JNIEnv* env, const char* message) {
    jclass cls = env->FindClass("java/lang/IllegalArgumentException");
    if (cls != nullptr) env->ThrowNew(cls, message);
}

// Validate everything that crosses the boundary: null references, lengths, ranges. Kotlin's type system stops here.
jint Checksum(JNIEnv* env, jclass, jbyteArray input, jint offset, jint length) {
    if (input == nullptr) { ThrowIllegalArgument(env, "input is null"); return 0; }
    const jsize size = env->GetArrayLength(input);
    if (offset < 0 || length < 0 || offset > size - length) { ThrowIllegalArgument(env, "range out of bounds"); return 0; }
    jbyte* bytes = env->GetByteArrayElements(input, nullptr);
    if (bytes == nullptr) return 0;   // OutOfMemoryError is already pending
    jint result = 0;
    try {
        result = static_cast<jint>(Fnv1a(reinterpret_cast<const std::uint8_t*>(bytes) + offset, static_cast<std::size_t>(length)));
    } catch (const std::exception& e) {
        // Technique from android/ndk-samples exceptions (Apache-2.0): a C++ exception must never unwind through JNI.
        env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);
        jclass cls = env->FindClass("java/lang/RuntimeException");
        if (cls != nullptr) env->ThrowNew(cls, e.what());
        return 0;
    } catch (...) {
        env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);
        jclass cls = env->FindClass("java/lang/RuntimeException");
        if (cls != nullptr) env->ThrowNew(cls, "unknown native error");
        return 0;
    }
    env->ReleaseByteArrayElements(input, bytes, JNI_ABORT);   // read-only: do not copy back
    return result;
}

const JNINativeMethod kMethods[] = {
    {"checksum", "([BII)I", reinterpret_cast<void*>(Checksum)},
};

}  // namespace

// Technique from android/ndk-samples hello-jni (Apache-2.0): RegisterNatives in JNI_OnLoad instead of exported Java_* names.
extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void*) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass cls = env->FindClass("com/example/app/nativebridge/NativeBridge");
    if (cls == nullptr) return JNI_ERR;
    if (env->RegisterNatives(cls, kMethods, sizeof(kMethods) / sizeof(kMethods[0])) != JNI_OK) {
        __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, "RegisterNatives failed");
        return JNI_ERR;
    }
    return JNI_VERSION_1_6;
}
```

`RegisterNatives` binds by the method name and JNI signature in the table; a typo fails at `System.loadLibrary` time with a clear message, not at first call. With name-based linking the `Java_com_example_app_nativebridge_NativeBridge_checksum` symbol would have to be exported and the version script would have to list it.

### The Kotlin side

```kotlin
package com.example.app.nativebridge

object NativeBridge {
    init {
        // Throws UnsatisfiedLinkError if the ABI is missing from the APK; let it crash early rather than catching it.
        System.loadLibrary("nativebridge")
    }

    // @JvmStatic makes these static methods on NativeBridge, which is the class JNI_OnLoad registers against.
    @JvmStatic external fun checksum(input: ByteArray, offset: Int, length: Int): Int
}
```

Keep the JNI surface in one `object` and expose it to the rest of the app through an interface, so tests and previews can use a Kotlin fake and the native call runs off the main thread:

```kotlin
package com.example.app.nativebridge

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.withContext
import javax.inject.Inject

interface ChecksumRepository {
    suspend fun checksum(bytes: ByteArray): Result<Int>
}

class NativeChecksumRepository @Inject constructor(
    @DefaultDispatcher private val dispatcher: CoroutineDispatcher,
) : ChecksumRepository {
    override suspend fun checksum(bytes: ByteArray): Result<Int> = withContext(dispatcher) {
        runCatching { NativeBridge.checksum(bytes, 0, bytes.size) }
            .onFailure { if (it is kotlinx.coroutines.CancellationException) throw it }
    }
}
```

Bind it in the Hilt module alongside the dispatcher qualifiers from `capabilities/hilt-di/README.md`. A `FakeChecksumRepository` for JVM tests avoids loading the `.so` on the host, which Robolectric cannot do.

### 16 KB page size

Apps targeting API 35 and higher submitted to Play must support 16 KB page sizes, and every `.so` in the APK, including third-party ones, must have 16 KB-aligned `LOAD` segments.

- NDK r28 and newer link with `max-page-size=16384` by default; the explicit linker flag in `add_app_library` above and `-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON` make older NDKs behave the same.
- AGP 8.5.1 and newer zip-align uncompressed `.so` files to 16 KB; AGP 9.4.0 does this without configuration.
- Third-party AARs with prebuilt `.so` files must be updated by their vendors; check them with the command in Verify.
- Code that assumed `PAGE_SIZE == 4096` (custom `mmap` arithmetic, `sysconf` ignored) must use `getpagesize()` or `sysconf(_SC_PAGESIZE)` at runtime.

### Prefab: consuming and publishing native libraries

Consuming (Oboe, googletest, curl from `com.android.ndk.thirdparty`, or your own library module): `buildFeatures { prefab = true }` in the consumer, then `find_package(<name> REQUIRED CONFIG)` and link `<name>::<target>` in CMake. The headers and `.so` files are resolved from the AAR per ABI; nothing is copied into the project.

Publishing from a `:nativelib` library module (see `templates/native-module/`):

```kotlin
// nativelib/build.gradle.kts
android {
    buildFeatures { prefabPublishing = true }
    prefab { create("nativelib") { headers = "src/main/cpp/include" } }
}
```

Consumers add `implementation(project(":nativelib"))` and `find_package(nativelib REQUIRED CONFIG)`.

### Sanitizer build types

```kotlin
// app/build.gradle.kts, inside android { buildTypes { ... } }
create("hwasan") {
    initWith(getByName("debug"))
    isDebuggable = true
    matchingFallbacks += "debug"
    externalNativeBuild { cmake { arguments += listOf("-DANDROID_STL=c++_shared", "-DSANITIZE=hwasan") } }
    ndk { abiFilters.clear(); abiFilters += "arm64-v8a" }          // HWASan is 64-bit ARM only
    packaging { jniLibs { useLegacyPackaging = true } }           // wrap.sh must be extracted from the APK
}
create("ubsan") {
    initWith(getByName("debug"))
    matchingFallbacks += "debug"
    externalNativeBuild { cmake { arguments += "-DSANITIZE=ubsan" } }
}
```

```kotlin
// same file, top level of android { }: HWASan needs API 34+ to run without a special system image
androidComponents {
    beforeVariants(selector().withBuildType("hwasan")) { it.minSdk = 34 }
}
```

`app/src/hwasan/resources/lib/arm64-v8a/wrap.sh` (executable) contains two lines: `#!/system/bin/sh` and `LD_HWASAN=1 exec "$@"`. With `-fno-sanitize-recover=undefined`, UBSan aborts on the first finding and logcat shows the file and line. ASan (32-bit or pre-34 devices) additionally needs `libclang_rt.asan-*-android.so` copied from the NDK into `jniLibs`; prefer HWASan.

### Native unit tests on device

```cpp
// app/src/main/cpp/checksum_test.cpp
#include <gtest/gtest.h>
#include "checksum.h"

TEST(Fnv1a, EmptyInputIsOffsetBasis) { EXPECT_EQ(2166136261u, Fnv1a(nullptr, 0)); }
TEST(Fnv1a, KnownVector) {
    const std::uint8_t a[] = {'a'};
    EXPECT_EQ(0xe40c292cu, Fnv1a(a, 1));
}
```

```kotlin
// app/src/androidTest/kotlin/com/example/app/nativebridge/NativeTests.kt
package com.example.app.nativebridge

import androidx.test.ext.junitgtest.GtestRunner
import androidx.test.ext.junitgtest.TargetLibrary
import org.junit.runner.RunWith

// Technique from android/ndk-samples unit-test (Apache-2.0): an empty class routes every TEST() through JUnit.
@RunWith(GtestRunner::class)
@TargetLibrary(libraryName = "nativetests")
class NativeTests
```

An ordinary instrumented test can also exercise the JNI layer end to end:

```kotlin
@Test fun checksumRejectsBadRange() {
    assertThrows(IllegalArgumentException::class.java) { NativeBridge.checksum(ByteArray(4), 2, 4) }
}
```

## Verify

```sh
./gradlew :app:assembleDebug                      # compiles C++ for every ABI in abiFilters
./gradlew :app:connectedDebugAndroidTest --tests "*NativeTests*"
./gradlew :app:assembleUbsan                      # sanitizer variants build

# Symbols present in debug, absent in release
llvm-nm --defined-only app/build/intermediates/merged_native_libs/debug/mergeDebugNativeLibs/out/lib/arm64-v8a/libnativebridge.so | grep -c ' T '   # expect 1: JNI_OnLoad

# 16 KB alignment: every LOAD segment's align must be 0x4000 or greater
llvm-objdump -p app/build/intermediates/merged_native_libs/release/mergeReleaseNativeLibs/out/lib/arm64-v8a/libnativebridge.so | grep LOAD
zipalign -c -P 16 -v 4 app/build/outputs/apk/release/app-release.apk && echo "16 KB aligned"   # exit code 0 means every .so is aligned

# Symbolicate a native crash from logcat
adb logcat | "$ANDROID_HOME/ndk/<version>/ndk-stack" -sym app/build/intermediates/merged_native_libs/debug/mergeDebugNativeLibs/out/lib/arm64-v8a
```

`llvm-nm`, `llvm-objdump` and `ndk-stack` live under `$ANDROID_HOME/ndk/<version>/` (`toolchains/llvm/prebuilt/<host>/bin/` for the LLVM tools). The intermediate path names depend on the AGP version; if the directory is missing, run `find app/build -name 'libnativebridge.so'`.

Report separately: "compiled for arm64-v8a and x86_64", "googletest suite passed on <device>", "16 KB alignment verified on the release APK", and "sanitizer variant run on device" only if it actually was.

## Pitfalls

- Calling any JNI function from a thread that was never attached, or caching a `JNIEnv*` across threads: `JNIEnv` is per thread. Cache the `JavaVM*` from `JNI_OnLoad` and call `AttachCurrentThread`/`DetachCurrentThread` on native threads.
- Holding a local reference across a long loop or storing a `jobject` in a static: local references die when the native method returns; `NewGlobalRef` what must outlive the call and `DeleteGlobalRef` it.
- Blocking the main thread in a native call: the same ANR rules apply. Dispatch through `withContext(Dispatchers.Default)` as above.
- Mixing `c++_static` across several `.so` files: each gets its own STL copy and exceptions and `std::string` break across boundaries. One shared library may use `c++_static`; more than one must use `c++_shared`.
- Missing ABI: an APK built with `abiFilters += "arm64-v8a"` installs on an x86_64 emulator and then throws `UnsatisfiedLinkError`. Add `x86_64` for emulator builds or use ABI splits/App Bundles.
- `riscv64` in `abiFilters`: Play rejects the upload.
- Forgetting `testOnly` for the googletest library: it ships in the release APK with gtest inside.
- A `.so` from a third-party AAR with 4 KB alignment fails the Play check even if your own library is correct. Run the `zipalign -P 16` check on the final artifact.
- Treating `jstring` bytes as NUL-terminated UTF-8: `GetStringUTFChars` returns modified UTF-8. For arbitrary binary data use `ByteArray`.
- `-Werror` with a newer NDK can turn a new warning into a build break; pin `ndkVersion` and bump it deliberately.

## Sources

- https://developer.android.com/ndk/guides
- https://developer.android.com/studio/projects/add-native-code
- https://developer.android.com/studio/projects/configure-agp-ndk
- https://developer.android.com/ndk/guides/cmake
- https://developer.android.com/ndk/guides/abis
- https://developer.android.com/guide/practices/page-sizes
- https://developer.android.com/ndk/guides/jni-tips
- https://developer.android.com/ndk/guides/symbol-visibility
- https://developer.android.com/ndk/guides/ndk-stack
- https://developer.android.com/ndk/guides/hwasan
- https://developer.android.com/ndk/guides/asan
- https://developer.android.com/build/native-dependencies
- https://developer.android.com/ndk/downloads
