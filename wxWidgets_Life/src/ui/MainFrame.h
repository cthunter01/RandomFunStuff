#pragma once

#include "core/Pacer.h"
#include "core/Rule.h"
#include "core/Stepper.h"
#include "core/Types.h"
#include "core/World.h"
#include "core/WorldLimits.h"
#include "ui/SimulationRunner.h"

#include <wx/event.h>
#include <wx/frame.h>

#include <cstdint>
#include <optional>
#include <span>

namespace life::ui {

class ControlPanel;
class WorldCanvas;

/// Top-level window that maps every CommandId to a handler and keeps the controls in step with the model.
/// Together with SimulationRunner it is the only code that changes the World.
class MainFrame final : public wxFrame {
public:
    /// `world` is owned by LifeApp and outlives this frame.
    explicit MainFrame(core::World& world);

private:
    void buildLayout();
    void bindCommands();

    // One handler per CommandId (the table is in bindCommands()).
    void onRunPause();
    void onStep();
    void onClear();
    void onRandomize();
    void onFaster();
    void onSlower();
    void onToggleMaxSpeed();
    void onSpeedChanged();
    void onAutomatonLife();
    void onAutomatonAnt();
    void onAutomatonChanged();
    void onResetAnts();
    void onEngineBanded();
    void onEngineReference();
    void onZoomIn();
    void onZoomOut();
    void onZoomFit();
    void onCenterView();
    void onCellSizeChanged();
    void onToggleGrid();
    void onWorldSize();
    void onToggleWrap();
    void onApplyRule();
    void onRulePreset();
    void onFocusRule();
    void onShowControlsHelp();
    void onAbout();
    void onClose(wxCloseEvent& event);

    // Callbacks from the runner and the canvas.
    void onSimulationTick(const TickReport& report);
    void onPaintCells(std::span<const core::CellPos> cells, core::Cell value);
    void onToggleAnt(core::CellPos cell);
    void onViewChanged();
    void onHoverChanged(std::optional<core::CellPos> cell);

    void applyRule(const core::Rule& rule);
    void setAutomaton(core::Automaton automaton);
    void setEngine(core::StepperKind kind);
    void worldContentChanged();         ///< Refresh the canvas and force a status update after an edit.
    void syncControls();                ///< Panel values, menu check marks, enabled states and labels.
    void updateStatusBar(bool force);   ///< Without `force`, at most once per defaults::kStatusRefresh.

    core::World& world_;
    SimulationRunner runner_;
    std::uint64_t memoryBudget_ = core::defaultMemoryBudget();
    WorldCanvas* canvas_{};   ///< Owned by wx.
    ControlPanel* panel_{};   ///< Owned by wx.
    std::optional<core::CellPos> hovered_;
    core::Clock::time_point lastStatusUpdate_{};
};

}
