package com.example.nativelib

/**
 * The only Kotlin type that knows a native library exists. Keep it small, keep it `object`, and
 * expose it to the app through an interface (for example `ChecksumRepository`) so JVM tests and
 * Compose previews use a fake instead of loading the `.so`.
 *
 * Native calls run on the caller's thread; call them from `withContext(Dispatchers.Default)`,
 * never from the main thread for anything that takes longer than a few microseconds.
 */
object NativeLib {
    init {
        // Throws UnsatisfiedLinkError when the APK has no library for this device's ABI. Do not catch it here;
        // a missing ABI is a packaging bug that must surface immediately.
        System.loadLibrary("nativelib")
    }

    /**
     * Sum of `count` bytes of [bytes] starting at [offset], wrapped at 2^32.
     * @throws IllegalArgumentException when the range is outside the array (checked on the native side too).
     */
    @JvmStatic
    external fun checksum(bytes: ByteArray, offset: Int, count: Int): Int

    fun checksum(bytes: ByteArray): Int = checksum(bytes, 0, bytes.size)
}
