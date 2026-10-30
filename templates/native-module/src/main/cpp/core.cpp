#include "nativelib/core.h"

namespace nativelib {

std::uint32_t Checksum(const std::uint8_t* data, std::size_t count) {
    std::uint32_t sum = 0;
    for (std::size_t i = 0; i < count; ++i) sum += data[i];
    return sum;
}

}  // namespace nativelib
