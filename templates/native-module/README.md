# native-module template

A minimal `:nativelib` Android library module: one C++ shared library built with CMake, a JNI bridge that registers its methods in `JNI_OnLoad`, a Kotlin `object` with `@JvmStatic external fun`, a version script that exports a single symbol, 16 KB page-size alignment, Prefab publishing of the headers, and an instrumented test. It is the module shape that `docs/android/native-code.md` describes and `capabilities/ndk-native-code/README.md` explains line by line.

## Layout

```
build.gradle.kts                           com.android.library, externalNativeBuild, abiFilters, prefabPublishing
consumer-rules.pro                         keeps the JNI class under R8 in consuming apps
src/main/AndroidManifest.xml               empty; a library needs no components
src/main/cpp/CMakeLists.txt                core OBJECT library + nativelib SHARED library, warnings as errors
src/main/cpp/libnativelib.map.txt          version script: JNI_OnLoad is the only exported symbol
src/main/cpp/include/nativelib/core.h      public C++ API, published through Prefab
src/main/cpp/core.cpp                      pure C++ logic, no <jni.h>
src/main/cpp/nativelib.cpp                 JNI bridge: validation, exception catch, RegisterNatives
src/main/kotlin/com/example/nativelib/NativeLib.kt   System.loadLibrary + external declarations
src/androidTest/kotlin/com/example/nativelib/NativeLibTest.kt   runs on a device or emulator
```

## Apply it

1. Copy the directory into the project as `nativelib/` and add `include(":nativelib")` to `settings.gradle.kts`.
2. Add the library plugin alias to `gradle/libs.versions.toml` if the catalog only has the application one:

   ```toml
   [plugins]
   android-library = { id = "com.android.library", version.ref = "agp" }
   ```

   and `alias(libs.plugins.android.library) apply false` to the root `build.gradle.kts`. The template reads `compileSdk`, `minSdk`, `junit`, `androidx-test-ext-junit` and `androidx-test-runner` from the same catalog as `templates/compose-app`.
3. Install and pin the NDK and CMake. Resolve the versions from https://developer.android.com/ndk/downloads and the SDK Manager, run `sdkmanager --install "ndk;<version>" "cmake;<version>"`, and replace both `<version>` placeholders in `build.gradle.kts`. Never leave a placeholder in a file handed to a build.
4. Rename the package. Replace `com.example.nativelib` in `NativeLib.kt`, `NativeLibTest.kt`, `consumer-rules.pro`, the `namespace` in `build.gradle.kts`, and the `FindClass("com/example/nativelib/NativeLib")` string in `nativelib.cpp`; move the Kotlin directories to match. The class name in `FindClass` must match exactly or `JNI_OnLoad` fails and `System.loadLibrary` throws.
5. Rename the library if needed: the `nativelib` target name in `CMakeLists.txt`, the `libnativelib.map.txt` file name and the `--version-script` path, the `prefab { create("nativelib") }` name, and the string in `System.loadLibrary("nativelib")` must agree.
6. Depend on it from the app with `implementation(project(":nativelib"))`. Wrap `NativeLib` in a repository interface with a fake for JVM tests; call it from `withContext(Dispatchers.Default)`.
7. Build and test before claiming it works:

   ```sh
   ./gradlew :nativelib:assembleDebug
   ./gradlew :nativelib:connectedDebugAndroidTest
   llvm-objdump -p nativelib/build/intermediates/merged_native_libs/debug/mergeDebugNativeLibs/out/lib/arm64-v8a/libnativelib.so | grep LOAD   # align 2**14
   ```

   Report "compiled for arm64-v8a and x86_64" and "instrumented tests passed on <device>" separately; the template has not been built inside your project's dependency graph until you do this.

## Replace the sample function

`Checksum` exists to show the shape: a plain C++ function in `core.cpp` with a header under `include/`, one JNI method in `nativelib.cpp` that validates every argument and catches every exception, one entry in `kMethods`, and one `external fun` in `NativeLib.kt`. Add functions by repeating those four places. Keep `<jni.h>` out of `core.cpp` so the logic stays testable with googletest (`capabilities/ndk-native-code/README.md` shows the `junit-gtest` setup).

## What is deliberately not here

- No Hilt module: the consuming app binds `NativeLib` behind its own interface in its own DI graph.
- No sanitizer build types, googletest, Oboe or Vulkan: each is added following its capability (`ndk-native-code`, `oboe-low-latency-audio`, `vulkan-and-gles-rendering`).
- No `armeabi-v7a`: add it to `abiFilters` only when the product supports 32-bit devices.
