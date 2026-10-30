// :nativelib — an Android library module that builds one C++ shared library with CMake and
// exposes it to Kotlin through JNI. Copy into a project that already has a version catalog
// (see templates/compose-app/gradle/libs.versions.toml) and add include(":nativelib") to
// settings.gradle.kts. The app module then depends on it with implementation(project(":nativelib")).
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.example.nativelib"
    compileSdk = libs.versions.compileSdk.get().toInt()

    // Resolve from https://developer.android.com/ndk/downloads and install with
    // sdkmanager --install "ndk;<version>" "cmake;<version>". Never guess; never leave <version> in a build.
    ndkVersion = "<version>"

    defaultConfig {
        minSdk = libs.versions.minSdk.get().toInt()
        consumerProguardFiles("consumer-rules.pro")

        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++20"
                arguments += listOf(
                    // One STL for the whole process. Required as soon as a second .so exists (Oboe, sanitizers, another module).
                    "-DANDROID_STL=c++_shared",
                    // 16 KB page-size support. Default on NDK r28+, required for Play on API 35+ targets.
                    "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON",
                )
            }
        }

        ndk {
            // arm64-v8a for devices, x86_64 for the emulator. Add armeabi-v7a only for a 32-bit product requirement.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "<version>"
        }
    }

    buildFeatures {
        // Publish headers under src/main/cpp/include so other native modules can find_package(nativelib).
        prefabPublishing = true
    }

    prefab {
        create("nativelib") {
            headers = "src/main/cpp/include"
        }
    }

    buildTypes {
        debug {
            // Unstripped libraries so ndk-stack can symbolicate local crashes.
            packaging { jniLibs { keepDebugSymbols += "**/*.so" } }
        }
        release {
            isMinifyEnabled = false
            // Native symbol table into the App Bundle for Play Console crash reports.
            ndk { debugSymbolLevel = "SYMBOL_TABLE" }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
}
