# Vulkan and GLES rendering

Custom GPU rendering from native code: choosing between an ordinary `Activity` hosting a `GLSurfaceView`, `GameActivity`, and the legacy `NativeActivity`; the surface lifecycle each one hands to C++; when Vulkan is worth it over OpenGL ES 3; the Gradle and CMake wiring for `game-activity` through Prefab and `glslc` shader compilation; and a GLES 3 renderer embedded in a Compose screen. This capability is marked runtime-unverified: the build wiring and lifecycle follow the NDK samples and documentation but no frame has been rendered by this repository.

## When to use

- A custom renderer (game, 3D viewer, visualizer, image pipeline) that Compose's `Canvas` and `AGSL` shaders cannot express or cannot run fast enough.
- Do not use for UI. Everything with text, lists and navigation stays in Compose; a renderer is one surface inside a Compose screen or one full-screen `GameActivity`.
- Choose the host by how much of the app is UI:

| Host | Use when | Lifecycle delivered to C++ |
|---|---|---|
| `ComponentActivity` + `GLSurfaceView` (or `SurfaceView` for Vulkan) inside Compose via `AndroidView` | The app is a normal Compose app with one rendering surface | `onSurfaceCreated/Changed/DrawFrame` (GLES) or `SurfaceHolder.Callback` + `ANativeWindow_fromSurface` (Vulkan), called from Kotlin into JNI |
| `GameActivity` (`androidx.games:games-activity`) | Full-screen game or render loop, input handled in C++, still able to call Kotlin | `android_app` commands (`APP_CMD_INIT_WINDOW`, `APP_CMD_TERM_WINDOW`, `APP_CMD_START`, `APP_CMD_DESTROY`) and buffered input through `android_native_app_glue` |
| `NativeActivity` | Legacy; the NDK samples warn against it for new apps | same command loop, but no Kotlin class to extend and `android:hasCode="false"` |

The `android/ndk-samples` `native-activity` README states plainly that most apps should not use the `NativeActivity`/`GameActivity` model because it turns the Activity lifecycle into a desktop-style `main()` that apps later undo. Default to the first row; use `GameActivity` only for a game.

Vulkan vs GLES 3:

- Vulkan: explicit control, lower CPU overhead, multithreaded command recording, required for modern game engines and compute-heavy pipelines. Costs several hundred lines before the first triangle (instance, surface, device, swapchain, pipeline, synchronization) and needs pre-rotation handling. Android 16 and later ship Vulkan as the primary graphics API with ANGLE layered on top for GLES, so new engines should target Vulkan 1.1 or higher.
- OpenGL ES 3.x: far less code, `GLSurfaceView` manages EGL and threading, enough for 2D, simple 3D and image processing. Still fully supported through ANGLE. Choose it unless profiling or the engine says otherwise.

## Dependencies

Native toolchain setup is in `capabilities/ndk-native-code/README.md`. `games-activity` is not in `data/versions.json`.

```toml
[versions]
gamesActivity = "<version>"   # https://developer.android.com/jetpack/androidx/releases/games

[libraries]
androidx-games-activity = { group = "androidx.games", name = "games-activity", version.ref = "gamesActivity" }
```

```kotlin
// app/build.gradle.kts
android {
    buildFeatures {
        prefab = true     // game-activity headers and static library
        shaders = true    // compiles src/main/shaders/*.vert|*.frag with glslc into assets/shaders/*.spv (Vulkan only)
    }
    defaultConfig {
        externalNativeBuild { cmake { arguments += "-DANDROID_STL=c++_shared" } }
        shaders { glslcArgs += listOf("-c") }
    }
}
dependencies { implementation(libs.androidx.games.activity) }   // GameActivity path only
```

```cmake
# GLES 3 renderer driven from Kotlin
add_app_library(glrenderer SHARED gl_renderer.cpp gl_jni.cpp)
target_link_libraries(glrenderer PRIVATE GLESv3 EGL android log)

# Vulkan renderer on GameActivity
find_package(game-activity REQUIRED CONFIG)
add_app_library(vkgame SHARED vk_main.cpp vk_renderer.cpp)
target_compile_definitions(vkgame PRIVATE VK_USE_PLATFORM_ANDROID_KHR=1)
# Technique from android/ndk-samples hello-vulkan (Apache-2.0): WHOLE_ARCHIVE keeps GameActivity_onCreate, which nothing in our code references.
target_link_libraries(vkgame PRIVATE vulkan $<LINK_LIBRARY:WHOLE_ARCHIVE,game-activity::game-activity_static> android log)
```

