#pragma once

#include <wx/menu.h>

namespace life::ui {

/// Builds the menus and accelerators. The frame takes ownership with SetMenuBar().
[[nodiscard]] wxMenuBar* buildMenuBar();

}
