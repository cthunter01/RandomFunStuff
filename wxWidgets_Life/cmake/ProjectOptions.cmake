include(CheckIPOSupported)
if(WXLIFE_ENABLE_IPO)
  check_ipo_supported(RESULT WXLIFE_IPO_SUPPORTED OUTPUT wxlife_ipo_output)
  if(NOT WXLIFE_IPO_SUPPORTED)
    message(WARNING "WXLIFE_ENABLE_IPO is ON, but this toolchain cannot do IPO; building without it:\n"
                    "${wxlife_ipo_output}")
  endif()
endif()
if("thread" IN_LIST WXLIFE_SANITIZERS AND "address" IN_LIST WXLIFE_SANITIZERS)
  message(FATAL_ERROR "WXLIFE_SANITIZERS: 'thread' cannot be combined with 'address'")
endif()

# wxlife_configure_target(<target> [RELAXED])
# Applies language level, warnings, sanitizers and IPO to one of *our* targets (never to wx or GTest).
# RELAXED is for wx-facing code: it drops the cast warnings that wx macros may trigger.
function(wxlife_configure_target target)
  cmake_parse_arguments(PARSE_ARGV 1 arg "RELAXED" "" "")
  set_target_properties(${target} PROPERTIES CXX_EXTENSIONS OFF)
  target_compile_features(${target} PUBLIC cxx_std_23)
  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    set(strict $<NOT:$<BOOL:${arg_RELAXED}>>)
    target_compile_options(${target} PRIVATE
      -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wsign-conversion -Wnon-virtual-dtor
      -Woverloaded-virtual -Wnull-dereference -Wdouble-promotion -Wformat=2 -Wimplicit-fallthrough
      -Wcast-align
      $<$<CXX_COMPILER_ID:GNU>:-Wduplicated-cond -Wduplicated-branches -Wlogical-op>
      $<${strict}:-Wold-style-cast>
      $<$<AND:${strict},$<CXX_COMPILER_ID:GNU>>:-Wuseless-cast>
      $<$<BOOL:${WXLIFE_WARNINGS_AS_ERRORS}>:-Werror>)
    target_compile_definitions(${target} PRIVATE $<$<CONFIG:Debug>:_GLIBCXX_ASSERTIONS>)  # ABI-safe
    if(WXLIFE_SANITIZERS)
      list(JOIN WXLIFE_SANITIZERS "," sanitizers)
      set(sanitize -fsanitize=${sanitizers})
      if("undefined" IN_LIST WXLIFE_SANITIZERS)
        list(APPEND sanitize -fno-sanitize-recover=all)   # UB stops the program, so a test fails
      endif()
      target_compile_options(${target} PRIVATE ${sanitize} -fno-omit-frame-pointer)
      target_link_options(${target} PUBLIC ${sanitize})
    endif()
  endif()
  if(WXLIFE_ENABLE_IPO AND WXLIFE_IPO_SUPPORTED)
    set_property(TARGET ${target} PROPERTY INTERPROCEDURAL_OPTIMIZATION ON)
  endif()
endfunction()
