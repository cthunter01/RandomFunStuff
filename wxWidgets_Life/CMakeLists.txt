cmake_minimum_required(VERSION 3.28)   # FetchContent EXCLUDE_FROM_ALL + SYSTEM, FIND_PACKAGE_ARGS
project(wxlife VERSION 0.1.0 DESCRIPTION "Conway's Game of Life with wxWidgets" LANGUAGES C CXX)  # C: wx code

# Default to Release (a parent project keeps its own choice). This comes before wxWidgets is added because
# wx reads the build type while it configures; its own Debug default applies only when wx is top-level.
if(PROJECT_IS_TOP_LEVEL AND NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(CMAKE_CXX_STANDARD 23)              # wxWidgets uses it too (wxBUILD_CXX_STANDARD defaults to it)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)     # no C++ modules; roughly halves the wx build's step count
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${PROJECT_BINARY_DIR}/bin)

option(WXLIFE_BUILD_UI "Build the wx application (downloads and builds wxWidgets)" ON)
option(WXLIFE_BUILD_TESTS "Build the unit tests" ${PROJECT_IS_TOP_LEVEL})
option(WXLIFE_BUILD_BENCH "Build the headless stepping benchmark" ON)
option(WXLIFE_BUILD_DOCS "Add a 'wxlife_docs' target when Doxygen is found" ${PROJECT_IS_TOP_LEVEL})
option(WXLIFE_KERNEL_CLONES "Build the stepping kernel for AVX2 and baseline x86-64 (runtime dispatch)" ON)
option(WXLIFE_WARNINGS_AS_ERRORS "Treat warnings in wxlife code as errors" OFF)
option(WXLIFE_ENABLE_IPO "Link-time optimisation for wxlife targets" OFF)
option(WXLIFE_STATIC_LIBSTDCXX "Also link libstdc++ and libgcc statically" OFF)
set(WXLIFE_SANITIZERS "" CACHE STRING "Sanitizers for wxlife targets: address;undefined or thread")

# Project modules are included by path, so a parent's CMAKE_MODULE_PATH cannot replace them.
include(${PROJECT_SOURCE_DIR}/cmake/ProjectOptions.cmake)
find_package(Threads REQUIRED)

find_program(CCACHE_PROGRAM ccache)
if(CCACHE_PROGRAM AND NOT CMAKE_C_COMPILER_LAUNCHER)     # a launcher the user chose wins
  set(CMAKE_C_COMPILER_LAUNCHER ${CCACHE_PROGRAM})
endif()
if(CCACHE_PROGRAM AND NOT CMAKE_CXX_COMPILER_LAUNCHER)
  set(CMAKE_CXX_COMPILER_LAUNCHER ${CCACHE_PROGRAM})
endif()

if(WXLIFE_BUILD_TESTS)
  enable_testing()                      # before add_subdirectory, so tests declared under src/ are registered
endif()

# No src/CMakeLists.txt: each layer's dependencies can be read in one place.
add_subdirectory(src/core)
add_subdirectory(src/render)
if(WXLIFE_BUILD_UI)
  include(${PROJECT_SOURCE_DIR}/cmake/FetchWxWidgets.cmake)
  add_subdirectory(src/ui)
  add_subdirectory(src/app)
endif()
if(WXLIFE_BUILD_BENCH)
  add_subdirectory(tools/bench)
endif()
if(WXLIFE_BUILD_TESTS)
  add_subdirectory(tests)
endif()
if(WXLIFE_BUILD_DOCS)
  include(${PROJECT_SOURCE_DIR}/cmake/Documentation.cmake)
endif()
