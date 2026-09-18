# clang-format Helper

An interactive builder for `.clang-format` and `.clang-tidy` files. Pick a starting point, change what you like,
and watch what each setting actually does to your code — using **real clang-format and real clang-tidy compiled
to WebAssembly**, not reimplementations of them.

Everything runs in your browser. The build is a static bundle with no server component, so the code you paste
never leaves your machine, and the whole thing works offline once loaded.

C and C++ are the focus. The language layer is a registry, so Java, JavaScript/TypeScript, Objective-C, Proto,
C# and JSON — all of which the same clang-format binary already understands — are a matter of adding a
description rather than writing new code paths. clang-tidy is C-family only, and the Tidy side says so for
anything else.

## Why bother

clang-format has **209 options and 134 nested fields**, and the documentation for any one of them tells you what
it does in the abstract, not what it does to *your* code. So you edit, re-run, diff, and repeat.

The interesting part is that most options do nothing to any given file — and *which* ones depends entirely on
what your code contains. Measured against the samples that ship with the app:

| Sample                          | Lines | Options it demonstrably changes |
| ------------------------------- | ----- | ------------------------------- |
| Kitchen sink (the default)      |   286 | 117 of 267                      |
| Templates & concepts            |    86 |  62 of 267                      |
| Short constructs & braces       |    35 |  41 of 267                      |
| Long calls & line breaking      |    21 |  37 of 267                      |
| Declarations & alignment        |    26 |  36 of 267                      |
| Includes & macros               |    31 |  21 of 267                      |
| clang-tidy findings             |   144 |  60 of 267                      |
| **All C++ samples together**    |       | **131 of 267**                  |

This app finds the options that matter by brute force — it formats your sample once per candidate value and
compares — and then dims, ranks and annotates the rest. A format call costs about half a millisecond, which is
what makes an otherwise absurd approach practical.

It also means the sample is not decoration. Code with no `union` in it cannot show you what `AfterUnion` does,
so the shipped samples are built to cover a wide span of C and C++ deliberately — structs, unions, enums,
bitfields, `else` branches, `do`/`while`, `switch`, `try`/`catch`, `goto`, `extern "C"`, operator overloads,
concepts and requires-clauses, macros, raw strings, numeric literals — and a test asserts each of those
constructs is still present by checking that the corresponding option still does something. Paste your own code
in and the same analysis runs against that instead.

**clang-tidy is the same problem, three times larger:** 602 checks and 800 options, and again most of them have
nothing to say about any particular file:

| Sample                          | Lines | Checks that find something | Findings | Options that change them |
| ------------------------------- | ----- | -------------------------- | -------- | ------------------------ |
| Kitchen sink                    |   286 |  46 of 602                 |      170 | 42 of 290                |
| clang-tidy findings             |   144 |  69 of 602                 |      164 | 40 of 290                |
| Templates & concepts            |    86 |  18 of 602                 |       32 | 15 of 290                |
| C basics                        |   136 |  20 of 602                 |       41 | 17 of 290                |

