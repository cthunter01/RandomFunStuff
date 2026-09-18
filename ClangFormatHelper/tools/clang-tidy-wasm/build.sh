#!/usr/bin/env bash
#
# Builds clang-tidy as a WebAssembly (WASI preview 1) command module, plus the
# header bundle it analyses code against.
#
#   tools/clang-tidy-wasm/build.sh            # everything; resumable
#   tools/clang-tidy-wasm/build.sh package    # just re-package an existing build
#
# Output, in $OUT (default .build/clang-tidy-wasm/out):
#
#   clang-tidy-<llvm>.wasm          the tool itself
#   clang-tidy-sysroot-<llvm>.tar   headers: musl, libc++, clang's resource dir
#   manifest.json                   versions, sizes and sha256 of both
#
# Nobody needs to run this to work on the app: `npm run tidy:fetch` downloads
# the published build. It exists so that build is reproducible, and for bumping
# LLVM. A cold build takes roughly half an hour on 20 cores.
#
# The WASI port is YoWASP's (github.com/YoWASP/llvm-project, one commit on top of
# each LLVM release), carried forward to 23.1.1 in patches/. What is ours:
# clang-tools-extra and the static analyzer switched on, and a Linux sysroot so
# user code is analysed as x86_64 Linux rather than as 32-bit WebAssembly.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=${CLANG_TIDY_WASM_WORK:-$ROOT/.build/clang-tidy-wasm}
OUT=${CLANG_TIDY_WASM_OUT:-$WORK/out}
BUILD_TYPE=${BUILD_TYPE:-MinSizeRel}

LLVM_VERSION=23.1.1
LLVM_SHA256=ebe9be46fe8756d58c5b198ffad0fa2a766257add81a4dc52179bfacc7888ee6
WASI_SDK_VERSION=34
WASI_SDK_SHA256=b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4
MUSL_VERSION=1.2.6
MUSL_SHA256=d585fd3b613c66151fc3249e8ed44f77020cb5e6c1e635a616d3f9f82460512a

# The triple user code is analysed as. The headers below are built to match it.
ANALYSIS_TRIPLE=x86_64-unknown-linux-musl

LLVM_SRC=$WORK/llvm-project-$LLVM_VERSION.src
WASI_SDK=$WORK/wasi-sdk-$WASI_SDK_VERSION.0-x86_64-linux
MUSL_SRC=$WORK/musl-$MUSL_VERSION
SYSROOT=$WORK/sysroot
LLVM_MAJOR=${LLVM_VERSION%%.*}

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

fetch() {
    local url=$1 file=$2 sha=$3
    if [[ ! -f $WORK/$file ]]; then
        log "fetching $file"
        curl -fL --retry 3 -o "$WORK/$file.part" "$url"
        mv "$WORK/$file.part" "$WORK/$file"
    fi
    echo "$sha  $WORK/$file" | sha256sum -c --quiet - || {
        echo "checksum mismatch for $file; delete it and re-run" >&2
        exit 1
    }
}

