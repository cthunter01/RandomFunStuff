# clang-tidy as WebAssembly

The app runs the real clang-tidy in the browser. Nobody publishes a WebAssembly build of it, so this directory
makes one: clang-tidy 23.1.1, every check module and the static analyzer included, as a WASI command module,
plus the headers it analyses code against.

| Output                            | Size    | Brotli  | What it is                                              |
| --------------------------------- | ------- | ------- | ------------------------------------------------------- |
| `clang-tidy-23.1.1.wasm`          | 42.9 MB | 7.4 MB  | clang-tidy, `MinSizeRel`, WASI preview 1                |
| `clang-tidy-sysroot-23.1.1.tar`   | 22.8 MB | 1.7 MB  | musl 1.2.6 + libc++ 23.1.1 headers + clang's own headers |

## You probably do not need to build it

`npm run tidy:fetch` downloads the pinned build into `vendor/clang-tidy/` and checks it against the SHA-256 in
`release.json`. `npm run build` does that for you. Building is for bumping LLVM, changing the build, or
auditing that the published binary is what this recipe produces.

## Building

```bash
tools/clang-tidy-wasm/build.sh            # everything; resumable, idempotent
tools/clang-tidy-wasm/build.sh package    # re-package an existing build
```

Needs `cmake`, `ninja`, `clang`, `curl`, and about 5 GB of disk in `.build/clang-tidy-wasm/` (git-ignored).
`ccache` is used when present. A cold build is about half an hour on 20 cores; the build of the native
code generators it needs first takes under a minute.

The steps, all in `build.sh`:

1. Fetch LLVM 23.1.1, wasi-sdk 34 and musl 1.2.6, each verified by a pinned SHA-256.
2. Apply `patches/` to LLVM.
3. Build the native code generators (`llvm-tblgen`, `clang-tblgen`, `clang-tidy-confusable-chars-gen`).
4. Cross-compile clang-tidy for `wasm32-wasip1` with wasi-sdk's clang.
5. Assemble the sysroot: musl's headers, libc++'s headers configured for musl, clang's resource headers.
6. Write `out/` with the two files and a `manifest.json` of their sizes and hashes. The tarball is written
   deterministically (sorted, fixed owner and times), so the same inputs give the same bytes.

A local build can be used without publishing anything: `npm run tidy:fetch` copies from
`.build/clang-tidy-wasm/out/` when the files there match the pins in `release.json`.

## Publishing a build

The binaries are GitHub release assets, not committed files and not an npm package. To publish a new one:

1. Build, and copy the `sha256` and `bytes` of both files from `out/manifest.json` into `release.json`.
2. Pick a new `releaseTag` (e.g. `clang-tidy-wasm-23.1.1-2`) and update `baseUrl` to match.
3. Create that release on GitHub and attach both files from `out/`:
   ```bash
   gh release create clang-tidy-wasm-23.1.1-1 \
       .build/clang-tidy-wasm/out/clang-tidy-23.1.1.wasm \
       .build/clang-tidy-wasm/out/clang-tidy-sysroot-23.1.1.tar \
       --title "clang-tidy 23.1.1 for WebAssembly" --notes "Built by tools/clang-tidy-wasm/build.sh"
   ```
4. `npm run tidy:fetch -- --force` from a clean checkout to confirm the published files match the pins.

## Choices, and why

**`MinSizeRel`, not `Release`.** Measured on the largest sample: `-O3` is 3–5% faster per run and 36% larger
(58.5 MB, and proportionally more after brotli). Download is paid by every visitor; the speed difference is not noticeable.

**Code is analysed as x86_64 Linux, not as WebAssembly.** wasi-sdk ships a ready sysroot, but analysing code as
`wasm32` makes `long` 4 bytes, defines `__wasm32__` rather than `__linux__` and `__x86_64__`, and has no threads
in the default libc++. Checks about integer widths, and any code with an `#ifdef __linux__`, would behave
unlike on the machine the user actually builds for. musl rather than glibc because its headers are small, MIT
licensed and self-contained.

**No threads, no exceptions, no LTO.** clang-tidy needs none of them to analyse one file. Without threads the
module imports nothing beyond basic WASI (YoWASP needed LTO to strip thread imports; wasi-sdk 34's single-thread
libc no longer has them).

**16 MB of wasm stack, placed first.** Parsing C++ recurses deeply — `#include <iostream>` alone overflows the
default 64 KB — and with the stack below the heap an overflow traps instead of corrupting memory.

## The patch

`patches/0001-wasi-support.patch` stubs or conditionalises what WASI lacks: signals, `setjmp`, `madvise`,
process spawning, file locking, sockets. It is YoWASP's patch for LLVM 22 (github.com/YoWASP/llvm-project,
one commit on top of each release), carried forward to 23.1.1 with three changes described in its header.
One of those fixes a bug in the patch itself that is not WASI-specific: as applied to 23.1.1, it made
`CrashRecoveryContext.cpp` test `HAVE_SETJMP` without including the header that defines it, which would
silently compile crash recovery out of *native* builds too — including the code generators built in step 3.

## Verified

- The same file, same flags, analysed by this build and by a native clang-tidy 23.1.1 built from the same
  source: 174 findings each, with identical fix-its. The only textual differences are three messages that
  embed the file's own path.
- ~1.75× native run time (1.7 s against 0.98 s on the 286-line sample with every check enabled).
- `tests/core/tidy/` runs every engine test against this binary in Node, including byte-for-byte agreement
  with clang-tidy's own `--fix`.
