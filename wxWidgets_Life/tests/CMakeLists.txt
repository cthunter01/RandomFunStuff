include(FetchContent)
set(INSTALL_GTEST OFF)   # a normal variable (GoogleTest honours it), so a parent's cache is left alone
FetchContent_Declare(googletest
  URL      https://github.com/google/googletest/releases/download/v1.17.0/googletest-1.17.0.tar.gz
  URL_HASH SHA256=65fab701d9829d38cb77c14acdc431d2108bfdbf8979e40eb8ae567edf10b27c
  DOWNLOAD_EXTRACT_TIMESTAMP ON
  EXCLUDE_FROM_ALL
  SYSTEM
  FIND_PACKAGE_ARGS 1.14 CONFIG NAMES GTest)      # the system GoogleTest is used when present
FetchContent_MakeAvailable(googletest)
include(GoogleTest)

add_executable(wxlife_tests
  core/FormatTest.cpp core/GridTest.cpp core/LineTest.cpp core/PacerTest.cpp core/ParallelBandsTest.cpp
  core/RandomTest.cpp core/RuleTest.cpp core/SpeedTest.cpp core/StepperTest.cpp core/WorldLimitsTest.cpp
  core/WorldTest.cpp render/RasterizerTest.cpp render/ViewportTest.cpp)
target_include_directories(wxlife_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})   # support/AsciiGrid.hpp
target_link_libraries(wxlife_tests PRIVATE wxlife::render wxlife::core GTest::gtest_main)   # never wx
wxlife_configure_target(wxlife_tests)
gtest_discover_tests(wxlife_tests DISCOVERY_MODE PRE_TEST PROPERTIES TIMEOUT 60)

add_test(NAME layering
         COMMAND ${CMAKE_COMMAND} -DSRC_DIR=${PROJECT_SOURCE_DIR}/src
                 -P ${PROJECT_SOURCE_DIR}/cmake/CheckLayering.cmake)

# GUI smoke test: drives a real MainFrame, so it links wx and needs a display (it skips itself without one).
# Each test opens a window, so they run one at a time.
if(WXLIFE_BUILD_UI)
  add_executable(wxlife_gui_tests gui/GuiSmokeTest.cpp)
  target_link_libraries(wxlife_gui_tests PRIVATE wxlife::ui GTest::gtest)
  wxlife_configure_target(wxlife_gui_tests RELAXED)
  set(gui_test_properties LABELS gui RUN_SERIAL TRUE TIMEOUT 60)
  if("address" IN_LIST WXLIFE_SANITIZERS)
    # GTK and fontconfig leak at exit by design.
    list(APPEND gui_test_properties ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0:abort_on_error=1")
  endif()
  gtest_discover_tests(wxlife_gui_tests DISCOVERY_MODE PRE_TEST PROPERTIES ${gui_test_properties})
endif()
