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
    exercises: [
        'includes', 'preprocessor', 'macros', 'extern "C"', 'namespaces', 'enums', 'structs', 'unions',
        'bitfields', 'arrays of structs', 'classes', 'inheritance', 'access modifiers',
        'constructor initialisers', 'operator overloads', 'templates', 'lambdas', 'if/else if/else',
        'switch', 'do-while', 'try/catch', 'goto labels', 'ternaries', 'string literals', 'raw strings',
        'numeric literals', 'comments', 'consecutive alignment', 'function pointers',
    ],
    code: String.raw`#include "telemetry/sampler.hpp"

#include <sys/types.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <map>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

#include <telemetry/wire.h>

#define TELEMETRY_VERSION 3
#define TELEMETRY_MAX_CHANNELS 64
#define TELEMETRY_CLAMP(value, lo, hi) ((value) < (lo) ? (lo) : (value) > (hi) ? (hi) : (value))

#define TELEMETRY_TRACE(fmt, ...)                                              \
    do {                                                                       \
        if (tracing_enabled) {                                                 \
            std::fprintf(stderr, "[telemetry] " fmt "\n", __VA_ARGS__);        \
        }                                                                      \
    } while (0)

#if defined(__linux__)
#include <unistd.h>
#define TELEMETRY_PLATFORM "linux"
#elif defined(_WIN32)
#define TELEMETRY_PLATFORM "windows"
#else
#define TELEMETRY_PLATFORM "portable"
#endif

extern "C" {
int telemetry_abi_version(void);
void telemetry_reset(void);
}

namespace telemetry::wire {
inline constexpr int kMagic = 0x7E1E;
}  // namespace telemetry::wire

namespace telemetry {

using std::size_t;
using std::string;
using Clock = std::uint64_t;
using ChannelMap = std::map<string, std::vector<double>>;

static bool tracing_enabled = false;

enum class Severity : std::uint8_t {
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warning = 3,
    Error = 4,
};

enum Flags { kNone = 0, kRetain = 1 << 0, kCompress = 1 << 1 };

struct Header {
    std::uint32_t magic = 0xDEADBEEF;  // sentinel
    std::uint16_t version = TELEMETRY_VERSION;
    unsigned int dirty : 1;      // set when buffers need a flush
    unsigned int reserved : 11;  // must stay zero
    unsigned int channels : 4;
};

union Payload {
    double real;
    std::int64_t integral;
    char bytes[8];
};

struct Limits {
    const char *name;
    double minimum;
    double maximum;
    Severity on_breach;
};

static constexpr Limits kDefaultLimits[] = {
    {"voltage", 0.0, 24.0, Severity::Error},
    {"temperature", -40.0, 125.0, Severity::Warning},
    {"humidity", 0.0, 100.0, Severity::Info},
    {"rpm", 0.0, 12000.0, Severity::Debug},
};

class Serializable {
public:
    virtual ~Serializable() = default;
    [[nodiscard]] virtual string encode() const = 0;
};

class Traceable {
public:
    virtual ~Traceable() = default;
    virtual void trace(Severity level) const noexcept = 0;
};

class Sampler final : public Serializable, public Traceable {
public:
    Sampler(string name, Clock started_at, size_t capacity, double scale, bool retain) noexcept
        : name_(std::move(name)), started_at_(started_at), capacity_(capacity), scale_(scale),
          retain_(retain) {}

    Sampler(const Sampler &) = delete;
    Sampler &operator=(const Sampler &) = delete;
    Sampler(Sampler &&) noexcept = default;

    [[nodiscard]] string encode() const override;
    void trace(Severity level) const noexcept override;

    [[nodiscard]] bool operator==(const Sampler &other) const { return name_ == other.name_; }
    double &operator[](size_t index) { return samples_[index]; }
    explicit operator bool() const noexcept { return !samples_.empty(); }

    [[nodiscard]] size_t size() const { return samples_.size(); }
    [[nodiscard]] bool empty() const { return samples_.empty(); }
    void clear() {}

private:
    string name_;
    Clock started_at_ = 0;
    size_t capacity_ = 0;
    double scale_ = 1.0;
    bool retain_ = false;
    std::vector<double> samples_;
    Payload last_{};

    static constexpr double kEpsilon = 1e-9;
    static constexpr std::uint32_t kMask = 0xFFFF'F000U;
    static constexpr std::int64_t kBias = 0b1010'0110;
    static constexpr unsigned long kBudget = 250000UL;
};

static_assert(sizeof(Payload) == 8, "payload must stay eight bytes wide");

template <typename T>
[[nodiscard]] static T clamp_to(T value, T lo, T hi) {
    return value < lo ? lo : (value > hi ? hi : value);
}

template <typename Container, typename Predicate>
static typename Container::size_type count_matching(const Container &container, Predicate predicate) {
    return static_cast<typename Container::size_type>(
        std::count_if(container.begin(), container.end(), predicate));
}

string Sampler::encode() const {
    string out;
    out.reserve(capacity_ * 8);

    int written = 0;
    double accumulator = 0.0;
    unsigned long long checksum = 0;

    for (size_t i = 0; i < samples_.size(); ++i) {
        const double raw = samples_[i] * scale_;
        if (raw < kEpsilon && raw > -kEpsilon) {
            continue;
        } else if (raw > kDefaultLimits[0].maximum) {
            TELEMETRY_TRACE("sample %zu over limit: %f", i, raw);
            break;
        } else {
            accumulator += raw;
            checksum ^= static_cast<unsigned long long>(raw) * 0x9E3779B97F4A7C15ULL;
        }
        ++written;
    }

    size_t retries = 0;
    do {
        ++retries;
    } while (retries < 3 && checksum == 0);

    switch (static_cast<Severity>(written % 5)) {
    case Severity::Trace: out += "trace"; break;
    case Severity::Debug: out += "debug"; break;
    case Severity::Info: out += "info"; break;
    case Severity::Warning: {
        out += "warning";
        break;
    }
    default:
        out += "error";
        break;
    }

    const auto describe = [this](const Limits &limit) -> string {
        if (!limit.name) return {};
        return string(limit.name) + "=" + std::to_string(limit.maximum * scale_);
    };

    const auto summarise = [&](Severity level, bool verbose) {
        string text = describe(kDefaultLimits[0]);
        if (verbose && level >= Severity::Warning) {
            text += " (" + name_ + ")";
            text += "; budget=" + std::to_string(kBudget);
        }
        return text;
    };

    out += summarise(Severity::Info, retain_);
    out += "a very long literal that exists purely so the column limit has something to push against";
    out += "adjacent string literals " "are joined by the preprocessor";
    out += R"(a raw string with "quotes" and \backslashes\ left alone)";

    if (out.size() > (capacity_) && (checksum != 0)) {
        goto truncate;
    }
    return out;

truncate:
    out.resize(capacity_);
    return out;
}

void Sampler::trace(Severity level) const noexcept {
    try {
        if (level == Severity::Error && !samples_.empty()) {
            throw std::runtime_error("sampler " + name_ + " reported an error-level breach");
        }
    } catch (const std::runtime_error &error) {
        TELEMETRY_TRACE("%s", error.what());
    } catch (...) {
        TELEMETRY_TRACE("%s", "unknown failure");
    }
}

using Transform = double (*)(double);
using Validator = bool (*)(const Limits &, double);

struct Hooks {
    Transform scale;                 // applied before anything else
    Transform offset;
    Validator validate;
    void (*on_breach)(Severity);
};

void calibrate(Hooks &hooks, double gain, int passes) {
    double coarse = 1.0;
    double fine = 0.125;

    // Trim is applied last, after both coarse and fine have settled.
    double trim = 0.0;
    unsigned mask = 0;
    int iterations = 0;

    coarse *= gain;
    fine += 0.5;
    trim -= 0.25;
    mask |= 0xF0U;
    iterations <<= 2;

    hooks.scale = nullptr;
    hooks.offset = nullptr;
    hooks.validate = nullptr;
    hooks.on_breach = nullptr;

    while (iterations < passes) ++iterations;
}

ChannelMap collect(const std::vector<Sampler *> &samplers, Severity minimum_level, bool include_empty,
                   size_t limit, double scale_override) {
    ChannelMap channels;
    alignas(Payload) unsigned char storage[sizeof(Payload)];
    Payload *scratch = new (storage) Payload{};

    for (Sampler *sampler : samplers) {
        if (sampler == nullptr || (!include_empty && sampler->empty())) continue;
        const bool interesting = sampler->size() > limit || scale_override > 1.0 ||
                                 (minimum_level >= Severity::Warning && !sampler->empty());
        if (interesting) channels[sampler->encode()].push_back(scratch->real);
    }

    const size_t matching = count_matching(samplers, [](const Sampler *s) { return s != nullptr; });
    TELEMETRY_TRACE("collected %zu of %zu", matching, samplers.size());
    return channels;
}

}  // namespace telemetry
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
    exercises: [
        'includes', 'preprocessor', 'macros', 'enums', 'structs', 'unions', 'bitfields',
        'function pointers', 'pointer alignment', 'if/else if/else', 'switch', 'goto labels', 'comments',
    ],
    code: String.raw`#include "grid/life.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LIFE_MAX_CELLS 4096
