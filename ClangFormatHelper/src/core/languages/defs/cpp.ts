import type { CodeSample, LanguageDefinition } from '../types.ts';

/**
 * Sample library for C and C++.
 *
 * These carry more weight than they look like they should. Measured during
 * design: a toy snippet is affected by only 16 of ~170 tweakable options, while
 * a real 522-line source file is affected by 33 — and 27 of those affect no toy
 * snippet at all. A thin sample makes most of the option surface look inert and
 * quietly misleads the user, so each sample below is built around a named set of
 * constructs and tagged with what it exercises.
 */

const kitchenSink: CodeSample = {
    id: 'kitchen-sink',
    title: 'Kitchen sink',
    exercises: ['includes', 'namespaces', 'classes', 'templates', 'lambdas', 'control flow', 'comments'],
    code: `#include "world_canvas.hpp"

#include <algorithm>
#include <memory>
#include <vector>

#include <wx/dcbuffer.h>

namespace life::render {

/// Rasterises a generation into a bitmap.
class Rasterizer : public Renderer {
public:
    Rasterizer(const World &world, const Palette &palette, int cellSize)
        : world_(world), palette_(palette), cellSize_(cellSize) {}

    [[nodiscard]] bool draw(wxDC &dc, const wxRect &clip, bool showGrid = true) const override;

private:
    const World &world_;      ///< Never null, owned by the document.
    const Palette &palette_;  ///< Shared with the control panel.
    int cellSize_ = 8;
    mutable std::vector<wxPoint> scratch_;
};

template <typename T, typename Alloc = std::allocator<T>>
auto countLiveNeighbours(const Grid<T, Alloc> &grid, int x, int y) -> int {
    int total = 0;
    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            if (dx == 0 && dy == 0) continue;
            total += grid.at(x + dx, y + dy) ? 1 : 0;
        }
    }
    return total;
}

bool Rasterizer::draw(wxDC &dc, const wxRect &clip, bool showGrid) const {
    if (world_.empty()) { return false; }

    auto visible = [&](int x, int y) { return clip.Contains(x * cellSize_, y * cellSize_); };
    std::vector<wxPoint> cells{{0, 0}, {1, 0}, {0, 1}};

    switch (palette_.mode()) {
    case Palette::Mode::Mono:
        dc.SetBrush(*wxBLACK_BRUSH);
        break;
    case Palette::Mode::Heat: dc.SetBrush(palette_.brushFor(world_.age())); break;
    default:
        dc.SetBrush(*wxWHITE_BRUSH);
        break;
    }

    std::copy_if(cells.begin(), cells.end(), std::back_inserter(scratch_),
                 [&](const wxPoint &p) { return visible(p.x, p.y); });
    return showGrid && !scratch_.empty();
}

}  // namespace life::render
`,
};

const declarations: CodeSample = {
    id: 'declarations',
    title: 'Declarations & alignment',
    exercises: ['pointer alignment', 'consecutive alignment', 'bitfields', 'enums', 'trailing comments'],
    code: `#include <cstdint>

#define SHORT_NAME 42
#define LONGER_NAME 0x007f
#define EVEN_LONGER_NAME (2)

enum class Direction : std::uint8_t { North = 0, East = 1, South = 2, West = 3 };

struct Header {
    int version = 1;            // bumped on every format change
    unsigned int flags : 4;     // bit 0 = dirty
    unsigned int reserved : 12; // must be zero
    char *name = nullptr;
    const char *const tag = "hdr";
    double scale = 1.0;
    std::uint64_t checksum = 0;
};

static int counter = 0;
static const char *kDefaultName = "untitled";
static double gScaleFactor = 1.5;

int *allocate(std::size_t n);
const char *nameOf(Direction d);
void reset(Header &h, bool keepName = false);
`,
};

const callsAndBreaking: CodeSample = {
    id: 'calls-and-breaking',
    title: 'Long calls & line breaking',
    exercises: ['column limit', 'bin packing', 'argument breaking', 'operator breaking', 'ternaries'],
    code: `#include <string>

ResultCode processIncomingFrame(const FrameHeader &header, const PayloadBuffer &payload,
                                ConnectionState *state, ErrorSink &errors, bool allowPartial) {
    const bool acceptable = header.isValid() && payload.size() >= header.declaredLength() &&
                            state != nullptr && !state->isClosing();

    auto description = acceptable ? formatFrameDescription(header, payload, state->peerName())
                                  : std::string("rejected frame from an unknown peer");

    errors.report(ErrorSeverity::Info, description, header.sequenceNumber(), state->peerName(),
                  payload.size());

    return dispatchToHandlerChain(header, payload, state, errors, allowPartial, /*retry=*/true);
}

void configure() {
    Widget w{"a long label that pushes past the column limit", 1920, 1080, true, false, 0.75};
    registerCallback([](const Event &e, Context &ctx) -> bool { return ctx.accepts(e) && e.valid(); });
}
`,
};