## Manifest and permissions

```xml
<uses-feature android:glEsVersion="0x00030000" android:required="true" />          <!-- GLES 3.0 path -->
<uses-feature android:name="android.hardware.vulkan.version" android:version="0x401000" android:required="true" />   <!-- Vulkan 1.1 path -->

<activity
    android:name=".render.GameActivityHost"
    android:exported="true"
    android:configChanges="orientation|screenSize|screenLayout|keyboardHidden|uiMode"
    android:theme="@style/Theme.App.Fullscreen">
    <meta-data android:name="android.app.lib_name" android:value="vkgame" />   <!-- which .so holds GameActivity_onCreate -->
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
</activity>
```

Declare only the feature the shipped renderer needs; `required="true"` on both would hide the app from devices that have one but not the other. `configChanges` keeps the activity (and the native window) alive across rotation so the renderer handles resize instead of being recreated.

## Implementation

### GLES 3 inside a Compose screen

```kotlin
package com.example.app.render

object GlBridge {
    init { System.loadLibrary("glrenderer") }
    @JvmStatic external fun init()                        // GL context exists: compile shaders, create buffers
    @JvmStatic external fun resize(width: Int, height: Int)
    @JvmStatic external fun drawFrame(timeSeconds: Float)
    @JvmStatic external fun destroy()                     // context lost: free GL objects
}
```

```kotlin
package com.example.app.render

import android.content.Context
import android.opengl.GLSurfaceView
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

class GlRenderView(context: Context) : GLSurfaceView(context) {
    init {
        setEGLContextClientVersion(3)
        setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        preserveEGLContextOnPause = true        // avoid recompiling shaders on every background trip where the driver allows it
        setRenderer(object : Renderer {
            // Technique from android/ndk-samples gles3jni (Apache-2.0): the view owns EGL and the thread; C++ only draws.
            private val start = System.nanoTime()
            override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) = GlBridge.init()
            override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) = GlBridge.resize(width, height)
            override fun onDrawFrame(gl: GL10?) = GlBridge.drawFrame((System.nanoTime() - start) / 1e9f)
        })
        renderMode = RENDERMODE_CONTINUOUSLY     // RENDERMODE_WHEN_DIRTY + requestRender() for static content
    }
}
```

```kotlin
@Composable
fun RenderSurface(modifier: Modifier = Modifier) {
    val lifecycleOwner = LocalLifecycleOwner.current
    val view = remember { mutableStateOf<GlRenderView?>(null) }
    AndroidView(
        factory = { context -> GlRenderView(context).also { view.value = it } },
        modifier = modifier.semantics { contentDescription = "3D preview" },
        update = { /* push state changes into the renderer through GlBridge setters, never redraw from here */ },
    )
    // Pause the GL thread with the lifecycle; GLSurfaceView does not observe it on its own.
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> view.value?.onResume()
                Lifecycle.Event.ON_PAUSE -> view.value?.onPause()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
}
```

The C++ side is ordinary GLES 3: compile a program in `init`, `glViewport` in `resize`, draw in `drawFrame`, and treat `init` being called again as "all previous GL objects are gone".

### Vulkan on GameActivity

```kotlin
package com.example.app.render

import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.androidgamesdk.GameActivity

class GameActivityHost : GameActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { finish() }   // not System.exit(); let the native side see APP_CMD_DESTROY
        })
    }

    companion object { init { System.loadLibrary("vkgame") } }
}
```

