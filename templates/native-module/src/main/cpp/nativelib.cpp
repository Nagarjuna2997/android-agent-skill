// JNI bridge for :nativelib. This is the only file that includes <jni.h>.
// Methods are registered in JNI_OnLoad so the library exports a single symbol and a typo in a
// name or signature fails at System.loadLibrary time instead of at first call.
#include <jni.h>

#include <android/log.h>

#include <exception>

#include "nativelib/core.h"

namespace {

constexpr const char* kTag = "nativelib";

void ThrowJava(JNIEnv* env, const char* className, const char* message) {
    jclass cls = env->FindClass(className);
    if (cls != nullptr) env->ThrowNew(cls, message);
}

// Kotlin: NativeLib.checksum(bytes: ByteArray, offset: Int, count: Int): Int
jint Checksum(JNIEnv* env, jclass /* NativeLib */, jbyteArray bytes, jint offset, jint count) {
    if (bytes == nullptr) {
        ThrowJava(env, "java/lang/IllegalArgumentException", "bytes is null");
        return 0;
    }
    const jsize length = env->GetArrayLength(bytes);
    if (offset < 0 || count < 0 || offset > length - count) {
        ThrowJava(env, "java/lang/IllegalArgumentException", "offset/count out of range");
        return 0;
    }
    jbyte* data = env->GetByteArrayElements(bytes, nullptr);
    if (data == nullptr) return 0;  // OutOfMemoryError is pending
    jint result = 0;
    try {
        result = static_cast<jint>(nativelib::Checksum(
            reinterpret_cast<const std::uint8_t*>(data) + offset, static_cast<std::size_t>(count)));
    } catch (const std::exception& e) {
        ThrowJava(env, "java/lang/RuntimeException", e.what());
    } catch (...) {
        ThrowJava(env, "java/lang/RuntimeException", "unknown native error");
    }
    env->ReleaseByteArrayElements(bytes, data, JNI_ABORT);  // read-only: do not copy back
    return result;
}

const JNINativeMethod kMethods[] = {
    {"checksum", "([BII)I", reinterpret_cast<void*>(Checksum)},
};

}  // namespace

extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* /* reserved */) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
    jclass cls = env->FindClass("com/example/nativelib/NativeLib");
    if (cls == nullptr) {
        __android_log_print(ANDROID_LOG_ERROR, kTag, "NativeLib class not found");
        return JNI_ERR;
    }
    const jint count = static_cast<jint>(sizeof(kMethods) / sizeof(kMethods[0]));
    if (env->RegisterNatives(cls, kMethods, count) != JNI_OK) {
        __android_log_print(ANDROID_LOG_ERROR, kTag, "RegisterNatives failed");
        return JNI_ERR;
    }
    return JNI_VERSION_1_6;
}
