#pragma once

#include "core/Grid.hpp"
#include "render/PixelBuffer.hpp"
#include "render/RenderStyle.hpp"
#include "render/Viewport.hpp"

#include <cstdint>
#include <vector>

namespace life::render {

/// Draws the part of a Grid visible through a Viewport. Cost is O(canvas pixels), independent of world size.
class Rasterizer {
public:
    /// Resizes `out` to viewport.canvasSize() and paints it. @pre viewport.worldExtent() == grid.extent()
    void render(const core::Grid& grid, const Viewport& viewport, const RenderStyle& style, PixelBuffer& out);

private:
    // Scratch rows rebuilt once per frame; kept as members so painting does not allocate.
    std::vector<std::uint8_t> aliveStamp_, deadStamp_;   ///< One cell's pixel run (cellSize × 3 bytes)
    /// Same, with a major grid-line pixel at the end.
    std::vector<std::uint8_t> aliveStampMajor_, deadStampMajor_;
    std::vector<std::uint8_t> gridRow_, gridRowMajor_;   ///< Horizontal grid-line pixel rows
};

}
