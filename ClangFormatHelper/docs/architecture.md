# Architecture

## The two rules

Everything else follows from these.

1. **`src/core/` is framework-free.** No React, no CodeMirror, no DOM, and — importantly — no wasm. The engine
   reaches clang-format only through `FormatterPort` and clang-tidy only through `TidyPort`.
2. **Variation lives in registries, not in conditionals.** There are three: languages, layouts, and tools.

Both are enforced by `tests/architecture/layering.test.ts` rather than by this document, because a document
nobody re-reads is not an architecture. Same idea as the layering check in the sibling `wxWidgets_Life` project.

| Layer        | May import                                                | Never                                         |
| ------------ | --------------------------------------------------------- | --------------------------------------------- |
| `src/core`   | `src/core/**`, `src/worker/protocol`                      | react, codemirror, `@wasm-fmt/*`, `@bjorn3/*`, `src/ui` |
| `src/worker` | `src/core/**`, `@wasm-fmt/*`, `@bjorn3/*`                 | react, `src/ui`                               |
| `src/ui`     | `src/core/**`, `src/ui/**`, `src/worker/{,tidy/}{protocol,client}` | `@wasm-fmt/*`, `@bjorn3/*`, the worker internals |

The "UI must not import the wasm" rule is not cosmetic: doing so installs a second module in the main thread's
realm — 2.5 MB for clang-format, 43 MB for clang-tidy — and costs a second compile. (`@bjorn3/browser_wasi_shim`
is the WASI implementation clang-tidy runs on; it is only ever needed next to the module.)

`FormatterPort` is what makes the engine testable. The app injects a Worker-backed implementation; the tests
inject one that drives the same `createRuntime` directly in Node. So the impact engine's tests run against the
real binary with no browser, no bundler and no mocks. `TidyPort` is the same arrangement for clang-tidy, with a
worker pool behind it in the app and `createTidyRuntime` driven directly in the tests.

## The tool registry

The third registry. A *tool* is a config file the app helps build — `.clang-format` or `.clang-tidy` — and each
supplies components for a fixed set of slots (`ToolPanels` in `src/ui/tools/registry.tsx`): the settings rail, the
card feed, the sample, the result, the diff, the documentation, the file, its toolbar controls, its analysis
status, and a gate shown until it is ready. Layouts arrange slots and never ask which tool fills them, so all three
layouts serve both tools with no tool-specific code in any of them.

State splits along the same line. The shared store keeps what both tools look at — which tool, the language, the
sample, the layout, the theme — so switching tools keeps your code. Each tool's own state lives in its own store
(`store.tsx` for clang-format, `tidyStore.tsx` for clang-tidy), and the Tidy store costs nothing until Tidy is
first opened: its 1.2 MB catalog is a dynamic import and its workers start on first activation.

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

## The clang-tidy engine

### Running clang-tidy in a browser

