#pragma once

#include "core/Types.hpp"
#include "core/World.hpp"
#include "render/PixelBuffer.hpp"
#include "render/Rasterizer.hpp"
#include "render/RenderStyle.hpp"
#include "render/Types.hpp"
#include "render/Viewport.hpp"

#include <wx/event.h>
#include <wx/gdicmn.h>
#include <wx/window.h>

#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <vector>

namespace life::ui {

/// Shows the World and turns mouse and keyboard input into strokes, camera moves and commands.
/// It never changes the World: strokes go to MainFrame through Callbacks::paintCells.
class WorldCanvas final : public wxWindow {
public:
    /// How the canvas reports to its owner (MainFrame).
    struct Callbacks {
        /// Apply a stroke segment.
        std::function<void(std::span<const core::CellPos>, core::Cell)> paintCells;
        std::function<void(core::CellPos)> toggleAnt;   ///< Ctrl + left click on a cell.
        std::function<void()> viewChanged;              ///< Zoom, scroll or resize.
        /// nullopt = the pointer is not over the world.
        std::function<void(std::optional<core::CellPos>)> hoverChanged;
    };

    /// `world` is owned by LifeApp and outlives this window.
    WorldCanvas(wxWindow* parent, const core::World& world, Callbacks callbacks);

    [[nodiscard]] int cellSize() const noexcept;   ///< Device pixels.
    void setCellSize(int px);                      ///< Anchored at the canvas centre.
    void zoomBy(int steps);                        ///< Along render::kZoomSteps, anchored at the centre.
    /// Fits the world into the canvas and keeps it fitted through canvas size changes until the user
    /// zooms or scrolls.
    void fitWorld();
    void centerWorld();
    [[nodiscard]] bool showGrid() const noexcept;
    void setShowGrid(bool show);
    [[nodiscard]] const render::RenderStyle& style() const noexcept;   ///< Colours and grid-line policy.
    void worldExtentChanged();   ///< Call right after World::resize(): fits and centres the world.
    /// World size that fills the canvas at the current cell size.
    [[nodiscard]] core::Extent cellsThatFit() const noexcept;
    void cancelStroke();   ///< Ends any drag and releases the mouse capture.

private:
    enum class Drag : std::uint8_t { None, Paint, Pan };

    void onPaint(wxPaintEvent& event);
    void onSize(wxSizeEvent& event);
    void onMouse(wxMouseEvent& event);
    void onWheel(wxMouseEvent& event);
    void onScroll(wxScrollWinEvent& event);
    void onKeyDown(wxKeyEvent& event);
    void onChar(wxKeyEvent& event);
    void onCaptureLost(wxMouseCaptureLostEvent& event);
    void onThemeChanged(wxSysColourChangedEvent& event);

    void beginPaint(core::CellPos cell, core::Cell value);
    void continuePaint(render::PixelPoint devicePoint);
    void endDrag();
    void setHovered(std::optional<core::CellPos> cell);
    void viewportChanged();   ///< Scrollbars, hovered cell, Refresh(false), callbacks_.viewChanged.
    void cameraMoved();       ///< viewportChanged() after a zoom or scroll by the user; ends a kept fit.
    bool syncCanvasSize();    ///< Re-reads the device client size (re-fitting if kept); true if it changed.
    void syncScrollbars();
    [[nodiscard]] render::PixelSize deviceClientSize() const;
    [[nodiscard]] render::PixelPoint toDevice(wxPoint logical) const;   ///< × GetContentScaleFactor()
    [[nodiscard]] render::PixelPoint canvasCentre() const noexcept;

    const core::World& world_;
    Callbacks callbacks_;
    render::Viewport viewport_;
    render::RenderStyle style_;
    render::Rasterizer rasterizer_;
    render::PixelBuffer frame_;
    Drag drag_ = Drag::None;
    int dragButton_ = wxMOUSE_BTN_NONE;   ///< Only this button's release ends the drag.
    core::Cell strokeValue_ = core::kAlive;
    std::optional<core::CellPos> lastStrokeCell_;   ///< nullopt: the next motion starts a new segment.
    std::vector<core::CellPos> strokeCells_;        ///< Reused buffer for one stroke segment.
    render::PixelPoint lastPanPoint_{};
    std::optional<render::PixelPoint> pointer_;   ///< Device pixels; nullopt while the pointer is elsewhere.
    std::optional<core::CellPos> hovered_;
    bool keepFitted_ = false;         ///< Set by fitWorld(), cleared by cameraMoved().
    double wheelZoomNotches_ = 0.0;   ///< Leftover fractions from smooth-scrolling devices.
    double wheelPanX_ = 0.0;
    double wheelPanY_ = 0.0;
};

}
