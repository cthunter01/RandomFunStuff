# Architecture

## The two rules

Everything else follows from these.

1. **`src/core/` is framework-free.** No React, no CodeMirror, no DOM, and — importantly — no
   `@wasm-fmt/clang-format`. The engine reaches the formatter only through the `FormatterPort` interface.
2. **Variation lives in registries, not in conditionals.** There are two: languages and layouts.

Both are enforced by `tests/architecture/layering.test.ts` rather than by this document, because a document
nobody re-reads is not an architecture. Same idea as the layering check in the sibling `wxWidgets_Life` project.

| Layer        | May import                                                | Never                                         |
| ------------ | --------------------------------------------------------- | --------------------------------------------- |
| `src/core`   | `src/core/**`, `src/worker/protocol`                      | react, codemirror, `@wasm-fmt/*`, `src/ui`    |
| `src/worker` | `src/core/**`, `@wasm-fmt/*`                              | react, `src/ui`                               |
| `src/ui`     | `src/core/**`, `src/ui/**`, `src/worker/{protocol,client}`| `@wasm-fmt/*`, the worker internals           |

The "UI must not import `@wasm-fmt`" rule is not cosmetic: doing so installs a second 2.5 MB module in the main
thread's realm and costs a second compile.

`FormatterPort` is what makes the engine testable. The app injects a Worker-backed implementation; the tests
inject one that drives the same `createRuntime` directly in Node. So the impact engine's tests run against the
real binary with no browser, no bundler and no mocks.

## Data flow

```
ClangFormatStyleOptions.rst @ llvmorg-23.1.1
        │  (build time, scripts/generate-catalog.ts)
        ▼
src/core/catalog/generated/options.23.1.1.json      ← committed, validated against the binary
        │
        ▼
   catalog ──┐
             ├──► useOptionRows ──► panels ──► layouts
 StyleDocument│      (filter, rank, group)
 (base + sparse overrides)
        │
        ├──► toInlineStyle ──► dumpConfig ──► EffectiveConfig ──► constraints ──► verdicts
        ├──► toFileText    ──► the .clang-format pane and the export
        └──► analyseImpact ──► ImpactMap (verdict, magnitude, witness) ──► badges + micro-previews
```

## Config model

Base style plus a **sparse** map of dotted paths, because that is what a hand-written `.clang-format` looks
like, and because "has the user changed this?" needs to be O(1) for every row on screen.

- Nested structs store **leaves** (`BraceWrapping.AfterFunction`), since clang-format merges a partial struct
  onto the base. Verified.
- Lists are stored **whole** (`IncludeCategories`), since clang-format replaces lists rather than merging them.
- Effective values always come from `dump_config`, never from our own idea of the defaults. That is what makes
  a `derived` value visible instead of mysterious.

## Things that turned out to be false

Each of these cost real debugging time and each is now pinned by a test.

**`dump_config` and `format` do not accept the same input.** `format` takes a style name, inline flow, or the
full text of a `.clang-format`. `dump_config` takes only a name or inline flow — hand it ordinary multi-line
YAML and it fails with `Invalid value for -style`. Hence `toInlineStyle()`, and a runtime guard in the port that
fails with a message naming the fix.

**Reusing one `ClangFormat` instance is actively harmful.** It looks like the obvious optimisation and it is
wrong twice: it measures the same (7.73 vs 7.75 ms/call over 1500 formats of a 522-line file), and each
`with_style` allocates inside the wasm heap. The engine creates one per call and disposes it.

**The module still dies on its own.** Independently of instance reuse, the module accumulates state across
*distinct* styles and somewhere past ~800 formats either traps with `memory access out of bounds` or simply
stops making progress. No single input triggers it — every candidate that appears to hang formats fine on its
own, which is what made this expensive to find. One impact sweep is ~450 formats, so the *second* sweep in a
session lands squarely in the failure window. `createRuntime` therefore re-instantiates the module every 250
operations; from an already-compiled module that costs ~2 ms.

**Language applicability cannot be probed.** The original plan was to ask the binary which options it rejects
for each language. It rejects almost nothing: across all 209 options and ten languages the probe found *zero*
language restrictions, because clang-format accepts nearly every key regardless of language and silently
ignores the ones that do not apply. The two values it did reject turned out to be unmet *inter-option*
dependencies, not language facts. So `languageHints` is an honest heuristic over option names and documentation
prose, presented as a hint and never as a hard block — and the impact engine is the only authority on whether
an option matters.

**Enum-typed nested fields hide their siblings.** `BraceWrapping`'s third field is enum-typed, so its own
"Possible values:" marker appears *inside* the section. A parser that prefers that marker over "Nested
configuration flags:" silently drops every field declared above it — three real `BraceWrapping` flags went
missing this way. The validation gate now checks nested field paths, not just top-level keys.

**`BreakBeforeBraces` overwrites `BraceWrapping` in either key order.** Not an ordering problem, so no amount of
careful serialization avoids it. Modelled as a first-class constraint with a one-click fix.

## The catalog generator

`scripts/generate-catalog.ts` fetches clang's own documentation at the pinned tag and parses it. That file is
itself generated from `Format.h` by clang's `dump_format_style.py`, so it tracks the binary exactly and nothing
about the option surface has to be hand-maintained.

The **validation gate** is the important part. It flattens `dump_config` output for every base style to dotted
paths and compares against the catalog:

- **emitted but not in the catalog → hard failure.** This direction means the UI would hide a real option.
- **in the catalog but not emitted → recorded, not failed.** Deprecated aliases and list options that
  `dump_config` omits when empty land here (30 of them). Recording it rather than allowlisting by hand means
  `--check` can still detect a genuine change later.

`npm run catalog:check` runs in the build and is deliberately offline: it validates the committed catalog
against the installed binary, which is the drift that actually matters. Regenerating needs the network and is a
separate, explicit command.

Three fields are injected by hand (`IntegerLiteralSeparator.{Binary,Decimal,Hex}MinDigits`): the binary accepts
them but the docs describe them only in prose, as deprecated renames.

## Impact engine

Format the sample once for a baseline, then once per candidate value, and compare. Candidates are **type-aware
and relative to the value currently in force**, which matters more than it sounds:

- Never harvest a nested struct's child values as parent candidates — that produces `BraceWrapping: Never` and
  similar nonsense that the binary rejects.
- Never offer a value flagged `needsPrerequisite`; the resulting config would not load.
- `Language` is excluded entirely: it selects the document, it is not a setting.
- `DisableFormat` is excluded as degenerate — it makes the formatter a no-op.

Results carry a **witness**: the candidate that changed the most, plus a small hunk. The card feed's
micro-previews are that witness, so they cost nothing extra.

Cost, measured: ~250 ms for a small sample, ~4.5 s for a 528-line file, chunked at 64 styles per round trip and
cancellable between chunks, entirely inside the worker.

## Known limitations

- The sample editor is a plain textarea. CodeMirror is in the dependency list for syntax highlighting and is
  not wired up yet.
- `IncludeCategories` and `RawStringFormats` are edited as JSON rather than through a dedicated editor.
- Nested struct fields are reachable from the option rail but not from a card in the card feed.
- There is no undo/redo yet; `Reset` clears all overrides.
- The catalog JSON is bundled into the main chunk (~60 KB gzipped of the 135 KB total). Moving it to a fetched
  asset would shrink first paint.