sources() {
    mkdir -p "$WORK"
    fetch "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VERSION/llvm-project-$LLVM_VERSION.src.tar.xz" \
        "llvm-project-$LLVM_VERSION.src.tar.xz" "$LLVM_SHA256"
    fetch "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_SDK_VERSION/wasi-sdk-$WASI_SDK_VERSION.0-x86_64-linux.tar.gz" \
        "wasi-sdk-$WASI_SDK_VERSION.0-x86_64-linux.tar.gz" "$WASI_SDK_SHA256"
    fetch "https://musl.libc.org/releases/musl-$MUSL_VERSION.tar.gz" "musl-$MUSL_VERSION.tar.gz" "$MUSL_SHA256"

    [[ -d $WASI_SDK ]] || tar -C "$WORK" -xzf "$WORK/wasi-sdk-$WASI_SDK_VERSION.0-x86_64-linux.tar.gz"
    [[ -d $MUSL_SRC ]] || tar -C "$WORK" -xzf "$WORK/musl-$MUSL_VERSION.tar.gz"

    # The stamp records which patches were applied, so editing a patch forces a
    # clean re-extract rather than a patch applied twice.
    local stamp=$LLVM_SRC/.patched wanted
    wanted=$(cat "$HERE"/patches/*.patch | sha256sum | cut -d' ' -f1)
    if [[ ! -f $stamp || $(cat "$stamp") != "$wanted" ]]; then
        log "extracting and patching LLVM $LLVM_VERSION"
        rm -rf "$LLVM_SRC"
        tar -C "$WORK" -xJf "$WORK/llvm-project-$LLVM_VERSION.src.tar.xz"
        for patch in "$HERE"/patches/*.patch; do
            patch -d "$LLVM_SRC" -p1 --forward --quiet < "$patch"
        done
        echo "$wanted" > "$stamp"
    fi
}

# Code generators that run during the build, so they must be native binaries.
host_tools() {
    local tools=(llvm-tblgen llvm-min-tblgen clang-tblgen clang-tidy-confusable-chars-gen)
    local missing=0
    for tool in "${tools[@]}"; do [[ -x $WORK/host-build/bin/$tool ]] || missing=1; done
    [[ $missing == 0 ]] && return
    log "building native host tools"
    cmake -G Ninja -B "$WORK/host-build" -S "$LLVM_SRC/llvm" \
        -DCMAKE_BUILD_TYPE=Release \
        -DLLVM_CCACHE_BUILD="$(command -v ccache >/dev/null && echo ON || echo OFF)" \
        -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra" \
        -DLLVM_TARGETS_TO_BUILD=WebAssembly \
        -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
        -DLLVM_INCLUDE_DOCS=OFF -DCLANG_INCLUDE_TESTS=OFF \
        -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF
    ninja -C "$WORK/host-build" "${tools[@]}"
}

wasm_build() {
    log "building clang-tidy for wasm32-wasip1 ($BUILD_TYPE)"
    local sysroot=$WASI_SDK/share/wasi-sysroot
    # -D_WASI_EMULATED_MMAN: LLVM has mmap calls that are unreachable in this configuration.
    # stack-size: parsing C++ recurses deeply; `#include <iostream>` alone overflows the
    #   default 64 KiB. --stack-first puts the stack below the heap, so an overflow traps
    #   instead of silently corrupting memory.
    # max-memory: the full 4 GiB wasm32 address space. The heap grows on demand.
    cat > "$WORK/Toolchain-WASI.cmake" <<END
set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
set(CMAKE_C_COMPILER $WASI_SDK/bin/clang)
set(CMAKE_C_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_CXX_COMPILER $WASI_SDK/bin/clang++)
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_LINKER $WASI_SDK/bin/wasm-ld)
set(CMAKE_AR $WASI_SDK/bin/ar)
set(CMAKE_RANLIB $WASI_SDK/bin/ranlib)
set(CMAKE_C_FLAGS "--sysroot=$sysroot -mcpu=lime1 -D_WASI_EMULATED_MMAN")
set(CMAKE_CXX_FLAGS "--sysroot=$sysroot -mcpu=lime1 -D_WASI_EMULATED_MMAN")
set(CMAKE_EXE_LINKER_FLAGS "--sysroot=$sysroot -lwasi-emulated-mman -Wl,--max-memory=4294967296 -Wl,-z,stack-size=16777216,--stack-first -Wl,--strip-all")
END
    cmake -G Ninja -B "$WORK/wasm-build" -S "$LLVM_SRC/llvm" \
        -DCMAKE_TOOLCHAIN_FILE="$WORK/Toolchain-WASI.cmake" \
        -DLLVM_CCACHE_BUILD="$(command -v ccache >/dev/null && echo ON || echo OFF)" \
        -DLLVM_NATIVE_TOOL_DIR="$WORK/host-build/bin" \
        -DCMAKE_BUILD_TYPE="$BUILD_TYPE" -DLLVM_ENABLE_ASSERTIONS=OFF \
        -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra" \
        -DLLVM_TARGETS_TO_BUILD=WebAssembly -DLLVM_DEFAULT_TARGET_TRIPLE="$ANALYSIS_TRIPLE" \
        -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_PIC=OFF -DLLVM_BUILD_STATIC=ON -DLLVM_ENABLE_PLUGINS=OFF \
        -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_LIBEDIT=OFF \
        -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
        -DLLVM_INCLUDE_DOCS=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_BUILD_UTILS=OFF \
        -DLLVM_INCLUDE_RUNTIMES=OFF -DLLVM_BUILD_TOOLS=OFF \
        -DCLANG_INCLUDE_TESTS=OFF -DCLANG_INCLUDE_DOCS=OFF -DCLANG_BUILD_EXAMPLES=OFF \
        -DCLANG_PLUGIN_SUPPORT=OFF \
        -DCLANG_ENABLE_STATIC_ANALYZER=ON -DCLANG_TIDY_ENABLE_STATIC_ANALYZER=ON
    ninja -C "$WORK/wasm-build" clang-tidy clang-resource-headers
}

# What user code is compiled against: musl and libc++ headers for x86_64 Linux,
# plus clang's own resource headers (stddef.h, stdarg.h, intrinsics...).
sysroot() {
    log "assembling the $ANALYSIS_TRIPLE sysroot"
    rm -rf "$SYSROOT"
    (cd "$MUSL_SRC" && CC=clang ./configure --prefix=/usr --target=x86_64-linux-musl >/dev/null \
        && make install-headers DESTDIR="$SYSROOT" >/dev/null)

    cmake -G Ninja -B "$WORK/libcxx-headers-build" -S "$LLVM_SRC/runtimes" \
        -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi" -DLIBCXX_CXX_ABI=libcxxabi \
        -DLIBCXX_HAS_MUSL_LIBC=ON -DLIBCXXABI_USE_LLVM_UNWINDER=OFF \
        -DLIBCXX_INCLUDE_TESTS=OFF -DLIBCXX_INCLUDE_BENCHMARKS=OFF -DLIBCXXABI_INCLUDE_TESTS=OFF \
        -DCMAKE_INSTALL_PREFIX="$SYSROOT/usr" >/dev/null
    ninja -C "$WORK/libcxx-headers-build" install-cxx-headers install-cxxabi-headers >/dev/null

    mkdir -p "$SYSROOT/lib/clang/$LLVM_MAJOR"
    cp -r "$WORK/wasm-build/lib/clang/$LLVM_MAJOR/include" "$SYSROOT/lib/clang/$LLVM_MAJOR/"
}

package() {
    log "packaging into $OUT"
    mkdir -p "$OUT"
    local wasm=clang-tidy-$LLVM_VERSION.wasm tarball=clang-tidy-sysroot-$LLVM_VERSION.tar
    cp "$WORK/wasm-build/bin/clang-tidy" "$OUT/$wasm"
    # Deterministic: fixed order, owner and timestamps, so a rebuild of the same
    # inputs produces the same bytes and the same checksum.
    tar -C "$SYSROOT" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 \
        --format=ustar -cf "$OUT/$tarball" .
    local wasm_sha tar_sha
    wasm_sha=$(sha256sum "$OUT/$wasm" | cut -d' ' -f1)
    tar_sha=$(sha256sum "$OUT/$tarball" | cut -d' ' -f1)
    cat > "$OUT/manifest.json" <<END
{
    "llvmVersion": "$LLVM_VERSION",
    "wasiSdkVersion": "$WASI_SDK_VERSION",
    "muslVersion": "$MUSL_VERSION",
    "buildType": "$BUILD_TYPE",
    "analysisTriple": "$ANALYSIS_TRIPLE",
    "wasm": { "file": "$wasm", "bytes": $(stat -c %s "$OUT/$wasm"), "sha256": "$wasm_sha" },
    "sysroot": { "file": "$tarball", "bytes": $(stat -c %s "$OUT/$tarball"), "sha256": "$tar_sha" }
}
END
    cat "$OUT/manifest.json"
}

case ${1:-all} in
    all) sources; host_tools; wasm_build; sysroot; package ;;
    sources) sources ;;
    host) sources; host_tools ;;
    wasm) wasm_build ;;
    sysroot) sysroot ;;
    package) package ;;
    *) echo "usage: $0 [all|sources|host|wasm|sysroot|package]" >&2; exit 2 ;;
esac
