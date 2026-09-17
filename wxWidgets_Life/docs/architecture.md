# Architecture

This page is for anyone who wants to read or change the code. It covers:
- how the layers fit together and who owns each piece of state;
- how a click becomes a redraw;
- why the simulation timer works the way it does;
- where the code is meant to be extended.

The design goals, in order: the code is easy to study, easy to extend, and fast enough. "Fast enough"
means a 1000 × 1000 world runs smoothly at every cell size from 1 to 100 px, and a 10000 × 10000 world
stays usable.

All numbers below were measured on the development machine unless marked otherwise: an i7-12800H
(a hybrid CPU with 6 performance and 8 efficiency cores, 20 threads), GCC 16, Release build.

## Layers

```
+--------------------------------------------------------------------------+
| app/     LifeApp (wxApp, owns the World), main.cpp          exe  wxlife  |
+--------------------------------------------------------------------------+
| ui/      MainFrame, WorldCanvas, ControlPanel, WorldSizeDialog,          |
|          SimulationRunner, MenuBar, CommandIds, Defaults,  lib wxlife_ui |
|          Theme, WxConvert                           (wx::core, wx::base) |
+--------------------------------------------------------------------------+
| render/  Types, Viewport, PixelBuffer, RenderStyle,                      |
|          Rasterizer                                    lib wxlife_render |
+--------------------------------------------------------------------------+
| core/    Types, Line, Rule, Grid, Random, ParallelBands, Stepper,        |
|          ReferenceStepper, StepKernel, BandedStepper, World,             |
|          WorldLimits, Speed, Pacer, Format   lib wxlife_core (+ Threads) |
+--------------------------------------------------------------------------+
tools/bench: wxlife_bench -> core
tests:       wxlife_tests -> core, render      wxlife_gui_tests -> ui
```

Each namespace (`life::core`, `life::render`, `life::ui`, `life::app`) has one directory and one CMake
target. The rules:

1. **`core`** uses only the standard library and threads.
   - It never reads a clock: the pacing functions take the time as an argument.
   - Its results depend only on its inputs. The number of threads never changes a result.
2. **`render`** uses `core`. It works in device pixels and never includes wx.
3. **`ui`** and **`app`** are the only layers that include `<wx/...>`. `app` needs only `<wx/app.h>`
   and `<wx/utils.h>`.
4. **`app`** holds the `wxApp` and the entry point.
5. **No layer includes a layer above it.** Two things enforce this:
   - Each layer's `CMakeLists.txt` links only the layers below it.
   - The `layering` test (`cmake/CheckLayering.cmake`) searches the include lines of `core`, `render`
     and `ui` for forbidden directories, in every spelling (`# include`, `<...>` or `"..."`).
6. **Include paths start at the layer directory,** for example `#include "core/World.hpp"`, so every
   include line shows which layer it uses.

The unit tests (`wxlife_tests`) link only `core` and `render`. Everything with real logic is below the
wx layer, so they need no display. The GUI smoke tests (`wxlife_gui_tests`) link `ui` and drive a real
`MainFrame`.

## Who owns what

Every other place that shows one of these values is only a view of it.

| State | Owner |
|---|---|
| Cells, rule, topology, engine, generation, population | `core::World`, held by `app::LifeApp` |
| Running flag, speed, pacing, measured rate | `ui::SimulationRunner`, a member of `MainFrame` |
| Cell size, scroll offset, grid-line flag, colours | `ui::WorldCanvas`, through `render::Viewport` and `render::RenderStyle` (colours from `ui/Theme.hpp`) |
| Random-fill density, rule text being edited, preset selection | The `ui::ControlPanel` widgets |
| Memory budget | `MainFrame`, computed once with `core::defaultMemoryBudget()` |
| Start-up values | `ui/Defaults.hpp` |

**Only two classes change the World,** and both run on the UI thread:
- `MainFrame` changes it in response to user commands: clear, randomize, `setCells`, resize, rule,
  topology and engine.
- `SimulationRunner` changes it by calling `World::step()`.

`WorldCanvas` only reads the World. It hands mouse strokes to `MainFrame` through its `paintCells`
callback.

