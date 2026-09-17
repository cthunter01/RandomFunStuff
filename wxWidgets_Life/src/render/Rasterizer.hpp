#pragma once

#include "core/Ant.hpp"
#include "core/Grid.hpp"
#include "render/PixelBuffer.hpp"
#include "render/RenderStyle.hpp"
#include "render/Viewport.hpp"

#include <cstdint>
#include <span>
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

/// Paints each ant's cell body in style.ant over a frame Rasterizer::render() has just drawn, leaving the
/// grid lines alone so an ant looks like a cell of its own colour. Ants outside the view are skipped.
/// A second pass, because only the ant automaton has ants and the cell loop stays free of them.
/// @pre out.size() == viewport.canvasSize()
void drawAnts(std::span<const core::Ant> ants, const Viewport& viewport, const RenderStyle& style,
              PixelBuffer& out);

}
