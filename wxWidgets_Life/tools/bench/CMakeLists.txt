# Headless stepping benchmark; links only the simulation.
add_executable(wxlife_bench StepBench.cpp)
target_link_libraries(wxlife_bench PRIVATE wxlife::core)
wxlife_configure_target(wxlife_bench)