**Lifetime.** `LifeApp` owns the World because wx destroys every window before it deletes the app
object. The World therefore outlives every window that holds a reference to it.
- Child windows are held through raw pointers that do not own them; wx deletes them.
- Everything else is held by value or through `std::unique_ptr`.

## The simulation (`core`)

**Storage.** A `Grid` is one byte per cell, with a one-cell *ghost border* around it.
- Neighbour sums therefore need no edge checks.
- Before every step, `Grid::updateBorder()` refreshes the border in O(width + height):
  - **Bounded:** the border is filled with dead cells.
  - **Torus:** the border gets copies of the opposite edges. The order of the copies matters: first the
    ghost columns of every row, then whole padded rows, so the four corners come out right.
- `World` holds two grids and swaps them after every generation, so stepping never allocates grid
  memory. (Starting the band threads still allocates; see Threads.)
- A world needs `worldBytes() = 2 × (W + 2) × (H + 2)` bytes.

**Rules.** A `Rule` is two 9-bit masks, one for birth and one for survival. Bit *n* is set when the rule
applies to a cell with *n* live neighbours.
- `Rule::parse()` is `constexpr`, so a typo in `kRulePresets` fails to compile.
- The kernel sums the 3 × 3 block *including* the centre cell. `Rule::kernelMasks()` therefore shifts
  the survival mask left by one, which removes a branch and a lookup table from the hot loop.

**Engines.** `Stepper` is the interface. `makeStepper()` builds an engine from a `StepperKind`,
`kStepperKinds` lists every kind, and `parseStepperKind()` reads a kind's name.
- **`ReferenceStepper`** counts the eight neighbours of every cell and applies explicit edge rules. It
  ignores the ghost border. It is slow on purpose: it is the executable specification and the test
  oracle.
