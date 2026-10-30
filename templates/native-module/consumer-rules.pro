# Keep the JNI entry class and its native methods: RegisterNatives looks them up by name at load time.
-keep class com.example.nativelib.NativeLib { *; }
