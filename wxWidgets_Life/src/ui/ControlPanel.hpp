#pragma once

#include "core/Ant.hpp"
#include "core/Rule.hpp"
#include "core/Speed.hpp"
#include "core/Types.hpp"

#include <wx/button.h>
#include <wx/checkbox.h>
#include <wx/choice.h>
#include <wx/scrolwin.h>
#include <wx/sizer.h>
#include <wx/slider.h>
#include <wx/spinctrl.h>
#include <wx/statbox.h>
#include <wx/stattext.h>
#include <wx/textctrl.h>

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace life::ui {

/// Side panel with the controls. Each user change is re-sent as a CommandId (see emitCommand).
/// Setters never emit, so MainFrame can push model state into the panel without feedback loops.
class ControlPanel final : public wxScrolledWindow {
public:
    explicit ControlPanel(wxWindow* parent);

    void setRunning(bool running);   ///< Button label "Run" / "Pause".
    /// Selects the automaton and greys out whatever only the other one uses.
    void setAutomaton(core::Automaton automaton);
    [[nodiscard]] core::Automaton selectedAutomaton() const;
    void setAntCount(int count);   ///< Clamped to the control's range, so 0 ants still shows 1.
    [[nodiscard]] int antCount() const;
    void setSpeed(core::Speed speed);
    [[nodiscard]] core::Speed speed() const;   ///< Spin value plus the Max check box.
    void setCellSize(int px);
    [[nodiscard]] int cellSize() const;   ///< Device pixels, 1..100.
    void setShowGrid(bool show);
    void setWrap(bool wrap);
    /// Two lines: "512 × 512 cells" and "516 KiB".
    void setWorldInfo(core::Extent extent, std::uint64_t bytes);
    void setRule(const core::Rule& rule);         ///< Canonical text, matching preset, error cleared.
    [[nodiscard]] std::string ruleText() const;   ///< UTF-8.
    [[nodiscard]] std::optional<std::size_t> selectedPreset() const;   ///< nullopt for "Custom".
    void setRuleError(std::string_view message);   ///< An empty message hides the error line.
    void focusRuleText();
    [[nodiscard]] double randomDensity() const;   ///< 0.01 .. 1.0

private:
    void addSimulationGroup(wxSizer& column);
    void addSpeedGroup(wxSizer& column);
    void addViewGroup(wxSizer& column);
    void addWorldGroup(wxSizer& column);
    void addRuleGroup(wxSizer& column);

    // Child controls, owned by wx.
    wxButton* runPause_{};
    wxChoice* automaton_{};    ///< core::kAutomata names, in that order
    wxSpinCtrl* density_{};    ///< 1..100 %
    wxSpinCtrl* antCount_{};   ///< 1..core::kMaxAnts
    wxButton* resetAnts_{};
    wxSlider* speedSlider_{};   ///< 0..Speed::kSliderMax (log scale)
    wxSpinCtrl* speedSpin_{};   ///< Speed::kMin..kMax
    wxCheckBox* maxSpeed_{};
    wxSlider* cellSizeSlider_{};   ///< Index into render::kZoomSteps
    wxSpinCtrl* cellSizeSpin_{};   ///< 1..100 px
    wxCheckBox* showGrid_{};
    wxStaticText* worldInfo_{};
    wxCheckBox* wrap_{};
    wxStaticBox* ruleBox_{};   ///< Disabling it greys out the whole Rule group at once
    wxChoice* rulePreset_{};   ///< kRulePresets names, then "Custom"
    wxTextCtrl* ruleText_{};   ///< wxTE_PROCESS_ENTER
    wxStaticText* ruleError_{};
};

}
