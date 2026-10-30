package com.example.nativelib

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

// Instrumented: the .so is loaded on the device or emulator. JVM unit tests must use a fake instead.
@RunWith(AndroidJUnit4::class)
class NativeLibTest {
    @Test
    fun sumsBytes() {
        assertEquals(6, NativeLib.checksum(byteArrayOf(1, 2, 3)))
    }

    @Test
    fun emptyArrayIsZero() {
        assertEquals(0, NativeLib.checksum(ByteArray(0)))
    }

    @Test
    fun rejectsRangeOutsideArray() {
        assertThrows(IllegalArgumentException::class.java) { NativeLib.checksum(ByteArray(4), 2, 4) }
    }
}
