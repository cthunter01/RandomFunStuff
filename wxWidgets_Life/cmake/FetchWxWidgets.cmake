include(FetchContent)

# wxlife links wxWidgets statically; this one is not negotiable.
set(wxBUILD_SHARED OFF CACHE BOOL "Build wx libraries as shared libs" FORCE)

# Everything else is an ordinary cache default, so a -D on the command line still wins
# (wx declares its options without FORCE).
function(wxlife_wx_default name value)
  if(NOT DEFINED CACHE{${name}})
    set(${name} "${value}" CACHE STRING "Set by wxlife")
  endif()
endfunction()

if(UNIX AND NOT APPLE)
  wxlife_wx_default(wxBUILD_TOOLKIT gtk3)
endif()
foreach(option wxBUILD_SAMPLES wxBUILD_TESTS wxBUILD_DEMOS wxBUILD_BENCHMARKS wxBUILD_INSTALL
               wxBUILD_LOCALES wxBUILD_MONOLITHIC)
  wxlife_wx_default(${option} OFF)
endforeach()
# Features wxlife does not use. SPELLCHECK OFF also drops the libgspell dependency, and XTEST OFF drops
# libXtst (only wxUIActionSimulator needs it).
foreach(feature WEBVIEW MEDIACTRL STC RICHTEXT PROPGRID RIBBON XRC AUI OPENGL LIBSDL LIBNOTIFY
                WEBREQUEST SECRETSTORE LIBTIFF LIBJPEG GTKPRINT LIBMSPACK SPELLCHECK XTEST)
  wxlife_wx_default(wxUSE_${feature} OFF)
endforeach()
# zlib, libpng, expat and regex (PCRE2) stay at wx's default "sys": GTK already loads the system copies,
# and bundled copies could clash with them (wx's bundled zlib also fails to compile with GCC 14 or newer).

# Offline builds or a shared source tree: -DFETCHCONTENT_SOURCE_DIR_WXWIDGETS=/path/to/wxWidgets-3.2.11
FetchContent_Declare(wxWidgets
  URL      https://github.com/wxWidgets/wxWidgets/releases/download/v3.2.11/wxWidgets-3.2.11.tar.bz2
  URL_HASH SHA256=6a129015bce2e914e4bf61ec4411854ad962801d47e92f2eb8340adb6a90af08
  DOWNLOAD_EXTRACT_TIMESTAMP ON
  EXCLUDE_FROM_ALL   # only wx::core, wx::base and what they need are built
  SYSTEM)            # wx headers become -isystem, so our warning flags skip them
FetchContent_MakeAvailable(wxWidgets)   # provides wx::core and wx::base

# Make sure the static wx was really used: FETCHCONTENT_TRY_FIND_PACKAGE_MODE=ALWAYS or a dependency
# provider can supply an installed (shared) wxWidgets instead of the fetched one.
block()
  foreach(lib wx::core wx::base)
    if(TARGET ${lib})
      get_target_property(type ${lib} TYPE)
      get_target_property(imported ${lib} IMPORTED)
    endif()
    if(NOT TARGET ${lib} OR imported OR NOT type STREQUAL "STATIC_LIBRARY")
      message(FATAL_ERROR "wxlife needs ${lib} as a static library built from the fetched wxWidgets "
        "sources, but an installed or shared wxWidgets was used. Do not set "
        "FETCHCONTENT_TRY_FIND_PACKAGE_MODE=ALWAYS for this build; to build from a local wxWidgets tree, "
        "set FETCHCONTENT_SOURCE_DIR_WXWIDGETS instead.")
    endif()
  endforeach()
endblock()