#define LIFE_DEFAULT_WIDTH 64
#define LIFE_INDEX(g, x, y) ((y) * (g)->width + (x))

#define LIFE_CHECK(cond, code)  \
    do {                        \
        if (!(cond)) {          \
            return (code);      \
        }                       \
    } while (0)

#ifdef LIFE_DEBUG
#define LIFE_LOG(msg) fprintf(stderr, "life: %s\n", (msg))
#else
#define LIFE_LOG(msg) ((void)0)
#endif

typedef enum Rule { RULE_CONWAY = 0, RULE_HIGHLIFE, RULE_SEEDS, RULE_CUSTOM } Rule;

typedef enum Status {
    STATUS_OK = 0,
    STATUS_OUT_OF_MEMORY = -1,
    STATUS_BAD_ARGUMENT = -2,
    STATUS_OVERFLOW = -3,
} Status;

struct Grid {
    int width;
    int height;
    unsigned int wrap : 1;      /* torus topology */
    unsigned int dirty : 1;     /* needs a repaint */
    unsigned int generation : 30;
    unsigned char *cells;
};

union Cell {
    unsigned char packed;
    struct {
        unsigned char alive : 1;
        unsigned char age : 7;
    } parts;
};

typedef int (*RuleFn)(int alive, int neighbours);
typedef void (*ReportFn)(const struct Grid *grid, void *user_data);