```cpp
// app/src/main/cpp/vk_main.cpp: the command loop every glue-based app needs
#include <game-activity/native_app_glue/android_native_app_glue.h>
#include "vk_renderer.h"   // your VulkanRenderer: init(window, assetManager), resize(), drawFrame(), destroy()

namespace {
struct Engine { VulkanRenderer renderer; bool canRender = false; };

void HandleCmd(android_app* app, int32_t cmd) {
    auto* engine = static_cast<Engine*>(app->userData);
    switch (cmd) {
        case APP_CMD_INIT_WINDOW:        // a surface exists: create or recreate the swapchain
            if (app->window != nullptr) { engine->renderer.init(app->window, app->activity->assetManager); engine->canRender = true; }
            break;
        case APP_CMD_TERM_WINDOW:        // surface going away: stop drawing, destroy the swapchain, keep the device
            engine->canRender = false;
            engine->renderer.destroySwapchain();
            break;
        case APP_CMD_WINDOW_RESIZED:
        case APP_CMD_CONFIG_CHANGED:     // rotation: recreate the swapchain with pre-rotation (VkSurfaceCapabilitiesKHR::currentTransform)
            engine->renderer.resize();
            break;
        case APP_CMD_DESTROY:
            engine->renderer.destroy();
            break;
        default: break;
    }
}
}  // namespace

extern "C" void android_main(android_app* app) {
    Engine engine{};
    app->userData = &engine;
    app->onAppCmd = HandleCmd;
    for (;;) {
        int events = 0;
        android_poll_source* source = nullptr;
        // Block when we cannot render; otherwise poll and draw.
        while (ALooper_pollOnce(engine.canRender ? 0 : -1, nullptr, &events, reinterpret_cast<void**>(&source)) >= 0) {
            if (source != nullptr) source->process(app, source);
            if (app->destroyRequested) return;
        }
        if (engine.canRender) engine.renderer.drawFrame();
    }
}
```

Validation layers are not shipped in the APK: download the Android binaries from the Khronos Vulkan-ValidationLayers releases into `src/debug/jniLibs/<abi>/` and enable `VK_LAYER_KHRONOS_validation` only in debug builds. Shaders compiled by `glslc` land in `assets/shaders/<name>.spv` and are read through `AAssetManager`.

Surface lifecycle rules shared by both paths:

1. The surface can be destroyed and recreated without the activity dying (background, rotation without `configChanges`, split screen). Everything tied to the surface (swapchain, EGL surface, framebuffers) must be rebuildable; device and shader modules can survive.
2. Never draw after `APP_CMD_TERM_WINDOW` / `surfaceDestroyed` returns; the window handle is invalid.
3. Handle `currentTransform` for pre-rotation on Vulkan or the compositor will rotate every frame for you at a cost.
4. Inset and cutout values arrive as `GameActivity` callbacks or `WindowInsets` in Compose; a full-screen renderer still has to keep controls out of the cutout.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell dumpsys SurfaceFlinger --latency SurfaceView      # frame timestamps while the surface is visible
adb shell dumpsys gfxinfo com.example.app framestats | head  # jank for the GLSurfaceView path
adb logcat -s VALIDATION vkgame glrenderer                   # validation-layer output in debug Vulkan builds
adb shell setprop debug.hwui.renderer skiavk                 # optional: confirm the device runs HWUI on Vulkan
```

Rendering can only be verified by looking at the screen or capturing it (`adb exec-out screencap -p > frame.png`) and comparing against an expectation; an instrumented test can at most assert that the surface was created and `drawFrame` ran without a GL error (`glGetError() == GL_NO_ERROR`). Report "compiled" and "surface created on <device>" separately from "frame content verified".

## Pitfalls

- Calling GL from the main thread or from a coroutine: GL objects belong to the `GLSurfaceView` render thread. Use `queueEvent {}` to run code on it.
- Keeping GL handles across `onSurfaceCreated`: the context may have been lost; recreate everything in `init`.
- `GameActivity` without `WHOLE_ARCHIVE`: the app installs, launches, and immediately finishes because `GameActivity_onCreate` was dropped by the linker.
- Missing `android.app.lib_name` meta-data, or a wrong value: `UnsatisfiedLinkError` on launch.
- Vulkan without pre-rotation: correct image, half the frame rate on rotated devices.
- Emulators run Vulkan and GLES through host translation; performance numbers and some validation errors differ from hardware.
- A `GLSurfaceView` inside a `LazyColumn` or any composable that is frequently disposed recreates the EGL context each time; host it in a stable parent.

## Sources

- https://developer.android.com/ndk/guides/graphics
- https://developer.android.com/ndk/guides/graphics/getting-started
- https://developer.android.com/games/agdk/game-activity
- https://developer.android.com/games/agdk/game-activity/get-started
- https://developer.android.com/games/optimize/vulkan-prerotation
- https://developer.android.com/develop/ui/views/graphics/opengl/about-opengl
- https://developer.android.com/reference/android/opengl/GLSurfaceView
- https://developer.android.com/ndk/guides/graphics/validation-layer
- https://developer.android.com/jetpack/androidx/releases/games
