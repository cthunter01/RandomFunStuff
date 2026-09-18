#pragma once

#include "render/Types.h"

namespace life::render {

/// Colours and grid-line policy for the rasterizer.
struct RenderStyle {
    Rgb alive;
    Rgb dead;
    Rgb gridLine;
    Rgb gridLineMajor;
    Rgb outside;   ///< Canvas area beyond the world's edge.
    Rgb ant;       ///< The cell an ant stands on, painted over that cell's own colour.
    bool showGrid = true;
    int minCellSizeForGrid = 5;   ///< Below this, lines would hide the cells.
    /// Every n-th line uses gridLineMajor, also where it crosses a minor line; 0 disables major lines.
    int majorGridEvery = 10;

    [[nodiscard]] constexpr bool gridVisibleAt(int cellSize) const noexcept
    {
        return showGrid && cellSize >= minCellSizeForGrid;
    }
};

[[nodiscard]] constexpr RenderStyle darkStyle() noexcept
{
    return {.alive{0xF2, 0xC1, 0x4E},
            .dead{0x16, 0x1A, 0x20},
            .gridLine{0x26, 0x2B, 0x33},
            .gridLineMajor{0x3A, 0x41, 0x4D},
            .outside{0x0B, 0x0C, 0x0E},
            .ant{0x4E, 0xC9, 0xF2}};
}

[[nodiscard]] constexpr RenderStyle lightStyle() noexcept
{
    return {.alive{0x1F, 0x29, 0x37},
            .dead{0xFA, 0xFA, 0xF7},
            .gridLine{0xE3, 0xE3, 0xDE},
            .gridLineMajor{0xC4, 0xC4, 0xBC},
            .outside{0xD5, 0xD8, 0xDC},
            .ant{0xC6, 0x28, 0x28}};
}

}
