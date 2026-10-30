# CMake build for the :nativelib module. AGP invokes this once per ABI with the NDK toolchain file.
cmake_minimum_required(VERSION 3.22.1)
project(nativelib LANGUAGES CXX)

# Pure C++ logic, no JNI. Compiles on the host too, so it can be unit-tested with googletest.
add_library(nativelib_core OBJECT core.cpp)
target_include_directories(nativelib_core PUBLIC include)
target_compile_options(nativelib_core PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)

# The shared library the app loads with System.loadLibrary("nativelib").
add_library(nativelib SHARED nativelib.cpp $<TARGET_OBJECTS:nativelib_core>)
target_include_directories(nativelib PUBLIC include)
target_compile_options(nativelib PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
target_link_options(nativelib PRIVATE
    # Export only the symbols listed in the version script (JNI_OnLoad). Smaller, faster to load, nothing to reverse by name.
    -Wl,--no-undefined-version
    -Wl,--version-script,${CMAKE_CURRENT_SOURCE_DIR}/libnativelib.map.txt
    # 16 KB page-size alignment; the NDK r28+ default made explicit.
    -Wl,-z,max-page-size=16384)
set_target_properties(nativelib PROPERTIES LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/libnativelib.map.txt)
target_link_libraries(nativelib PRIVATE android log)