- **`BandedStepper`** is the production engine:
  1. It splits the rows into bands with `suggestedBandCount()`: one band per 125,000 cells
     (`kMinCellsPerBand`), but a single band below 500,000 cells (4 bands' worth), and at most one band
     per hardware thread.
  2. It sizes one scratch row per band before any band starts, so the band jobs never allocate.
  3. It runs `kernel::stepRow()` on every row through `forEachBand()`.
  4. It adds up the band populations.
- **`kernel::stepRow()`** (`StepKernel.cpp`) is the only hot loop.
  - It has two passes: vertical 3-sums, then 3 × 3 sums and the mask lookup.
  - `target_clones` builds it for AVX2 and for baseline x86-64, and the dynamic loader picks the right
    one. This needs x86-64 and glibc (musl has no ifunc). With `WXLIFE_KERNEL_CLONES=OFF`, as in the
    `headless` preset, only the baseline version is built.
  - The file is compiled with `-O3` in every build type.

**Threads.** `forEachBand()` is the only code that creates threads.
- Band 0 runs on the calling thread and the other bands on `std::jthread`s. A band whose thread cannot
  be started runs on the calling thread instead.
- It returns only after every band has finished.
- Bands read `src` and write different rows of `dst`, so they need no locks.

Because every call joins its threads before it returns, the UI thread is the only thread that ever sees
the World. The UI therefore needs no synchronisation.

Starting the threads on every step keeps the code simple, and it is fast enough:

| World | Bands | ms per generation |
|---|---|---|
| 1000² | 1 | 0.30 |
| 1000² | 2 | 0.38 |
| 1000² | 4 | 0.22 |
| 1000² | default (8) | 0.16 |
| 10000² | 1 | 31 |
| 10000² | default (20) | 5.5 |

Two bands are slower than one. On this hybrid CPU a short-lived helper thread often lands on an
efficiency core, which is more than twice as slow (one band of 1000² takes 0.67 ms there and 0.29 ms on a
performance core), and every step waits for its slowest band. That is why `suggestedBandCount()` does not
split a world with fewer than 4 bands' worth of cells. Starting a helper thread also costs about 10 µs,
so at 1000² the 7 helpers take almost half of each step. A persistent thread pool avoids both costs: in
a prototype, even 2 bands were faster than 1 (see Extension points below).

**World operations.**
- **`step()`** is the only function that increments the generation.
- **`clear()`**, **`randomize()`** and **`resize(…, false)`** reset the generation to 0. Edits, rule,
  topology and engine changes leave it alone.
- **The population** is kept up to date incrementally: `step()` returns it, `setCells()` counts only
  the cells that actually change, and `randomize()` and `resize()` recount it.
- **`randomize()`** gives every row its own `SplitMix64`, seeded with a hash of the seed and the row
  number. The result is therefore the same for any number of bands, and the rows are independent even
  for small seeds.
- **`resize()`** allocates both new grids before it changes anything (the strong exception guarantee).
  With `keepPattern` it copies the overlapping block, centred.
- **`validateExtent()`** checks a size against the side limits (1 to 100,000) and the memory budget.
  The budget is a quarter of the RAM, clamped to [256 MiB, 16 GiB]. Under Linux's default memory
  overcommit, allocating a world within the budget practically never fails, so this check, not
  `std::bad_alloc`, is what keeps a world within the machine's memory.

**Timing values.**
- `Speed` is a plain value: 1 to 1000 generations per second, or unlimited.
- `GenerationPacer` turns elapsed time into generations owed.
- `RateMeter` measures the achieved rate over windows of at least 0.5 s. A window opens and closes only
  on ticks that stepped, so it always spans whole generations. There is no value until the first window
  has closed, and until then the status bar shows only the target.

The pacer and the meter take the time as an argument, so their tests never sleep.

## Rendering and the camera (`render`, `WorldCanvas`)

**Units.** Everything on the canvas is measured in *device* pixels (`render::Pixel`, 64-bit). A cell
size of 1 is therefore one physical pixel, even on a HiDPI screen. `render/Types.hpp` holds the pixel
types and `Rgb`, as `core/Types.hpp` does for cells.
- `WorldCanvas::deviceClientSize()` and `toDevice()` multiply wx's logical coordinates by
  `GetContentScaleFactor()`.
- The bitmap carries the same factor, so wx draws it 1:1 on the physical display.
- wx reports mouse positions in whole logical pixels, so at a scale factor of 2 the pointer maps only to
  even device pixels. Cells smaller than the scale factor can then be clicked only in every second row
  and column. Drawing is not affected.

**`Viewport`** is the camera, and the only source of truth for zoom and scroll position.
- **Offset.** `offset()` is the content pixel shown at the canvas's top-left corner. On an axis where
  the world is smaller than the canvas, `clampOffset()` centres the world, so the offset can be
  negative.
  Conversions between pixels and cells therefore use `floorDiv()`.
- **Anchored zoom.** `setCellSize()` keeps the world point under the centre of the anchor pixel inside
  that pixel (at most half a pixel off), so the cell under the anchor stays, unless clamping moves the
  view. It uses only integers. On each axis, zooms at the same anchor, with nothing else moving the
  camera in between, form a run that keeps the point of its first zoom (`zoomRuns_`). Rounding errors
  therefore never add up, and going back to a size restores its offset. Clamping an axis, which includes
  centring a world smaller than the canvas, ends that axis's run only.
- **Zoom steps.** `zoomBy()` moves along `kZoomSteps`.

**`Rasterizer::render()`** fills a `PixelBuffer` the size of the canvas. Its cost depends only on the
number of canvas pixels, never on the size of the world.
1. Once per frame it builds four cell *stamps* (alive or dead, each with or without a major grid-line
   pixel) and two grid-line rows.
2. For each visible cell row, it writes the first visible pixel row from the stamps. It then copies
   that pixel row down the rest of the cell. When grid lines are shown, the cell's last pixel row gets
   a grid-line row instead.
3. At 1 px per cell it uses a two-colour palette instead of stamps.

Grid lines use the last pixel column and row of each cell, and they appear only from 5 px. A crossing
uses the major colour when either of the two lines is major.

The rasterizer is compiled with `-O3` in every build type. Its times, in ms per frame, for a 25% random
10000² world with grid lines on:

| Canvas | 1 px | 2 px | 5 px | 100 px |
|---|---|---|---|---|
| 1080p | 1.4 | 1.0 | 0.3 | 0.15 |
| 4K | 5.8 | 4.4 | 1.5 | 0.7 |

**`WorldCanvas::onPaint()`** draws the frame.
1. It wraps the frame's bytes in a `wxImage` without copying them.
2. It converts the image to a `wxBitmap` that carries the scale factor, and draws it with one
   `DrawBitmap`.

That blit costs 2.2 ms at 1080p and 9.1 ms at 4K; converting GTK's pixbuf to a cairo surface takes
most of that time. Writing through `wxNativePixelData` directly was measured and is no faster.
- There is no erase step (`wxBG_STYLE_PAINT`) and no `wxBufferedPaintDC`: GTK 3 already double-buffers.
- Every redraw request is `Refresh(false)`, and GTK's frame clock merges the requests into at most one
  paint per display frame.

**Scrollbars.** The canvas is a plain `wxWindow` with `wxALWAYS_SHOW_SB`. `wxScrolledWindow` would not
work: its virtual-size model cannot express anchored zoom or the negative offset of a centred world.
- Scrollbar units are device pixels. `syncScrollbars()` pushes the viewport into them, and `onScroll()`
  maps the scrollbar events back.
- Scrollbars that are always shown keep the client size stable. With automatic scrollbars, the client
  size was measured changing without any size event.

**Fit.** `fitWorld()` fits the world into the canvas and *keeps* it fitted (`keepFitted_`) until the
user moves the camera (`cameraMoved()`).
- The window gets its final size, and under Wayland its final scale, only after the first frame. A
  one-time fit would therefore use the wrong size.
- `worldExtentChanged()` fits again after every resize.

## From a click to a redraw

Every command except Quit and About (which use wx's stock ids) is a `CommandId`. Camera moves and
strokes are not commands; they stay inside `WorldCanvas`.
- Menu items send their id.
- Panel controls re-send their own events as ids (`sendOn()` in `ControlPanel.cpp` calls
  `emitCommand()`).
- The canvas's single-key shortcuts call `emitCommand()`.

Command events travel up the window tree, so all of them reach `MainFrame`. `MainFrame::bindCommands()`
is the one table that maps ids to handlers. After a command from a panel button or check box, clicked or
pressed from the keyboard (except Apply), it gives the focus back to the canvas, because GTK leaves it on the clicked control and Space
would press that control again.

```
[Run] click → wxEVT_BUTTON on the button → emitCommand(ID_RUN_PAUSE)
  → wxEVT_MENU propagates: button → static box → ControlPanel → MainFrame
  → MainFrame::onRunPause → runner_.toggle() → syncControls() → updateStatusBar(true)

timer tick → SimulationRunner::onTimer → pacer_.plan(now) → world_.step() × N
  → pacer_.commit(N), meter_.record(N, now) → MainFrame::onSimulationTick
  → canvas_->Refresh(false) + updateStatusBar(false) → scheduleNext() (idle gap ≥ 4 ms)

GTK frame clock → WorldCanvas::onPaint → syncCanvasSize()
  → Rasterizer::render(world.cells(), viewport, style, frame)
  → wxImage (borrowed bytes) → wxBitmap(image, depth, scale) → DrawBitmap

left drag → WorldCanvas::onMouse → continuePaint → Viewport::cellAtClamped → forEachCellOnLine
  → callbacks_.paintCells(segment, value) → MainFrame::onPaintCells → world_.setCells
  → worldContentChanged() → canvas_->Refresh(false) + updateStatusBar(true)

Ctrl+wheel → WorldCanvas::onWheel → Viewport::zoomBy(steps, pointer) → cameraMoved()
  → viewportChanged() → syncScrollbars(), Refresh(false), callbacks_.viewChanged
  → MainFrame::onViewChanged → panel_->setCellSize(), updateStatusBar(true)

G key on the canvas → WorldCanvas::onKeyDown → emitCommand(ID_TOGGLE_GRID)
  → the same MainFrame::onToggleGrid as the menu item and the check box
```

**Strokes.**
- A press paints the pressed cell at once. Every later mouse motion paints the line from the previous
  cell to the cell under the pointer, as one segment and one edit, so fast drags leave no gaps.
- When the camera moves during a stroke (fit, centre, zoom, wheel, arrow keys, scrollbars),
  `viewportChanged()` forgets the previous cell. The next motion then paints only the cell under the
  pointer and goes on from there, so no line crosses cells the pointer never touched.
- The canvas captures the mouse for the whole drag. Only the release of the button that started the drag
  (`dragButton_`) ends it.
- The capture is released in one place, `endDrag()`, which also handles capture loss, Esc and
  `cancelStroke()`. Ending a stroke keeps the cells it has painted.

**Resizing the world** (`MainFrame::onWorldSize`):
1. Remember whether the simulation was running, stop it, and cancel any stroke.
2. Call `WorldSizeDialog::ask()`, passing the current size, `cellsThatFit()` for the "Fit window"
   preset, and the budget. The dialog checks the typed text of both boxes, not `wxSpinCtrl`'s clamped
   value, and its `Validate()` refuses OK and Enter until the size is valid.
3. Check the size again with `validateExtent()`. Inside a `try` block, call `world_.resize()`, then
   `canvas_->worldExtentChanged()` at once, so no paint ever sees a viewport with the old extent. On
   `std::bad_alloc`, show a message: the old world is still intact. (Under Linux's default overcommit
   this is rare; see `validateExtent()` above.)
4. If the Reference engine is active and the world is now larger than
   `ReferenceStepper::kRecommendedMaxCells`, switch to Banded.
5. Restart the simulation if it was running, then call `syncControls()` and `updateStatusBar(true)`.

**Keeping the controls in step.**
- `syncControls()` pushes model values into the panel and the menus: check marks, the enabled state of
  the Reference engine, and the Run/Pause label.
- The panel's setters use `SetValue`, `SetSelection` and `ChangeValue`, which send no events, so there
  are no feedback loops.
- `syncControls()` never touches the rule text, so text the user is still typing survives.

**Status bar.**
- Simulation ticks update it at most once per `defaults::kStatusRefresh` (100 ms).
- Every user action forces an update, so the display is never stale while paused.
- The speed field shows the target. While the simulation runs, the measured rate follows once
  `RateMeter` has one.

**Start-up** (`LifeApp`):
1. `Initialize()` sets `GTK_OVERLAY_SCROLLING=0`, unless the user has already set it. This has to happen
   before `wxApp::Initialize()` starts GTK, which starts other threads, and `setenv()` is not
   thread-safe.
2. `OnInit()` parses the command line.
3. It creates the World (512², torus, Conway).
4. It creates the `MainFrame`. Its constructor sets up the menus, the status bar, the layout and the
   command table, sets the speed, randomizes the World, syncs the controls, calls `fitWorld()` and gives
   the canvas the focus.
5. It shows the frame. The simulation starts paused.

**Shutdown.**
1. `MainFrame::onClose` stops the runner and cancels any stroke. wx asserts if a window is destroyed
   while it holds the mouse capture.
2. wx destroys the windows, then the app object, which deletes the World last.

## The timer and redraw priority

`SimulationRunner` owns the only timer. The timer is **one-shot**: it is re-armed at the end of every
tick, always leaving at least `kMinIdleGap` (4 ms) of idle time before the next tick. A repeating timer
does not work here.

**Why a repeating timer fails.**
- wxGTK's `wxTimer` is a GLib timeout at the default priority (0).
- GTK repaints at `GDK_PRIORITY_REDRAW` (120). In GLib a lower number wins, so the timer always goes
  first.
- A repeating timer whose handler takes longer than its interval is always ready, so GTK never gets to
  repaint.

The effect was measured headlessly:

| Timer | Work per tick | Result |
|---|---|---|
| Repeating, 16 ms | 20 ms | **0 repaints in 2 s** |
| One-shot, re-armed with a gap of at least 4 ms | 20 ms | 82 repaints in 83 ticks |
| Either kind | 10 ms | About 60 ticks per second |

The idle gap therefore costs no throughput.

**The tick loop** (`SimulationRunner::onTimer`):
1. `GenerationPacer::plan()` adds the elapsed time × rate to the debt of generations owed.
2. The runner steps until it has done every whole generation owed, or until `kTickBudget` (10 ms)
   has passed. When a generation is owed, it takes at least one step, even if that step alone takes
   longer than the budget.
3. `commit()` subtracts the generations stepped.
4. The runner reports to `MainFrame` and re-arms the timer after `max(4 ms, 16 ms − tick cost)`.

The debt is capped at 250 ms worth of generations (`kMaxCatchUp`). A stall, such as a modal dialog, is
therefore not followed by a burst of catch-up steps. When ticks run out of time, the rate settles at
whatever the machine can manage. A paused app uses no CPU, because the timer is not armed.

**Rates this gives:**

| Case | Generations per tick | Result |
|---|---|---|
| Target under about 60 gen/s | 0 or 1 | One repaint per generation |
| 1000², Max | About 60 (10 ms ÷ 0.16 ms) | One repaint per tick, about 60 per second (estimated) |
| 10000², Max | 2 (about 5.5 ms each) | Measured headlessly: 90 to 116 gen/s at 43 to 50 repaints per second; input stays responsive |
| One generation takes 10 ms or more (here from about 14000², 200 million cells) | 1 | Fewer repaints, but input is still handled between ticks |

The last row is the limit of stepping on the UI thread. Background stepping is an extension point.

## wx and GTK pitfalls handled in the code

| Pitfall | Where it is handled |
|---|---|
| wxGTK keeps the C locale, so an implicit `std::string` → `wxString` conversion breaks "×" and "·" | All non-ASCII text goes through `toWx()` (`WxConvert.hpp`) |
| `~wxMenuBar` leaves the frame's pointer to it dangling, so `DestroyChildren()` in a frame destructor deletes the menubar twice | `MainFrame` has no destructor |
| `wxTextCtrl::SetValue` sends an event | `ControlPanel::setRule` uses `ChangeValue` |
| `SetLabel` treats `&` as a mnemonic | Error lines use `SetLabelText` |
| A wheel event passed on with `Skip()` also scrolls GTK's scrolled window | `WorldCanvas::onWheel` never calls `Skip()` |
| A canvas that takes keys can swallow menu accelerators | `onKeyDown` calls `Skip()` when `HasModifiers()` is true (Ctrl or Alt) and for unknown keys |
| GTK's scrolled window around the canvas binds Ctrl+Home, so the Center World accelerator never fires while the canvas has the focus | `onKeyDown` handles Ctrl+Home itself. Text and number boxes keep Ctrl+Home and Ctrl+Delete, because GTK gives them the key before the accelerators. |
| wxGTK turns Ctrl+M into Enter inside a text box, which would apply the rule | `MainFrame`'s `wxEVT_CHAR_HOOK` handler, which runs before any control, sends Max Speed |
| Key-down events report punctuation as on a US layout, and AltGr as Ctrl+Alt | `]`, `[`, `+`, `=` and `-` are matched by character in `WorldCanvas::onChar()`, which accepts AltGr |
| GTK leaves the focus on a clicked button or check box, and Space presses it again | `MainFrame::bindCommands()` gives the focus back to the canvas |
| GTK changes sliders, number boxes and choices under the wheel even when they have no focus | `ControlPanel` consumes those wheel events unless the control has the focus |
| On Enter in a text box, wxGTK presses a dialog's OK button even while it is disabled | `WorldSizeDialog` overrides `Validate()`, which wx asks before it accepts a dialog |
| `wxSpinCtrl::GetValue()` silently clamps what was typed | `WorldSizeDialog` parses `GetTextValue()` |
| The desktop can switch between light and dark while the app runs | `WorldCanvas` and `useErrorColour()` (`ui/Theme.hpp`) handle `wxEVT_SYS_COLOUR_CHANGED` |
| wx asserts when a window is destroyed while it holds the mouse capture | `onClose` calls `cancelStroke()`; `endDrag()` releases the capture only if `HasCapture()` |
| wxGTK sends the second press of a quick double click only as a double-click event | `WorldCanvas` also binds the three `*_DCLICK` events and treats them as presses |
| GTK overlay scrollbars make the client size wx reports differ from the area GTK gives the canvas | `LifeApp::Initialize()` sets `GTK_OVERLAY_SCROLLING=0` before GTK starts |
| A scrollbar range smaller than one page makes GTK (Adwaita) shade the canvas edges | `syncScrollbars()` uses a range of at least one page |
| The client size can change without a size event, for example when the display scale changes | `onPaint` compares sizes, updates the viewport, and uses `CallAfter` for the rest |
| wx's generic status bar repaints synchronously after every text change. Under X11 that paint can come before GTK has moved a slider changed in the same handler, and the slider keeps its old position. | `MainFrame.cpp` installs a `StatusBar` subclass whose `DoUpdateStatusText()` only refreshes the field |
| wx blanks the first status field to show menu help | `SetStatusBarPane(-1)` |

## Testing

- **`StepperTest`** compares `BandedStepper` with `ReferenceStepper`, grid for grid, over:
  - sizes from 1 × 1 to 1013 × 777;
  - every preset, B0/S8 and random rules (fewer rules at the two largest sizes);
  - every topology in `kTopologies`;
  - 1, 2, 7 and 64 bands (fewer when the world has fewer rows or cells).
  
  It also checks known patterns (still lifes, oscillators, gliders) with every engine in `kStepperKinds`.
- **`RasterizerTest`** compares every pixel with a small independent reference: every cell size from 1
  to 100, and 1500 random scenes. Hand-drawn text-art frames cover the special cases.
- **`ViewportTest`** checks anchored zoom for every pair of zoom steps and every anchor position inside
  a cell against a floating-point reference, checks that zooming there and back restores the offset,
  and compares `cellAt` and `visibleCells` with brute-force results.
- **Other suites.** The rest of `core` (worlds, rules, grids, lines, bands, random numbers, limits,
  speed, pacing and the rate meter, formatting) has its own suites. `tests/support/AsciiGrid.hpp` lets
  tests write patterns as text, such as `".O."`.
- **`GuiSmokeTest`** (`wxlife_gui_tests`, CTest label `gui`) opens a real `MainFrame` per test. It sends
  commands with `emitCommand()` and synthetic wx events to the controls, the canvas and the scrollbars,
  types into number boxes through GTK, and answers dialogs with a `wxModalDialogHook`. The tests run one
  at a time. They are skipped when no display is configured, and they fail when a configured display
  cannot be opened.
- **Checks outside GoogleTest.** CTest also runs `layering` and `static_link` (`ldd wxlife` must list
  no wxWidgets library). Configuring already fails if `wx::core` or `wx::base` is not the static library
  built from the fetched sources.
- **Presets.** The `headless` preset builds the kernel without clones, so its tests cover the baseline
  loop; the other presets use the AVX2 clone on CPUs that have AVX2. The `asan` preset runs every test,
  with leak detection off for the GUI tests (GTK leaks at exit by design), and UBSan stops at the first
  error (`-fno-sanitize-recover=all`). The `tsan` preset has no UI. Under both sanitizers,
  `WorldTest.FailedResizeLeavesTheWorldUnchanged` reports itself as skipped: their allocators abort
  instead of throwing `std::bad_alloc`.
- **Manual checks.** The GUI smoke tests bypass GTK's own key and mouse handling, so the README keeps a
  manual smoke checklist for those paths.

## Extension points

| Future feature | What already exists | What would change |
|---|---|---|
| More B/S presets | `kRulePresets` | One line per preset. The parser is `constexpr`, so a typo fails to compile. |
| New engines (bit-packed rows, explicit SIMD, skipping empty rows) | `Stepper`, `StepperKind`, `kStepperKinds`, `makeStepper()`, `kernel::stepRow()`, `wxlife_bench --engine` | Add a class, an enum value, a `kStepperKinds` entry and a `makeStepper()` case. `-Wswitch` then points at the other switches that need a case: `toString(StepperKind)`, the benchmark's `bandCount()` and `engineMenuItem()` in `MainFrame.cpp`. The pattern tests in `StepperTest` pick the engine up from `kStepperKinds`; add it to the comparison with `ReferenceStepper` there. In the UI: a `CommandId`, a radio item in `buildMenuBar()` and a handler row in `bindCommands()`. |
| Persistent thread pool | `forEachBand()` is the only code that creates threads | Replace its body; nothing else changes. A quick prototype pool stepped 1000² in 0.15 ms with 2 bands (0.38 ms with threads started per step) and in 0.09 ms with 4, so `suggestedBandCount()` could then split smaller worlds too. |
| Background stepping (worlds of more than about 200 million cells on this machine) | `SimulationRunner` is the only caller of `World::step()`, and painting reads only `World::cells()` | Step a copy on a `std::jthread` and hand finished grids to the canvas. This stays inside `ui/`, plus a small `core` helper. |
| Other rule families (Generations, Larger than Life) | Only the steppers interpret a `Rule`; the rest of the code only parses, prints and compares it. `Cell` is a byte. | Make `Rule` a `std::variant` and give each family its own stepper, plus a case in `Rule::toString()`, `findPreset()` and the preset list. The rasterizer would need colours for the extra states. |
| Other topologies (cylinder, Klein bottle) | `Topology` and `kTopologies`. `-Wswitch` lists the `core` code that needs a case: `toString(Topology)`, `Grid::updateBorder()` and the `alive` lambda in `ReferenceStepper::step()`. | Add an enum value, a `kTopologies` entry and a copy rule; `StepperTest` and `WorldTest` then cover it. The Wrap Edges toggle in `MainFrame` would become a choice. |
| Sparse or infinite worlds, HashLife | The UI uses only `World`'s public interface | Extract an interface from `World` once a second implementation exists. `Rasterizer::render()` takes the dense `Grid` from `World::cells()`, so it would read cells through the new interface too. `Viewport` would need an unbounded extent. |
| Zooming out below 1 px, a minimap | `Viewport` (`int` cell size) and `Rasterizer` | Replace the cell size with a scale type, and add a downsampling path. |
| Pattern files (RLE, plaintext) | `core` has no wx dependency | Add a new `core` reader that returns `std::expected`, a `World` stamping function, and File → Open/Save. |
| Undo/redo, selection | Every edit enters through a `CommandId` or through `paintCells` → `MainFrame::onPaintCells()` | Let `World::setCells()` report the changed cells, and add an undo stack in `ui/`. |
| Themes, saved settings | `RenderStyle`, `darkStyle()`/`lightStyle()`, `ui::defaults` and `Speed` are plain values. Only `ui/Theme.hpp` (`themeStyle()`, `useErrorColour()`) picks colours from the desktop theme. | Load and save them with `wxConfig` in `LifeApp`. A user theme would replace the choice in `ui/Theme.hpp`. |
| Parallel rasterizer, OpenGL canvas | `Rasterizer::render()` (pixel rows are independent); `WorldCanvas::onPaint()` is the only blit | Use `forEachBand()` over pixel rows, or add a `wxGLCanvas` variant (turn `wxUSE_OPENGL` back on). |
| Statistics, history plots | `MainFrame::onSimulationTick()` receives every `TickReport` | Subscribe there. |
| Command-line batch runs | `wxlife_bench` links only `core` | Add a `wxlife_cli` next to it. |

## Suggested reading order

1. `core/Rule.hpp`: the B/S masks, the `constexpr` parser and the presets.
2. `core/Grid.hpp`, `core/Grid.cpp`: the ghost border and the torus copy order.
3. `core/ReferenceStepper.cpp`: the executable specification.
4. `core/StepKernel.cpp`: the only hot loop.
5. `core/ParallelBands.hpp`, `core/BandedStepper.cpp`: the parallel bands.
6. `core/World.hpp`, `core/World.cpp`: the model, its counters and its edits.
7. `core/Pacer.hpp`, `core/Pacer.cpp`: turning wall time into generations.
8. `render/Viewport.hpp`, `render/Viewport.cpp`: the camera, clamping and anchored zoom.
9. `render/Rasterizer.cpp`: cell stamps and row copying.
10. `ui/SimulationRunner.cpp`: the one-shot timer.
11. `ui/WorldCanvas.cpp`: painting, scrollbars, mouse and keys.
12. `ui/MainFrame.cpp`: the command table, syncing the controls, and the status bar.