There is no WebAssembly clang-tidy to download, so `tools/clang-tidy-wasm/` builds one: clang-tidy 23.1.1 with every
module and the static analyzer, cross-compiled for WASI with wasi-sdk (the recipe and its trade-offs are in that
directory's README). It runs on `@bjorn3/browser_wasi_shim`, a small JavaScript WASI implementation with an
in-memory filesystem, which means the browser Worker and the Node tests run the same runtime.

- **One instance per run.** clang-tidy is a WASI *command*: `main`, then exit. It cannot be re-entered, because
  LLVM's command-line options are process-wide globals that refuse to be parsed twice. So every run instantiates the
  already-compiled module afresh — milliseconds, against a run of hundreds — and nothing can leak between runs.
- **Headers are a tarball, not a bundle.** The analyser needs the C and C++ standard headers: musl, libc++, and
  clang's own. They ship as a 22.8 MB plain tar (1.7 MB brotli) that the worker unpacks into the in-memory
  filesystem once, as views into the downloaded buffer rather than copies.
- **Code is analysed as x86_64 Linux,** not as the WebAssembly it runs on — see the build README for why.
- **Diagnostics come from `--export-fixes`,** not the text output. The YAML is structured by construction — check
  name, level, position and fix-it replacements for every diagnostic, fix or no fix — so nothing is scraped from
  messages. Its offsets are UTF-8 bytes; `core/tidy/diagnostics.ts` converts them to JavaScript string indices, and
  a test proves applying the result gives byte-for-byte what clang-tidy's own `--fix` writes, on text full of
  multi-byte characters.
- **Missing headers are stood in for.** See `core/tidy/includes.ts`: a header the sysroot cannot supply becomes an
  empty file searched last (`-idirafter`), so a real header of the same name always wins, and the UI names the ones
  it had to invent.

### What the analysis asks, and how it keeps the run count down

The format side measures impact by brute force, one format per candidate value, because a format costs half a
millisecond. A clang-tidy run costs about a second on a real C++ file — it parses the whole translation unit,
standard headers included — so the Tidy analysis is built around making each run answer many questions:

- **The survey** runs every check at once and reads each check's findings and fixes out of the one result. One
  run answers "what would each of 602 checks do to this code".
- **The option sweep** relies on a check's options affecting only that check. Run *k* gives every check its *k*-th
  candidate value at once, and each check is compared with its own findings from the survey. The run count is the
  largest number of candidates any one check has — capped at 12 — rather than the ~300 candidates in total.
- **Runs are spread over a pool of up to four workers,** with interactive work (the live run after an edit, config
  queries) always ahead of queued analysis runs. An edit waits for at most one run in flight, never for a sweep.

Two clang-tidy behaviours would quietly distort "run everything at once", and the engine works around both:

- **An alias and its target are deduplicated by name.** When both report the same thing clang-tidy keeps the one
  whose name sorts first, so with everything on, `readability-magic-numbers` looks silent because
  `cppcoreguidelines-avoid-magic-numbers` took its findings. The survey runs primary checks only and credits each
  alias with its target's findings.
- **Overlapping fixes from different checks are both dropped,** with a note saying so. With 540 checks on, that
  happens a lot, and a check's fix preview would come out empty through no fault of its own. Checks that lost fixes
  are re-run in a few small rounds, grouped so checks that fired on neighbouring lines are kept apart. The same
  effect would also fool the sweep, whose rounds run a different set of checks from the survey's — a fix that was
  dropped in one and not the other is not the option's doing — so fix comparison looks only at findings whose fixes
  survived on both sides.

Measured in Firefox on the 286-line kitchen sink: 2.9 s from switching to Tidy to the first findings (boot
included), 7.2 s for the whole analysis — survey, fix recovery, and 12 sweep rounds.

### The catalog

`scripts/generate-tidy-catalog.ts` joins two sources with a strict division of labour. clang-tidy's documentation
at the pinned tag says what each check and option is *for*: ~570 hand-written pages, parsed for summaries, prose,
examples and aliases. The **binary** says what exists and how it behaves:

- every check, from `--list-checks` — including 34 static-analyzer checkers the docs never list;
- every option's default, from `--dump-config`;
- every option's **type**, by setting every option of every check to a value nothing accepts, in one run, and
  reading the complaints: "expected a bool", "expected an integer", a bare rejection for an enum, and silence for
  free text. Candidate enum values, scraped generously from the docs, are then kept only if the binary accepts them
  — again batched, one round per candidate index.

`npm run tidy-catalog:check` runs in the build, offline, and fails if the check list, any dumped default, or the
default `Checks` line has drifted from the vendored binary.

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

And on the clang-tidy side:

**"clang-tidy enables the static analyzer by default."** It used to. In 23.1.1 the default `Checks` is only
`clang-diagnostic-*`, and a file's own `Checks` are *appended* to it — which is why the app reads the default from
the binary into the catalog instead of writing it down.

**"Every enabled check shows up in `--list-checks`."** Compiler diagnostics (`clang-diagnostic-*`) never do, and
with nothing else enabled it prints `No checks enabled.` and exits non-zero rather than printing an empty list.

**"A bool option comes back as `true` or `false`."** Several checks read a bool but store an integer, so
`--dump-config` reports `1` for an option set to `true`. Values are compared the way clang-tidy parses them
(`parseTidyBool`), or every such override would look rejected.

**"A value clang-tidy cannot parse gets a warning."** Almost always. The generator's probe crashed the binary
outright — natively as well as in WebAssembly — and bisection found the one option responsible:
`bugprone-suspicious-missing-comma.RatioThreshold`, parsed with `std::stod`, which throws in a program built without
exceptions. It is marked `fragile` in the catalog, the probe routes around it, and the UI only ever sends it a
number.

**"A missing `#include` is just an error."** It is a *fatal* error, and clang suppresses every compiler diagnostic
after one. Hence the empty stand-ins.

**"The WASI shim's debug logging is off unless you ask for it."** The reverse: an absent `debug` option means *on*,
and it logs every failed header lookup — thousands of lines per run.

**"`-O3` is worth it for a compute-heavy module."** 3–5% faster per run and 36% larger. The download is paid by
every visitor; the speed difference is not noticeable. `MinSizeRel` it is.

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

**Prerequisites are switched on rather than reported as "no effect".** A large family of options is inert not
because your code lacks the construct but because a parent feature is off: nothing under `BraceWrapping.*` does
anything unless `BreakBeforeBraces: Custom`, and the `AlignConsecutive*` modifiers do nothing unless that
family's own `Enabled` is true. Calling those "no effect on your code" is simply false, and it hid 40-odd
options. The sweep now applies the prerequisite alongside the candidate and records what it assumed, which the
UI surfaces.

That in turn requires **a baseline per assumption set**. Comparing a prerequisite-laden candidate against the
plain baseline would attribute the prerequisite's own reformatting to the option under test, so every option
downstream of a newly-enabled feature would look falsely live. Each distinct set of assumptions gets its own
reference formatting first, and candidates are compared against that.

Results carry a **witness**: the candidate that changed the most, plus a small hunk. The card feed's
micro-previews are that witness, so they cost nothing extra.

Cost, measured: ~250 ms for a small sample, ~4.5 s for a 528-line file, chunked at 64 styles per round trip and
cancellable between chunks, entirely inside the worker.

## Syntax highlighting

Every code surface is highlighted — the sample editor, the formatted output, both sides of the diff, the
documentation examples, and the per-option previews in the card feed.

None of them is a CodeMirror editor. The card feed renders a before/after preview for *every* option, so the
view count is in the hundreds and editor instances would not survive it. Instead `src/ui/highlight/` parses
with the same Lezer grammars CodeMirror uses and emits plain spans carrying Lezer's standard `tok-*` classes,
which cost about a millisecond for a 130-line document and render as ordinary markup.

Two consequences worth knowing:

- **Each document is parsed once as a whole**, not line by line, and the resulting spans are then split at line
  boundaries. Parsing per line would break anything that spans lines — block comments, raw strings — and a
  three-line comment would come out as three unrelated fragments. There is a test for exactly that, alongside
  the invariant that matters most: highlighting must not lose or reorder a single character.
- **Grammars load on demand.** Together they are ~125 KB gzipped, which would otherwise be most of the main
  bundle. Highlighting is the one feature here that degrades gracefully, so code renders unstyled until its
  grammar arrives and then repaints via `useGrammar`.

The editable sample is a transparent `<textarea>` over a highlighted copy of the same text. Keeping a real
textarea preserves native editing — selection, undo, IME, accessibility — and avoids pulling in an editor. The
catch is that both layers must agree on every metric or the caret drifts from the glyphs, so font, size, line
height, padding and tab size are set once in a shared `.editor-layer` rule, and the browser test asserts the
two layers report identical content heights.

## Theming

Light and dark are selectable (`Match system` / `Light` / `Dark`), defaulting to the OS preference.

Every colour token is declared once as `light-dark(lightValue, darkValue)` and resolves against the root's
`color-scheme`, so the whole theme switches on one property:

```css
:root { color-scheme: light dark;  --bg: light-dark(#ffffff, #16181d); /* ... */ }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark; }
```

This replaced a duplicated `@media (prefers-color-scheme: dark)` palette. Two reasons it is better than swapping
custom properties:

- **One definition per colour.** A duplicated block drifts — someone adds a token to one half and not the other.
- **Native UI follows.** `color-scheme` is what tells the browser to render dropdowns, checkboxes, the caret and
  scrollbars dark. Custom properties cannot reach any of those, so a variable-swap theme leaves white
  scrollbars and light dropdowns behind.

The cost is that `light-dark()` needs a 2024-era browser. That is already true of everything else here
(WebAssembly, ES modules in workers), so it is not a new constraint.

The stored choice is applied by a small inline script in `index.html` *before* the stylesheet paints, otherwise
a dark-mode user gets a white flash on every load. The browser test asserts `data-theme` is already set at the
`load` event, which is the only way to catch that regression — it is invisible to any assertion made afterwards.
Choosing `Match system` deletes the attribute rather than pinning the current preference, so the OS stays in
charge from then on.

## Option ordering

The rail is **statically ordered**: groups in a fixed reading sequence (`GROUP_ORDER` in
`src/ui/hooks/ordering.ts`), options alphabetical within each. A row's position is a function of the catalog
alone, so nothing you do to a value can move it.

That replaced a weighted sort that ranked by impact and pushed anything overridden to the top. It read well in
a screenshot and was horrible to use: the row you were editing jumped out from under the cursor the moment you
touched it. A settings list you cannot build muscle memory for is worse than one that is merely unsorted.

Ranking by impact survives as an opt-in `Order` mode, and it is stable under editing as well. That required the
second half of the fix: **an edit marks the impact results stale instead of discarding them**. Discarding meant
every row's rank collapsed to nothing on each keystroke, which reshuffled the entire rail — and it threw away
information the user had waited seconds for. Stale figures are dimmed and the toolbar says "out of date"; only
a change of *language* invalidates them outright, since that swaps the code being measured.

The comparators are pure functions rather than logic inside the hook, so the property that matters is directly
testable: `compareRows` in static mode takes no notion of which options are overridden, so there is nothing an
edit could perturb. The browser test checks the same thing end to end, by recording all 193 row names, toggling
one in the middle, and asserting the sequence is byte-identical afterwards.

## Samples

The sample library is teaching material, not filler: an option the sample never exercises can only report "no
effect on your code", which is true and useless. So sample breadth is treated as a tested property.

`tests/core/languages/samples.test.ts` asserts the constructs are present *by measuring clang-format*, not by
grepping for keywords — "the sample contains a union" is expressed as "`BraceWrapping.AfterUnion` changes this
sample". That catches someone trimming the sample without noticing what it cost.

The C++ and C samples are kept as real, compilable translation units: each was checked with
`clang++ -fsyntax-only -std=c++20` (and `clang -std=c17`) before being embedded, and they are embedded verbatim
via `String.raw` so no escaping can quietly corrupt them. C++ developers will read this code closely, and code
that does not compile would undermine the whole tool.

## Known limitations

- clang-tidy analyses one file with the flags you give it. There is no compilation database, so project include
  paths and macros are whatever you pass in *Flags*; headers it cannot find are stood in for.
- The option sweep skips `readability-identifier-naming`'s ~270 per-kind settings (they do not fit its per-check
  budget, and are chosen by intent rather than discovered) and does not probe free-text options at all.
- `CustomChecks` (clang-query based, experimental) can be imported and exported but not edited.

- `IncludeCategories` and `RawStringFormats` are edited as JSON rather than through a dedicated editor.
- Nested struct fields are reachable from the option rail but not from a card in the card feed.
- There is no undo/redo yet; `Reset` clears all overrides.
- The catalog JSON is bundled into the main chunk (~60 KB gzipped of the 135 KB total). Moving it to a fetched
  asset would shrink first paint.
