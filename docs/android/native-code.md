# Native code

When C or C++ belongs in an Android app, how the project is laid out, how the build flows from CMake into the APK, what ABIs, page sizes and stripping require, how to read a native crash, and the security rules for anything that crosses JNI. The step-by-step recipe with full code is `capabilities/ndk-native-code/README.md`; a copyable library module is `templates/native-module/`.

## When native code is justified

Add native code only when one of these is true and you have written down which:

1. Reuse. A library already exists in C or C++ and porting it is more work or more risk than wrapping it: codecs, DSP, physics, an audited crypto implementation, a cross-platform core shared with iOS or desktop.
2. Measured performance. A profiler (`docs/compose/performance.md` for the UI side, Macrobenchmark and Perfetto for the rest) shows a specific loop is too slow after Baseline Profiles and algorithmic fixes, and the data stays on the native side long enough that JNI marshalling does not eat the gain.
3. Native-only APIs. Low-latency audio (Oboe/AAudio), Vulkan, hardware buffers, the camera NDK, or a vendor SDK that ships only headers.

Not a justification:

- Hiding secrets. A `.so` is read with `strings` and a disassembler in minutes. API keys belong on a server; tokens belong in the Keystore-backed storage from `checklists/security.md`.
- General speed. ART's JIT and AOT compilation are fast; a JNI call costs a few hundred nanoseconds plus array and string copies, which loses on small operations.
- Habit. Porting ordinary app logic to C++ makes it harder to test, harder to debug and adds a toolchain to CI.

The NDK samples repository says the same about itself: most apps should be a Kotlin app that calls some C++ through JNI, not a native app with a Kotlin shim (`references/ndk-samples.md`).

## Project layout

Keep native code in its own Gradle module with a Kotlin facade, so the app depends on an interface and the `.so` is one implementation of it.

```text
settings.gradle.kts                include(":app", ":nativelib")
nativelib/
  build.gradle.kts                 com.android.library + externalNativeBuild + prefabPublishing
  src/main/cpp/
    CMakeLists.txt
    libnativelib.map.txt           version script: export JNI_OnLoad only
    include/nativelib/api.h        public C++ API (published through Prefab for other native modules)
    nativelib.cpp                  JNI bridge: RegisterNatives, argument validation, exception catch
    core.cpp                       pure C++ logic, no <jni.h>, testable with googletest
  src/main/kotlin/com/example/nativelib/
    NativeLib.kt                   object with @JvmStatic external fun + System.loadLibrary
app/
  src/main/kotlin/com/example/app/data/
    ChecksumRepository.kt          interface + NativeChecksumRepository(dispatcher) + FakeChecksumRepository for tests
```

Rules that follow from the layout:

- `<jni.h>` appears in exactly one file per library. Logic files take plain C++ types so they compile in a host googletest run and are reusable from Vulkan or Oboe code.
- The Kotlin `object` is the only place `external fun` and `System.loadLibrary` appear. Everything else talks to an interface injected with Hilt and runs native calls on an injected `Dispatchers.Default`.
- Tests on the JVM use the fake; tests that need the `.so` are instrumentation tests.

## Build flow

1. `sdkmanager --install "ndk;<version>" "cmake;<version>"`; pin the same versions in Gradle (`ndkVersion`, `externalNativeBuild.cmake.version`). Resolve them from https://developer.android.com/ndk/downloads and the SDK Manager list; `data/versions.json` does not track them.
2. AGP runs CMake once per ABI in `abiFilters` with the NDK's `android.toolchain.cmake`, passing `ANDROID_ABI`, `ANDROID_PLATFORM` (from `minSdk`), `ANDROID_STL` and your `arguments`. Output goes to `<module>/.cxx/<variant>/<hash>/<abi>/`.
3. Compiled `.so` files are merged with any `jniLibs/` and Prefab-provided libraries into `build/intermediates/merged_native_libs/<variant>/.../out/lib/<abi>/`, stripped (release) and packaged uncompressed into `lib/<abi>/` in the APK or App Bundle.
4. At install the package manager does not extract them (`extractNativeLibs=false` by default on API 23+); `System.loadLibrary` maps them straight from the APK, which is why alignment matters.
5. `JNI_OnLoad` runs on first `loadLibrary` and registers the native methods.

Project-wide settings worth keeping identical across modules: `ANDROID_STL=c++_shared` when more than one `.so` exists, `-Wall -Wextra -Werror`, C++20, the version script, and `-fvisibility=hidden`.

## ABIs, page size and stripping

ABIs:

- Ship `arm64-v8a`. Add `armeabi-v7a` only if the product still supports 32-bit devices, `x86_64` for emulator testing and Chromebooks. Never `riscv64` (Play rejects it).
- With App Bundles, Play serves only the matching ABI; with APKs use `splits { abi { ... } }` or accept the size.
- Every ABI in the final artifact must be present in every library, including third-party AARs, or the loader fails on that device.

16 KB page size:

- Apps targeting API 35 or higher that are submitted to Play must support 16 KB pages. Every `.so` must have `LOAD` segments aligned to 16 KB and must not hardcode 4096.
- NDK r28 and newer align by default; older NDKs need `-Wl,-z,max-page-size=16384` (and for CMake `-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON`). AGP 8.5.1 and newer zip-align uncompressed libraries to 16 KB.
- Verify the final artifact, not the source: `llvm-objdump -p lib.so | grep LOAD` shows `align 2**14` or higher; `zipalign -c -P 16 -v 4 app.apk` returns 0. A 16 KB emulator image (`android-35` and later, "16k" variant) catches runtime assumptions.

