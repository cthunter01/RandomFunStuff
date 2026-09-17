# The wx user interface (app/ adds only the wxApp).
add_library(wxlife_ui STATIC
  CommandIds.cpp ControlPanel.cpp MainFrame.cpp MenuBar.cpp SimulationRunner.cpp WorldCanvas.cpp
  WorldSizeDialog.cpp)
add_library(wxlife::ui ALIAS wxlife_ui)
target_link_libraries(wxlife_ui PUBLIC wxlife::render wx::core wx::base)
target_compile_definitions(wxlife_ui PRIVATE WXLIFE_VERSION="${PROJECT_VERSION}")
wxlife_configure_target(wxlife_ui RELAXED)
