add_executable(wxlife WIN32 LifeApp.cpp main.cpp)   # WIN32 is ignored on Linux
target_link_libraries(wxlife PRIVATE wxlife::ui)
wxlife_configure_target(wxlife RELAXED)
if(WXLIFE_STATIC_LIBSTDCXX)
  target_link_options(wxlife PRIVATE -static-libstdc++ -static-libgcc)
endif()
install(TARGETS wxlife)

if(WXLIFE_BUILD_TESTS AND UNIX AND NOT APPLE)
  add_test(NAME static_link
           COMMAND ${CMAKE_COMMAND} -DEXECUTABLE=$<TARGET_FILE:wxlife>
                   -P ${PROJECT_SOURCE_DIR}/cmake/CheckStaticLink.cmake)
endif()
