#pragma once

#include "core/World.h"

#include <wx/app.h>

#include <memory>

namespace life::app {

/// The wxApp, which owns the World so that it outlives every window (wx deletes the windows first).
class LifeApp final : public wxApp {
public:
    /// Sets GTK_OVERLAY_SCROLLING=0 unless it is already set, then starts wx and GTK.
    bool Initialize(int& argCount, wxChar** args) override;
    /// Creates the World and the main frame.
    bool OnInit() override;

private:
    std::unique_ptr<core::World> world_;
};

}

wxDECLARE_APP(life::app::LifeApp);
