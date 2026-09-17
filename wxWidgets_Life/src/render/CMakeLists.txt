# Camera and pixels: core and the standard library only, never wx.
add_library(wxlife_render STATIC PixelBuffer.cpp Rasterizer.cpp Viewport.cpp)
add_library(wxlife::render ALIAS wxlife_render)
target_link_libraries(wxlife_render PUBLIC wxlife::core)
wxlife_configure_target(wxlife_render)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  # Like the stepping kernel, the per-frame loop is optimised in every configuration: unoptimised,
  # a maximised 4K canvas takes up to 90 ms per frame.
  set_source_files_properties(Rasterizer.cpp PROPERTIES COMPILE_OPTIONS "-O3")
endif()
