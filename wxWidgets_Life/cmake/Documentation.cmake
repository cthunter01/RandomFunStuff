# Optional 'wxlife_docs' target (not part of ALL). All documentation settings live here (no Doxyfile).
find_package(Doxygen OPTIONAL_COMPONENTS dot)
if(NOT DOXYGEN_FOUND)
  message(STATUS "Doxygen not found - 'wxlife_docs' target disabled")
  return()
endif()
set(DOXYGEN_PROJECT_NAME "wxLife")
set(DOXYGEN_PROJECT_BRIEF "${PROJECT_DESCRIPTION}")
set(DOXYGEN_OUTPUT_DIRECTORY ${PROJECT_BINARY_DIR}/docs)
set(DOXYGEN_USE_MDFILE_AS_MAINPAGE ${PROJECT_SOURCE_DIR}/README.md)
set(DOXYGEN_JAVADOC_AUTOBRIEF YES)
set(DOXYGEN_FULL_PATH_NAMES YES)        # these three make class pages show #include "core/World.hpp"
set(DOXYGEN_STRIP_FROM_INC_PATH ${PROJECT_SOURCE_DIR}/src)
set(DOXYGEN_FORCE_LOCAL_INCLUDES YES)
set(DOXYGEN_EXTRACT_ALL YES)            # list every entity without forcing comments on obvious ones
set(DOXYGEN_EXTRACT_PRIVATE NO)
set(DOXYGEN_WARN_IF_UNDOCUMENTED NO)    # documentation is selective on purpose
set(DOXYGEN_WARN_IF_INCOMPLETE_DOC NO)  # so is @param: only where it adds information
set(DOXYGEN_GENERATE_TREEVIEW YES)
set(DOXYGEN_QUIET YES)
set(DOXYGEN_FILE_PATTERNS *.hpp *.md *.dox)
set(DOXYGEN_HAVE_DOT ${DOXYGEN_DOT_FOUND})
set(DOXYGEN_INCLUDE_GRAPH YES)          # makes the layering visible
set(DOXYGEN_CLASS_GRAPH YES)
set(DOXYGEN_CALL_GRAPH NO)
doxygen_add_docs(wxlife_docs
                 ${PROJECT_SOURCE_DIR}/README.md ${PROJECT_SOURCE_DIR}/docs ${PROJECT_SOURCE_DIR}/src
                 COMMENT "Generating API documentation")
