# The simulation: standard library and threads only.
add_library(wxlife_core STATIC
  BandedStepper.cpp Format.cpp Grid.cpp Pacer.cpp ParallelBands.cpp ReferenceStepper.cpp Rule.cpp
  Speed.cpp StepKernel.cpp Stepper.cpp World.cpp WorldLimits.cpp)
add_library(wxlife::core ALIAS wxlife_core)
target_include_directories(wxlife_core PUBLIC ${PROJECT_SOURCE_DIR}/src)
target_link_libraries(wxlife_core PUBLIC Threads::Threads)
wxlife_configure_target(wxlife_core)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  # The hot loop is optimised in every configuration so Debug builds stay interactive.
  set_source_files_properties(StepKernel.cpp PROPERTIES COMPILE_OPTIONS "-O3")
endif()
if(WXLIFE_KERNEL_CLONES)
  set_source_files_properties(StepKernel.cpp PROPERTIES COMPILE_DEFINITIONS WXLIFE_KERNEL_CLONES)
endif()
