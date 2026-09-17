#pragma once

#include <cstdint>
#include <limits>

namespace life::core {

/// SplitMix64: small, fast, deterministic 64-bit generator (satisfies std::uniform_random_bit_generator).
class SplitMix64 {
public:
    using result_type = std::uint64_t;

    constexpr explicit SplitMix64(std::uint64_t seed) noexcept : state_(seed) {}

    static constexpr result_type min() noexcept { return 0; }
    static constexpr result_type max() noexcept { return std::numeric_limits<result_type>::max(); }

    constexpr result_type operator()() noexcept
    {
        state_ += 0x9E3779B97F4A7C15u;   // Weyl sequence, then two xor-shift-multiply rounds
        std::uint64_t z = state_;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9u;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBu;
        return z ^ (z >> 31);
    }

private:
    std::uint64_t state_;
};

}
