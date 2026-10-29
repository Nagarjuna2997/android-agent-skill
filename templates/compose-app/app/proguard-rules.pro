# R8 rules for the app module. AGP already applies proguard-android-optimize.txt;
# AndroidX, Hilt and Compose ship their own consumer rules. Add rules here only for
# classes reached by reflection in your own code.

# Keep source file names and line numbers for readable crash reports.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# kotlinx.serialization: keep serializers for @Serializable classes (navigation routes, DTOs).
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class com.example.app.**$$serializer { *; }
-keepclassmembers class com.example.app.** { *** Companion; }
-keepclasseswithmembers class com.example.app.** { kotlinx.serialization.KSerializer serializer(...); }

# Uncomment if a JSON library or Room entity is accessed by reflection:
# -keep class com.example.app.data.model.** { *; }
