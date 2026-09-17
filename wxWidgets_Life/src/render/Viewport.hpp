#pragma once

#include "core/Types.hpp"
#include "render/Types.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace life::render {

inline constexpr int kMinCellSize = 1;
inline constexpr int kMaxCellSize = 100;
inline constexpr std::array kZoomSteps{1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 64, 80, 100};

/// Index of the kZoomSteps entry closest to `cellSize` (ties go to the smaller entry).
[[nodiscard]] constexpr std::size_t nearestZoomStep(int cellSize) noexcept
{
    const auto distance = [cellSize](int step) {
        const std::int64_t d = std::int64_t{step} - cellSize;   // 64-bit: cellSize may be any int
        return d < 0 ? -d : d;
    };
    std::size_t best = 0;
    for (std::size_t i = 1; i < kZoomSteps.size(); ++i) {
        if (distance(kZoomSteps[i]) < distance(kZoomSteps[best]))   // strict: the smaller entry wins ties
            best = i;
    }
    return best;
}

/// The camera: maps canvas device pixels to world cells and back.
/// offset() is the content pixel shown at the canvas's top-left corner. Every change clamps it: on an
/// axis where the world is smaller than the canvas the world is centred (a negative offset), otherwise
/// the view stays inside the world.
class Viewport {
public:
    void setWorldExtent(core::Extent world) noexcept;
    void setCanvasSize(PixelSize canvas) noexcept;   ///< Negative sides count as 0.

    [[nodiscard]] core::Extent worldExtent() const noexcept;
    [[nodiscard]] PixelSize canvasSize() const noexcept;
    [[nodiscard]] int cellSize() const noexcept;   ///< Device pixels per cell side.
    [[nodiscard]] PixelPoint offset() const noexcept;
    [[nodiscard]] PixelSize contentSize() const noexcept;   ///< world × cellSize

    /// Changes the cell size. The world point under the centre of the `anchor` pixel stays inside that
    /// pixel, and so does the cell under the anchor, unless clamping moves the view.
    /// On each axis, zooms at the same anchor with no other camera change in between form a run that keeps
    /// the point of its first zoom: rounding errors never add up, and going back to a size restores its
    /// offset. Clamping an axis (centring included) ends that axis's run only.
    /// @param px Clamped to [kMinCellSize, kMaxCellSize].
    void setCellSize(int px, PixelPoint anchor) noexcept;
    /// Moves to the `steps`-th kZoomSteps entry above (steps > 0) or below (steps < 0) the current size,
    /// clamped to the table, anchored like setCellSize().
    void zoomBy(int steps, PixelPoint anchor) noexcept;
    void fitWorld() noexcept;   ///< Largest size (≥ 1) that shows the whole world; centres it.
    void centerOn(core::CellPos cell) noexcept;
    void panBy(Pixel dx, Pixel dy) noexcept;   ///< Positive values move the view right/down.
    void scrollTo(PixelPoint offset) noexcept;

    /// @return nullopt when the point is outside the world.
    [[nodiscard]] std::optional<core::CellPos> cellAt(PixelPoint canvasPoint) const noexcept;
    /// Like cellAt(), but clamped to the world; for drags that leave it.
    [[nodiscard]] core::CellPos cellAtClamped(PixelPoint canvasPoint) const noexcept;
    /// Canvas pixel of the cell's top-left corner.
    [[nodiscard]] PixelPoint cellOrigin(core::CellPos cell) const noexcept;
    /// Clipped to the world. An empty result is not always CellRect{}; test it with empty().
    [[nodiscard]] core::CellRect visibleCells() const noexcept;

private:
    /// One axis of a run of zooms. The point it keeps under its anchor is the centre of content pixel
    /// `pixel` at cell size `pixelScale`. The run lasts while the axis is where its last zoom left it
    /// (`offset`, `cellSize`).
    struct ZoomRun {
        Pixel anchor = 0;
        Pixel pixel = 0;
        int pixelScale = 0;
        Pixel offset = 0;
        int cellSize = 0;
    };

    /// The offset along one axis that puts the run's point under `anchor` at cell size `px`. Starts a new
    /// run in `run` unless the current one goes on.
    [[nodiscard]] static Pixel zoomedOffset(std::optional<ZoomRun>& run, Pixel offset, Pixel anchor,
                                            int cellSize, int px) noexcept;
    void clampOffset() noexcept;

    core::Extent world_{};
    PixelSize canvas_{};
    int cellSize_ = 4;
    PixelPoint offset_{};
    std::array<std::optional<ZoomRun>, 2> zoomRuns_;   ///< x and y
};

}
