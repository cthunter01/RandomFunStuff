# CheckStaticLink.cmake — usage: cmake -DEXECUTABLE=<path> -P CheckStaticLink.cmake
# Fails unless ldd runs successfully and lists no shared wxWidgets library.
# (A plain "! ldd ... | grep -q libwx_" would also pass when the executable is missing.)
execute_process(COMMAND ldd "${EXECUTABLE}" OUTPUT_VARIABLE deps ERROR_VARIABLE err RESULT_VARIABLE rc)
if(NOT rc EQUAL 0)
  message(FATAL_ERROR "ldd failed for ${EXECUTABLE}: ${err}")
endif()
if(deps MATCHES "libwx_")
  message(FATAL_ERROR "wxlife links wxWidgets dynamically:\n${deps}")
endif()