static const char *const kRuleNames[] = {"conway", "highlife", "seeds", "custom"};

static int rule_conway(int alive, int neighbours) {
    if (alive) {
        return neighbours == 2 || neighbours == 3;
    } else if (neighbours == 3) {
        return 1;
    } else {
        return 0;
    }
}

static int count_neighbours(const struct Grid *grid, int x, int y) {
    int total = 0;
    int dx = 0;
    int dy = 0;

    /* Wrapping is resolved per axis so a torus costs no extra branches. */
    for (dy = -1; dy <= 1; ++dy) {
        for (dx = -1; dx <= 1; ++dx) {
            int nx = x + dx;
            int ny = y + dy;
            if (dx == 0 && dy == 0) continue;
            if (grid->wrap) {
                nx = (nx + grid->width) % grid->width;
                ny = (ny + grid->height) % grid->height;
            } else if (nx < 0 || ny < 0 || nx >= grid->width || ny >= grid->height) {
                continue;
            }
            total += grid->cells[LIFE_INDEX(grid, nx, ny)] & 1;
        }
    }
    return total;
}

Status life_step(struct Grid *grid, Rule rule, RuleFn custom, ReportFn report, void *user_data) {
    unsigned char *next = NULL;
    size_t bytes = 0;
    RuleFn apply = NULL;
    int x = 0;
    int y = 0;

    LIFE_CHECK(grid != NULL, STATUS_BAD_ARGUMENT);
    LIFE_CHECK(grid->width > 0 && grid->height > 0, STATUS_BAD_ARGUMENT);

    switch (rule) {
    case RULE_CONWAY: apply = rule_conway; break;
    case RULE_HIGHLIFE: apply = rule_conway; break;
    case RULE_SEEDS: apply = rule_conway; break;
    case RULE_CUSTOM:
        apply = custom;
        break;
    default:
        return STATUS_BAD_ARGUMENT;
    }

    bytes = (size_t)grid->width * (size_t)grid->height;
    next = calloc(bytes, sizeof(unsigned char));
    if (next == NULL) goto out_of_memory;

    for (y = 0; y < grid->height; ++y) {
        for (x = 0; x < grid->width; ++x) {
            const int alive = grid->cells[LIFE_INDEX(grid, x, y)] & 1;
            const int neighbours = count_neighbours(grid, x, y);
            next[LIFE_INDEX(grid, x, y)] = (unsigned char)apply(alive, neighbours);
        }
    }

    free(grid->cells);
    grid->cells = next;
    grid->dirty = 1;
    grid->generation = (grid->generation + 1u) & 0x3FFFFFFFu;

    if (report != NULL) report(grid, user_data);
    LIFE_LOG(kRuleNames[rule]);
    return STATUS_OK;

out_of_memory:
    LIFE_LOG("allocation failed while stepping the grid");
    return STATUS_OUT_OF_MEMORY;
}
`,
};

const templatesAndConcepts: CodeSample = {
    id: 'templates-and-concepts',
    title: 'Templates & concepts',
    exercises: [
        'concepts', 'requires clauses', 'requires expressions', 'variadic templates', 'fold expressions',
        'template specialisation', 'trailing return types', 'default template arguments',
        'operator overloads',
    ],
    code: String.raw`#include <concepts>