const shortConstructs: CodeSample = {
    id: 'short-constructs',
    title: 'Short constructs & braces',
    exercises: ['short ifs/loops/functions', 'brace wrapping', 'empty bodies', 'case labels'],
    code: `#include <vector>

class Tiny {
public:
    Tiny() {}
    ~Tiny() {}
    int value() const { return value_; }
    void setValue(int v) { value_ = v; }
    void noop() {}

private:
    int value_ = 0;
};

int classify(int n, const std::vector<int> &xs) {
    if (n < 0) return -1;
    if (n == 0) { return 0; }

    while (n > 100) n /= 2;
    for (int x : xs) if (x == n) return x;

    switch (n) {
    case 1:
        return 1;
    case 2: {
        return 2;
    }
    default:
        break;
    }
    return n;
}

namespace empty {}
`,
};

const includesAndMacros: CodeSample = {
    id: 'includes-and-macros',
    title: 'Includes & macros',
    exercises: ['include sorting', 'include categories', 'preprocessor indentation', 'macro continuation'],
    code: String.raw`#include <vector>
#include "local_helper.hpp"
#include <wx/string.h>
#include <algorithm>
#include "world.hpp"
#include <cstdio>

#define CHECK_OR_RETURN(cond, code) \
    do {                            \
        if (!(cond)) return (code); \
    } while (0)

#ifdef __linux__
#include <unistd.h>
#define PLATFORM_NAME "linux"
#else
#define PLATFORM_NAME "other"
#endif

#if defined(DEBUG) && !defined(NDEBUG)
#define LOG(msg) std::fprintf(stderr, "%s\n", msg)
#else
#define LOG(msg) ((void)0)
#endif

int main() {
    CHECK_OR_RETURN(sizeof(int) == 4, 1);
    LOG(PLATFORM_NAME);
    return 0;
}
`,
};

const cSample: CodeSample = {
    id: 'c-basics',
    title: 'C basics',
    exercises: ['pointer alignment', 'struct init', 'control flow', 'preprocessor'],
    code: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_CELLS 4096

typedef struct Grid {
    int width;
    int height;
    unsigned char *cells;
} Grid;

static Grid *grid_create(int width, int height) {
    Grid *g = malloc(sizeof(Grid));
    if (g == NULL) return NULL;
    g->width = width;
    g->height = height;
    g->cells = calloc((size_t)(width * height), sizeof(unsigned char));
    if (!g->cells) { free(g); return NULL; }
    return g;
}

int main(int argc, char **argv) {
    Grid *g = grid_create(argc > 1 ? atoi(argv[1]) : 64, 64);
    for (int y = 0; y < g->height; ++y) {
        for (int x = 0; x < g->width; ++x) g->cells[y * g->width + x] = (x ^ y) & 1;
    }
    printf("%d x %d\n", g->width, g->height);
    free(g->cells);
    free(g);
    return 0;
}
`,
};

export const cpp: LanguageDefinition = {
    id: 'cpp',
    label: 'C++',
    clangLanguage: 'Cpp',
    probeFilename: 'main.cc',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h', '.ipp'],
    samples: [kitchenSink, declarations, callsAndBreaking, shortConstructs, includesAndMacros],
    defaultSampleId: kitchenSink.id,
    signatureOptions: [
        'BasedOnStyle',
        'ColumnLimit',
        'IndentWidth',
        'UseTab',
        'PointerAlignment',
        'BreakBeforeBraces',
        'AccessModifierOffset',
        'NamespaceIndentation',
        'AllowShortFunctionsOnASingleLine',
        'SortIncludes',
    ],
};

export const c: LanguageDefinition = {
    id: 'c',
    label: 'C',
    // clang-format has no separate C language key; C is handled by the Cpp parser,
    // selected via a .c filename. Keeping them as distinct entries lets the sample
    // library and the signature options differ, which is the part users notice.
    clangLanguage: 'Cpp',
    probeFilename: 'main.c',
    extensions: ['.c', '.h'],
    samples: [cSample],
    defaultSampleId: cSample.id,
    signatureOptions: [
        'BasedOnStyle',
        'ColumnLimit',
        'IndentWidth',
        'UseTab',
        'PointerAlignment',
        'BreakBeforeBraces',
        'IndentCaseLabels',
        'SortIncludes',
    ],
};
