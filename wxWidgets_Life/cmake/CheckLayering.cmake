# CheckLayering.cmake — usage: cmake -DSRC_DIR=<repo>/src -P CheckLayering.cmake
# Fails if a layer includes wx (core, render) or a layer above it (see docs/architecture.md).
# Only src/ is checked: tests may include any layer (tests/gui drives the ui layer).
set(include "#[ \t]*include[ \t]*[<\"]")   # '#include', '# include', <...> and "..."
set(forbidden_core   "${include}wx/" "${include}(render|ui|app)/")
set(forbidden_render "${include}wx/" "${include}(ui|app)/")
set(forbidden_ui     "${include}app/")
set(violations "")
foreach(layer core render ui)
  file(GLOB_RECURSE files "${SRC_DIR}/${layer}/*.h" "${SRC_DIR}/${layer}/*.cpp")
  foreach(file IN LISTS files)
    foreach(pattern IN LISTS forbidden_${layer})
      file(STRINGS "${file}" hits REGEX "${pattern}")
      if(hits)
        list(APPEND violations "${file}: ${hits}")
      endif()
    endforeach()
  endforeach()
endforeach()
if(violations)
  list(JOIN violations "\n  " text)
  message(FATAL_ERROR "Layering violations:\n  ${text}")
endif()
