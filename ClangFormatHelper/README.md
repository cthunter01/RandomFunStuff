# clang-format Helper

An interactive builder for `.clang-format` files. Pick a base style, tweak options, and watch what each one
actually does to your code — using **real clang-format compiled to WebAssembly**, not a reimplementation of it.

Everything runs in your browser. The build is a static bundle with no server component, so the code you paste
never leaves your machine, and the whole thing works offline once loaded.

C and C++ are the focus. The language layer is a registry, so Java, JavaScript/TypeScript, Objective-C, Proto,
C# and JSON — all of which the same binary already understands — are a matter of adding a description rather
than writing new code paths.

## Why bother

clang-format has **209 options and 134 nested fields**, and the documentation for any one of them tells you what
it does in the abstract, not what it does to *your* code. So you edit, re-run, diff, and repeat.

The interesting part is that most options do nothing to any given file. Measured on this project:

| Sample                            | Options that change it |
| --------------------------------- | ---------------------- |
| A five-line toy snippet            | 13 of 267              |
| A realistic 60-line C++ header     | ~58 of 267             |
| A real 528-line source file        | 69 of 267              |

So roughly four fifths of the option surface is noise for whatever you happen to be formatting. This app finds
the fifth that matters by brute force — it formats your sample once per candidate value and compares — and then
dims, ranks and annotates the rest. A format call costs about half a millisecond, which is what makes an
otherwise absurd approach practical.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # static bundle in dist/ — drop it on any static host
npm run preview      # serve the built bundle on :4173
npm test             # engine tests, against the real wasm binary in Node
npm run test:e2e     # browser test: needs `npm run preview` running in another shell
```

`npm run build` regenerates nothing, but it **does** re-validate the committed option catalog against the actual
wasm binary and fails if they have drifted apart.

## Using it

Pick a **base style**, then change whatever you like. The right-hand pane always shows the file you would commit:
`BasedOnStyle` plus only the keys you actually changed, which is what a hand-written `.clang-format` looks like.

Press **Analyse my code** to run the impact sweep. Afterwards every option carries a badge:

| Badge             | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `N lines`         | Changing this option changes N lines of your sample. Bigger sorts higher.  |
| `no effect here`  | Every value we tried left your sample byte-identical. Dimmed.             |
| `?`               | A free-form value (a regex, a list of macros) we cannot enumerate.        |
| `derived`         | clang-format computed this value itself; you did not set it.              |
| `ignored`         | You set it and clang-format ignored it — usually a missing prerequisite.  |

Impact is always **relative to your current config**, not a global claim. An option that does nothing now may
well matter after you change something else.

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
| `src/ui/`                      | React. Panels are layout-agnostic; layouts are pure arrangement.                        |

Effective values are never guessed. Every value shown comes from round-tripping the config through the binary's
own `dump_config`, so anything clang-format derives on its own is visible rather than mysterious.

See [docs/architecture.md](docs/architecture.md) for the design, the extension points, and the list of things
that turned out to be false during development.

## Status

| Phase                                                                     | State |
| ------------------------------------------------------------------------- | ----- |
| Scaffold, layering test, catalog generator with a validation gate          | done  |
| Core engine: config model, serializer, effective config, constraints       | done  |
| UI: all 209 options, three switchable layouts, import/export               | done  |
| Impact analysis: dim/rank/badge, per-option micro-previews                 | done  |
| Infer a config from already-formatted code                                 | not yet |
| Inline YAML diagnostics, share links, offline PWA                          | not yet |

Diagnostics are already captured from the binary (`src/core/formatter/diagnostics.ts` parses them); they are
simply not surfaced in the editor yet.

## Adding things

**A language** — add a file under `src/core/languages/defs/`, describing the clang `Language:` key, a probe
filename (this, not the `Language:` key, is what selects the parser), and a sample library. Register it in
`src/core/languages/registry.ts`. Nothing else changes.

**A layout** — add a component under `src/ui/layouts/` that arranges the existing panels, and register it in
`src/ui/layouts/registry.tsx`. Layouts hold no state of their own, which is what keeps the three in step.

**A clang-format version** — bump `@wasm-fmt/clang-format`, run `npm run catalog:generate -- --version <v>`, and
commit the generated JSON. The catalog and the binary must move together; `npm run build` fails if they do not.
