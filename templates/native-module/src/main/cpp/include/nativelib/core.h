// Public C++ API of :nativelib. Published to other native modules through Prefab.
#pragma once

#include <cstddef>
#include <cstdint>

namespace nativelib {

// Sum of the first `count` bytes of `data`, wrapped at 2^32. A deliberately small function that
// stands in for the real work; replace it and keep the shape (plain types, no JNI).
std::uint32_t Checksum(const std::uint8_t* data, std::size_t count);

}  // namespace nativelib