Stripping and symbols:

- Release builds strip `.so` files (`debugSymbolLevel` defaults to none). Set `ndk { debugSymbolLevel = "SYMBOL_TABLE" }` (or `"FULL"`) on release so the App Bundle carries a native debug symbols file that Play Console uses to symbolicate crashes; Crashlytics needs the same symbols uploaded through its Gradle plugin (`capabilities/crash-reporting/README.md`).
- Debug builds should keep symbols in the APK (`packaging { jniLibs { keepDebugSymbols += "**/*.so" } }`) so `ndk-stack` works locally.
- A version script exporting only `JNI_OnLoad` plus `-fvisibility=hidden` makes stripping effective: fewer symbols, fewer relocations, smaller library, nothing for a reverse engineer to read by name.

## Crash symbolication

A native crash prints a `*** *** ***` tombstone to logcat with a backtrace of addresses. Turn it into file and line numbers:

```sh
# Live
adb logcat | "$ANDROID_HOME/ndk/<version>/ndk-stack" -sym app/build/intermediates/merged_native_libs/debug/mergeDebugNativeLibs/out/lib/arm64-v8a

# From a saved tombstone
adb bugreport bugreport.zip && unzip -p bugreport.zip 'FS/data/tombstones/*' > tombstone.txt
"$ANDROID_HOME/ndk/<version>/ndk-stack" -sym <unstripped lib dir> -dump tombstone.txt

# One address
"$ANDROID_HOME/ndk/<version>/toolchains/llvm/prebuilt/<host>/bin/llvm-symbolizer" --obj=libnativelib.so 0x1a2b4
```

The symbol directory must hold the unstripped libraries from the exact build that crashed; keep them per release (the App Bundle's native debug symbols zip, or a CI artifact). For crashes from the field, Play Console and Crashlytics symbolicate automatically once symbols are uploaded. `SIGSEGV` at a low address is a null dereference; `SIGABRT` from `abort()` with a `libc` message is a failed assertion or sanitizer report; `UnsatisfiedLinkError` in the Java stack is a missing ABI or a wrong library name, not a native crash.

Reproduce memory errors early with HWASan (API 34+, arm64) or UBSan build types; the setup is in `capabilities/ndk-native-code/README.md`.

## Security notes for JNI

Native code runs in the same sandbox as Kotlin with the same permissions, but without bounds checks, nullability or managed exceptions. The boundary is where the app's safety guarantees are enforced.

- Validate every argument at the entry point: null references, array lengths against offsets and counts, enum ranges, string encodings. Throw `IllegalArgumentException` through `env->ThrowNew` and return; never trust that Kotlin checked it, because another caller may not.
- Never let a C++ exception unwind into the JVM: wrap the body in `try { } catch (const std::exception&) { } catch (...) { }` and rethrow as a Java exception. An uncaught one aborts the process.
- Check for pending Java exceptions after any JNI call that can throw (`env->ExceptionCheck()`), and return immediately; calling further JNI functions with an exception pending is undefined.
- No secrets in the `.so`: no API keys, no obfuscated strings, no "hidden" endpoints. They are extracted with `strings` and `objdump`. Keep secrets on the server; treat anything compiled into the app as public.
- Treat input from files, network and other apps as hostile in C++ exactly as in Kotlin: length-prefixed parsing, no `strcpy`/`sprintf`, fixed-size buffers checked before writes. Fuzz parsers with libFuzzer on the host where possible.
- Compile with `-Werror`, `-fstack-protector-strong`, `_FORTIFY_SOURCE=2` (the NDK enables fortify by default) and keep `-fvisibility=hidden` plus the version script. Run HWASan and UBSan variants in CI on an emulator or device farm.
- Do not call `System.load` with a path from storage or a download; only `System.loadLibrary` on libraries packaged in the APK. Loading code from a writable location is a code-injection vector and Play rejects it.
- Register natives against one class and keep that class `internal`/non-exported; do not make the JNI `object` part of a library's public API.
- Native file and socket I/O obeys the same scoped storage, network security config and cleartext rules; `docs/android/permissions.md` and `capabilities/network-security-config/README.md` apply unchanged.

## Verify

```sh
./gradlew :nativelib:assembleDebug :app:assembleRelease
llvm-objdump -p app/build/intermediates/merged_native_libs/release/mergeReleaseNativeLibs/out/lib/arm64-v8a/libnativelib.so | grep LOAD   # align 2**14 or more
zipalign -c -P 16 -v 4 app/build/outputs/apk/release/app-release-unsigned.apk          # exit 0
llvm-nm --defined-only --extern-only <release libnativelib.so> | grep -v JNI_OnLoad     # expect no output
./gradlew :app:connectedDebugAndroidTest                                                # JNI and googletest suites on a device
```

Report what was done: compiled for which ABIs, which tests ran on which device or emulator, whether the 16 KB check ran on the final artifact, and whether a sanitizer variant was executed.

## Sources

- https://developer.android.com/ndk/guides
- https://developer.android.com/ndk/guides/concepts
- https://developer.android.com/studio/projects/add-native-code
- https://developer.android.com/ndk/guides/abis
- https://developer.android.com/guide/practices/page-sizes
- https://developer.android.com/ndk/guides/jni-tips
- https://developer.android.com/ndk/guides/symbol-visibility
- https://developer.android.com/ndk/guides/ndk-stack
- https://developer.android.com/studio/build/shrink-code#native-crash-support
- https://developer.android.com/ndk/guides/hwasan
- https://developer.android.com/build/native-dependencies
- https://developer.android.com/ndk/downloads
