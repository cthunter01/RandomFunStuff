#pragma once

#include "render/Types.hpp"

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace life::render {

/// 24-bit RGB image, row-major, three bytes per pixel: the byte layout of wxImage::GetData().
class PixelBuffer {
public:
    static constexpr std::size_t kBytesPerPixel = 3;

    void resize(PixelSize size);   ///< Contents are unspecified afterwards.
    [[nodiscard]] PixelSize size() const noexcept;
    [[nodiscard]] std::span<std::uint8_t> bytes() noexcept;
    [[nodiscard]] std::span<const std::uint8_t> bytes() const noexcept;
    [[nodiscard]] std::span<std::uint8_t> row(Pixel y) noexcept;   ///< 3 × width bytes. @pre 0 <= y < height
    [[nodiscard]] Rgb at(Pixel x, Pixel y) const noexcept;         ///< @pre the pixel is inside the buffer
    void fill(Rgb color) noexcept;

private:
    PixelSize size_{};
    std::vector<std::uint8_t> bytes_;
};

}