#include <functional>
#include <type_traits>
#include <vector>

namespace geometry {

template <typename T>
concept Arithmetic = std::is_arithmetic_v<T> && !std::same_as<T, bool>;

template <typename T>
concept Point = requires(T point) {
    { point.x } -> std::convertible_to<double>;
    { point.y } -> std::convertible_to<double>;
    { point.norm() } -> std::same_as<double>;
};

template <typename T>
    requires Arithmetic<T> && (sizeof(T) <= 8)
struct Vec2 {
    T x{};
    T y{};

    [[nodiscard]] constexpr double norm() const noexcept {
        return static_cast<double>(x) * static_cast<double>(x) +
               static_cast<double>(y) * static_cast<double>(y);
    }

    constexpr Vec2 &operator+=(const Vec2 &other) noexcept {
        x += other.x;
        y += other.y;
        return *this;
    }

    friend constexpr bool operator==(const Vec2 &, const Vec2 &) = default;
};

template <typename... Ts>
    requires(sizeof...(Ts) > 0) && (Arithmetic<Ts> && ...)
constexpr auto sum_all(Ts... values) noexcept {
    return (values + ...);
}

template <Point P, typename Projection = std::identity>
    requires std::invocable<Projection, const P &>
[[nodiscard]] auto centroid(const std::vector<P> &points, Projection project = {})
    -> Vec2<double> {
    Vec2<double> total{};
    for (const P &point : points) {
        const auto projected = std::invoke(project, point);
        total += Vec2<double>{static_cast<double>(projected.x), static_cast<double>(projected.y)};
    }
    if (points.empty()) return total;
    total.x /= static_cast<double>(points.size());
    total.y /= static_cast<double>(points.size());
    return total;
}

template <typename T>
struct Traits {
    using value_type = T;
    static constexpr bool kIsExact = std::is_integral_v<T>;
};

template <>
struct Traits<double> {
    using value_type = double;
    static constexpr bool kIsExact = false;
};

template <typename Range, typename Compare = std::less<typename Range::value_type>>
    requires requires(Range range) {
        range.begin();
        range.end();
    }
constexpr bool is_sorted_by(const Range &range, Compare compare = {}) {
    auto previous = range.begin();
    if (previous == range.end()) return true;
    for (auto it = std::next(previous); it != range.end(); ++it, ++previous) {
        if (compare(*it, *previous)) return false;
    }
    return true;
}

}  // namespace geometry
`,
};

export const cpp: LanguageDefinition = {
    id: 'cpp',
    label: 'C++',
    clangLanguage: 'Cpp',
    probeFilename: 'main.cc',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h', '.ipp'],
    samples: [
        kitchenSink,
        templatesAndConcepts,
        declarations,
        callsAndBreaking,
        shortConstructs,
        includesAndMacros,
    ],
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