The clang-format samples are about layout, so they leave most of clang-tidy silent; the **clang-tidy findings**
sample is built to trip checks across the modules people actually enable, and a test pins that spread. The same
brute force does not work here — a clang-tidy run costs a second, not half a millisecond — so the Tidy analysis
is designed to make each run answer hundreds of questions at once ([how](docs/architecture.md#the-clang-tidy-engine)).

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static bundle in dist/
npm run release      # build + precompress (.br/.gz) — what you deploy
npm run preview      # serve the built bundle on :4173
npm test             # engine tests, against the real wasm binary in Node
npm run test:e2e     # browser test: needs `npm run preview` running in another shell
npm run check:deploy -- https://your.host/path/   # verify a live deployment

npm run tidy:fetch   # put the pinned clang-tidy wasm in vendor/ (build runs this for you)
npm run tidy:build   # build clang-tidy for WebAssembly yourself — about half an hour
```

clang-tidy's WebAssembly build is not committed and not on npm: it is a 43 MB binary pinned by URL and SHA-256 in
[`tools/clang-tidy-wasm/release.json`](tools/clang-tidy-wasm/release.json). `npm run tidy:fetch` downloads and
verifies it, and prefers a matching local build from `tools/clang-tidy-wasm/build.sh` when there is one. See
[tools/clang-tidy-wasm/README.md](tools/clang-tidy-wasm/README.md) for how it is built and published.

## Deploying

It is a static site, so any web server will do, but a few details matter a great deal for WebAssembly modules
of 2.5 MB (clang-format) and 43 MB (clang-tidy): their MIME type, compressing them, and caching hashed assets for
good while never caching `index.html`. With brotli, clang-tidy and its headers are about 9 MB, downloaded only when
someone first opens Tidy.
[docs/deployment.md](docs/deployment.md) walks through **nginx** and **Apache** (including shared hosting via
`.htaccess`), with ready-to-use configs in [`deploy/`](deploy). `npm run check:deploy` then verifies the live
result, including decoding every compressed response to prove nothing was compressed twice. Every config was
tested against real servers built from source; the guide lists exactly what was and was not covered.

`npm run build` regenerates nothing, but it **does** re-validate both committed catalogs against the actual wasm
binaries and fails if either has drifted apart from its binary.

## Using it

The **clang-format | clang-tidy** switch in the toolbar picks which file you are building. The sample, language,
layout and theme are shared; each tool keeps its own config, so switching loses nothing.

### clang-format

Pick a **base style**, then change whatever you like. The right-hand pane always shows the file you would commit:
`BasedOnStyle` plus only the keys you actually changed, which is what a hand-written `.clang-format` looks like.

The option list has a **static order** — groups in a fixed sequence, options alphabetical within each group —
so a row never moves. Changing a value leaves it exactly where it was, which is what makes the list learnable.
The **Order** control offers *By impact* if you would rather rank by what actually affects your code; that stays
stable while you edit too, and only re-orders when a fresh analysis lands.

Press **Analyse my code** to run the impact sweep. Afterwards every option carries a badge:

| Badge             | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `N lines`         | Changing this option changes N lines of your sample. Bigger sorts higher.  |
| `no effect here`  | Every value we tried left your sample byte-identical. Dimmed.             |
| `?`               | A free-form value (a regex, a list of macros) we cannot enumerate.        |
| `derived`         | clang-format computed this value itself; you did not set it.              |
| *assumed*         | Measured with a prerequisite switched on — `BraceWrapping.*` needs        |
|                   | `BreakBeforeBraces: Custom`, for instance. Reported, never silent.        |
| `ignored`         | You set it and clang-format ignored it — usually a missing prerequisite.  |

Impact is always **relative to your current config**, not a global claim. An option that does nothing now may
well matter after you change something else. Editing something marks the figures *out of date* rather than
deleting them — stale numbers are more use than none, and keeping them is also what stops the list moving.

### clang-tidy

The first switch to clang-tidy downloads it — about 9 MB, once, then cached. Someone who only uses clang-format
never downloads it at all.

clang-tidy has no base style. **Start from** replaces the `Checks` line with a common starting set — *Bug
finders*, *Modern C++*, *C++ Core Guidelines*, *Nothing*, *Everything* — and leaves option values alone.
**Flags** are the compiler flags your code is analysed with (`-std=c++23`, `-std=c17`); in a real project those
come from `compile_commands.json`, so they are not part of `.clang-tidy`.

The rail lists all 602 checks by module. Each switch makes the smallest edit to the `Checks` globs that does the
job — switching off one check inside an enabled module appends `-that-check`, and switching it back removes it
again — and the raw `Checks` line sits at the top for people who think in globs. **File settings** holds the other
top-level keys (`WarningsAsErrors`, `HeaderFilterRegex`, …). Expanding a check shows which glob turned it on or
off, what it found, and its options, each with a control of the type clang-tidy itself reports for it.

*Your code* shows the enabled checks' findings live, marked on their lines; click one to jump to it. *Fixed* is
what `clang-tidy --fix` would write, and *Diff vs fixed* the difference.

**Analyse my code** answers two questions: which checks would find something here, and which options would change
what they find. The first is one run with every check on; the second is about a dozen, spread over up to four
workers. On the kitchen sink the whole analysis takes 7 seconds in Firefox.

| Badge               | Meaning                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `N` on a check      | It finds N things in your code.                                                  |
| `silent`            | It ran and found nothing. Dimmed.                                                |
| `fix`               | It can offer fix-its.                                                            |
| `alias`             | Another name for another check. It is credited with that check's findings.      |
| `±N` on an option   | Some value of it adds or removes N findings, or changes N lines of fix.         |
| `no effect here`    | Every value tried left the findings, and their fixes, exactly as they were.     |
| `?`                 | Free text — a regex, a list of names. There is nothing to try automatically.    |
| `rejected`          | clang-tidy refused your value and used its default instead.                     |
| `check off`         | You set it, but its check is disabled, so it does nothing.                      |

The card feed has a card for each check that fires, with its findings and a before/after of its fix, all from
your code.

#### Things about clang-tidy that will bite you (and that the app tells you about)

- **Your `Checks` are added to clang-tidy's defaults, not substituted for them.** The default is
  `clang-diagnostic-*` — compiler warnings — so a list that does not start with `-*` keeps those. (Older
  versions also enabled `clang-analyzer-*` by default; 23.1.1 does not.) The rail says which glob decided each
  check.
- **A check and its alias report each finding once**, under whichever name sorts first. The app credits aliases
  with their target's findings rather than calling them silent.
- **Overlapping fixes from different checks are both dropped.** That is what `--fix` really does; *Fixed* shows
  exactly that, and says how many findings lost their fix.
- **A header the analyser does not have is treated as empty.** Pasted code includes its project's own headers,
  and a missing one is a fatal error that hides everything after it. Such headers become empty stand-ins, named
  in a notice, and the errors about what they would have declared are shown apart from the findings.
- **Code is analysed as 64-bit Linux, with libc++ and musl headers.** Nearly always what you want, but musl
  defines `NULL` as `nullptr` in C++, so `modernize-use-nullptr` has nothing to say about `NULL` here where it
  would against glibc.
- **One option crashes clang-tidy on a bad value.** `bugprone-suspicious-missing-comma.RatioThreshold` is parsed
  with `std::stod`, which throws, in a program built without exceptions. The catalog generator found it by
  probing, and the app only ever sends that field a number.

### Theme

The **Theme** control offers *Match system*, *Light* and *Dark*. It defaults to matching your OS, and an
explicit choice is remembered and wins over the system preference in both directions. Because the switch works
by setting `color-scheme` rather than by swapping colour variables, native UI — dropdowns, checkboxes, the text
caret, scrollbars — follows the theme too.

### Three layouts, same state

The layout switcher is in the toolbar. All three are views over one store, so switching preserves everything.

| Layout          | What it is for                                                                           |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Workbench**   | Options, code and generated file all visible. The centre pane tabs between your sample,   |
|                 | the formatted result, the diff against the base style, and clang-format's own example.   |
| **Diff focus**  | Maximum room for the side-by-side comparison. The `.clang-format` lives in a drawer.      |
| **Card feed**   | Your sample docked on top; below it every option as a card with its own before/after,     |
|                 | rendered from *your* code. Those previews are free — they are the witness the impact      |
|                 | sweep already recorded.                                                                   |

### Things that will bite you (and that the app tells you about)

- **`BreakBeforeBraces` silently eats `BraceWrapping`.** Set it to anything but `Custom` and all eighteen
  `BraceWrapping` flags are overwritten — in either key order, with no error. The app flags the affected rows as
  ineffective and offers a one-click fix.
- **`QualifierAlignment: Custom` is rejected** unless `QualifierOrder` is set. Likewise
  `InsertTrailingCommas: Wrapped` while `BinPackArguments` is true. Values like these are never offered as a
  bare choice.
- **`DisableFormat: true`** makes every other option inert. Flagged as such.

## How it works

| Piece                          | What it does                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `@wasm-fmt/clang-format@23.1.1`| Real clang-format, 2.5 MB of wasm (~860 KB brotli), MIT, tracking LLVM releases 1:1.    |
| `scripts/generate-catalog.ts`  | Reads clang's own `ClangFormatStyleOptions.rst` at tag `llvmorg-23.1.1` and emits the   |
|                                | option catalog. Nothing about the option surface is hand-maintained.                    |
| `src/core/`                    | The engine. Framework-free — no React, no wasm, no DOM. A layering test enforces that.  |
| `src/worker/`                  | The only place the wasm is loaded, off the main thread.                                 |
| `tools/clang-tidy-wasm/`       | Builds clang-tidy 23.1.1 as WebAssembly, and the headers it analyses against.           |
| `scripts/generate-tidy-catalog.ts` | Reads clang-tidy's docs at `llvmorg-23.1.1` and asks the binary what really exists: |
|                                | every check, every option's default, and every option's *type* — by feeding each one a  |
|                                | value nothing accepts and reading the complaint.                                        |
| `src/worker/tidy/`             | clang-tidy in a pool of up to four workers, each with an in-memory filesystem of headers. |
| `src/ui/`                      | React. Panels are layout-agnostic; layouts are pure arrangement.                        |

Effective values are never guessed, on either side. Every value shown comes from round-tripping the config through the binary's
own `dump_config` (or clang-tidy's `--dump-config` and `--list-checks`), so anything the tool derives on its own
is visible rather than mysterious.

Code is highlighted everywhere — editor, output, both sides of the diff, doc examples and the card previews —
using Lezer grammars to emit plain spans rather than an editor instance per view, because the card feed puts
hundreds of code blocks on screen at once. Grammars load on demand so they stay out of the first paint.

See [docs/architecture.md](docs/architecture.md) for the design, the extension points, and the list of things
that turned out to be false during development.

## Status

| Phase                                                                     | State |
| ------------------------------------------------------------------------- | ----- |
| Scaffold, layering test, catalog generator with a validation gate          | done  |
| Core engine: config model, serializer, effective config, constraints       | done  |
| UI: all 209 options, three switchable layouts, import/export               | done  |
| Impact analysis: dim/rank/badge, per-option micro-previews                 | done  |
| Syntax highlighting across every code view, including the editable sample  | done  |
| Selectable light / dark / match-system theme                               | done  |
| Deployment: nginx + Apache configs, precompression, a live-site checker     | done  |
| clang-tidy: WebAssembly build, check catalog, survey and option-sweep engine | done  |
| clang-tidy: tool switcher, all three layouts, import/export, fix previews    | done  |
| Infer a config from already-formatted code                                 | not yet |
| Inline YAML diagnostics, share links, offline PWA                          | not yet |

Diagnostics are already captured from the binary (`src/core/formatter/diagnostics.ts` parses them); they are
simply not surfaced in the editor yet.

## Adding things

**A language** — add a file under `src/core/languages/defs/`, describing the clang `Language:` key, a probe
filename (this, not the `Language:` key, is what selects the parser), and a sample library. Register it in
`src/core/languages/registry.ts`. Nothing else changes.

**A layout** — add a component under `src/ui/layouts/` that arranges the active tool's panel slots, and register
it in `src/ui/layouts/registry.tsx`. Layouts hold no state of their own and never ask which tool is active,
which is what keeps the three in step for both tools.

**A tool** — a third config file to build. Supply a component for each slot in `ToolPanels` (rail, card feed,
sample, result, diff, doc, file, toolbar controls, status, loading gate) and register it in
`src/ui/tools/registry.tsx`. All three layouts then serve it unchanged.

**A clang-format version** — bump `@wasm-fmt/clang-format`, run `npm run catalog:generate -- --version <v>`, and
commit the generated JSON. The catalog and the binary must move together; `npm run build` fails if they do not.

**A clang-tidy version** — bump the versions and checksums at the top of `tools/clang-tidy-wasm/build.sh`, carry
the patch forward, build, publish, update `release.json`, then `npm run tidy-catalog:generate` and commit the JSON.
Same rule: `npm run build` fails if the catalog and the binary disagree.
