#include "render/Rasterizer.hpp"

#include "core/Grid.hpp"
#include "core/Random.hpp"
#include "core/Types.hpp"
#include "render/PixelBuffer.hpp"
#include "render/RenderStyle.hpp"
#include "render/Types.hpp"
#include "render/Viewport.hpp"
#include "support/AsciiGrid.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <format>
#include <gtest/gtest.h>
#include <initializer_list>
#include <span>
#include <string>
#include <string_view>
#include <utility>

namespace life::render {
namespace {

using core::CellPos;
using core::Coord;
using core::Extent;
using core::Grid;
using test::gridFromAscii;

std::string text(Rgb c)
{
    return std::format("#{:02X}{:02X}{:02X}", c.r, c.g, c.b);
}

// A frame as text, one letter per pixel: O alive, . dead, - grid line, = major grid line, # outside.
std::string art(const PixelBuffer& frame, const RenderStyle& style)
{
    const auto letter = [&style](Rgb c) {
        if (c == style.alive)
            return 'O';
        if (c == style.dead)
            return '.';
        if (c == style.gridLine)
            return '-';
        if (c == style.gridLineMajor)
            return '=';
        if (c == style.outside)
            return '#';
        return '?';
    };
    std::string text;
    for (Pixel y = 0; y < frame.size().height; ++y) {
        for (Pixel x = 0; x < frame.size().width; ++x)
            text += letter(frame.at(x, y));
        text += '\n';
    }
    return text;
}

// Joins rows of art, each followed by '\n', to compare with art().
std::string rows(std::initializer_list<std::string_view> lines)
{
    std::string text;
    for (const std::string_view line : lines) {
        text += line;
        text += '\n';
    }
    return text;
}

Viewport viewportFor(const Grid& grid, PixelSize canvas, int cellSize, PixelPoint offset = {})
{
    Viewport viewport;
    viewport.setWorldExtent(grid.extent());
    viewport.setCanvasSize(canvas);
    viewport.setCellSize(cellSize, {});
    viewport.scrollTo(offset);
    return viewport;
}

PixelBuffer render(const Grid& grid, const Viewport& viewport, const RenderStyle& style)
{
    PixelBuffer frame;
    Rasterizer().render(grid, viewport, style, frame);
    return frame;
}

// The colour of one canvas pixel, worked out from the definitions alone: the obviously correct,
// slow version of Rasterizer. A grid line is the last pixel column or row of a cell; where lines
// cross, a major line wins.
Rgb referencePixel(const Grid& grid, const Viewport& viewport, const RenderStyle& style, Pixel x, Pixel y)
{
    const int size = viewport.cellSize();
    const Pixel contentX = viewport.offset().x + x;
    const Pixel contentY = viewport.offset().y + y;
    const std::int64_t cellX = core::floorDiv(contentX, size);
    const std::int64_t cellY = core::floorDiv(contentY, size);
    const Extent world = grid.extent();
    if (cellX < 0 || cellY < 0 || cellX >= world.width || cellY >= world.height)
        return style.outside;

    if (style.showGrid && size >= style.minCellSizeForGrid) {
        const bool onVerticalLine = contentX - cellX * size == size - 1;
        const bool onHorizontalLine = contentY - cellY * size == size - 1;
        const auto major = [&style](std::int64_t cell) {
            return style.majorGridEvery > 0 && (cell + 1) % style.majorGridEvery == 0;
        };
        if ((onVerticalLine && major(cellX)) || (onHorizontalLine && major(cellY)))
            return style.gridLineMajor;
        if (onVerticalLine || onHorizontalLine)
            return style.gridLine;
    }
    const CellPos cell{static_cast<Coord>(cellX), static_cast<Coord>(cellY)};
    return grid.at(cell) == core::kAlive ? style.alive : style.dead;
}

// Empty when `frame` is exactly the reference image, otherwise the first difference.
std::string firstDifference(const PixelBuffer& frame, const Grid& grid, const Viewport& viewport,
                            const RenderStyle& style)
{
    const PixelSize canvas = viewport.canvasSize();
    if (frame.size() != canvas)
        return std::format("frame is {}x{}, canvas is {}x{}", frame.size().width, frame.size().height,
                           canvas.width, canvas.height);
    if (frame.bytes().size() != static_cast<std::size_t>(canvas.width * canvas.height) * 3)
        return std::format("frame holds {} bytes", frame.bytes().size());
    for (Pixel y = 0; y < canvas.height; ++y) {
        for (Pixel x = 0; x < canvas.width; ++x) {
            const Rgb want = referencePixel(grid, viewport, style, x, y);
            if (frame.at(x, y) != want)
                return std::format("pixel ({}, {}) is {}, expected {}", x, y, text(frame.at(x, y)),
                                   text(want));
        }
    }
    return {};
}

// Uniform in [lo, hi]; the modulo bias does not matter here.
std::int64_t pick(core::SplitMix64& rng, std::int64_t lo, std::int64_t hi)
{
    return lo + static_cast<std::int64_t>(rng() % static_cast<std::uint64_t>(hi - lo + 1));
}

// Each cell is alive with probability 2/5.
Grid randomGrid(core::SplitMix64& rng, Extent extent)
{
    Grid grid(extent);
    for (Coord y = 0; y < extent.height; ++y) {
        for (Coord x = 0; x < extent.width; ++x)
            grid.set({x, y}, rng() % 5 < 2 ? core::kAlive : core::kDead);
    }
    return grid;
}

struct Scene {
    Grid grid;
    Viewport viewport;
    RenderStyle style;
    std::string description;
};

// Any cell size, grid policy and scroll position, including centred axes and cells cut by the canvas edge.
Scene randomScene(core::SplitMix64& rng)
{
    const std::int64_t maxSide = pick(rng, 0, 9) == 0 ? 400 : 40;   // now and then a world to scroll far in
    const Extent world{static_cast<Coord>(pick(rng, 0, maxSide)), static_cast<Coord>(pick(rng, 0, maxSide))};
    const PixelSize canvas{pick(rng, 0, 140), pick(rng, 0, 100)};
    const int cellSize = static_cast<int>(pick(rng, 0, 2) == 0 ? pick(rng, 1, 6) : pick(rng, 1, 100));

    RenderStyle style = pick(rng, 0, 1) == 0 ? darkStyle() : lightStyle();
    style.showGrid = pick(rng, 0, 3) != 0;
    style.minCellSizeForGrid = std::array{1, 2, 5, 5, 5}[static_cast<std::size_t>(pick(rng, 0, 4))];
    style.majorGridEvery = std::array{0, 1, 2, 3, 10, 10}[static_cast<std::size_t>(pick(rng, 0, 5))];

    Scene scene{.grid = randomGrid(rng, world), .viewport = {}, .style = style, .description = {}};
    scene.viewport = viewportFor(scene.grid, canvas, cellSize,
                                 {pick(rng, -20, Pixel{world.width} * cellSize + 20),
                                  pick(rng, -20, Pixel{world.height} * cellSize + 20)});
    scene.description = std::format(
        "world {}x{}, canvas {}x{}, cell {} px, offset ({}, {}), grid {} from {} px, major every {}",
        world.width, world.height, canvas.width, canvas.height, cellSize, scene.viewport.offset().x,
        scene.viewport.offset().y, style.showGrid ? "on" : "off", style.minCellSizeForGrid,
        style.majorGridEvery);
    return scene;
}

TEST(PixelBufferTest, UsesTheByteLayoutOfWxImage)
{
    PixelBuffer buffer;
    buffer.resize({4, 3});
    EXPECT_EQ(buffer.size(), (PixelSize{4, 3}));
    ASSERT_EQ(buffer.bytes().size(), 36u);

    buffer.fill({1, 2, 3});
    for (std::size_t i = 0; i < buffer.bytes().size(); ++i)
        ASSERT_EQ(buffer.bytes()[i], i % 3 + 1) << "byte " << i;

    // Row 1 starts after the 12 bytes of row 0; pixel (1, 1) is bytes 3..5 of that row.
    const std::span<std::uint8_t> row = buffer.row(1);
    EXPECT_EQ(row.size(), 12u);
    EXPECT_EQ(row.data(), buffer.bytes().data() + 12);
    row[3] = 10;
    row[4] = 20;
    row[5] = 30;
    EXPECT_EQ(text(buffer.at(1, 1)), "#0A141E");
    EXPECT_EQ(text(buffer.at(0, 1)), "#010203");
    EXPECT_EQ(text(buffer.at(2, 1)), "#010203");
}

TEST(PixelBufferTest, ResizesToAnySize)
{
    PixelBuffer buffer;
    EXPECT_EQ(buffer.size(), (PixelSize{}));
    EXPECT_TRUE(buffer.bytes().empty());

    buffer.resize({0, 5});
    EXPECT_TRUE(buffer.bytes().empty());
    EXPECT_TRUE(buffer.row(4).empty());

    buffer.resize({7, 2});
    EXPECT_EQ(buffer.bytes().size(), 42u);
    buffer.fill({9, 8, 7});
    EXPECT_EQ(text(buffer.at(6, 1)), "#090807");
    EXPECT_EQ(std::as_const(buffer).bytes().size(), 42u);
}

TEST(RasterizerTest, CentredCheckerboardHasAnOutsideMargin)
{
    // Content 6 × 6 px on a 10 × 8 canvas: two columns of margin at the sides, one row above and below.
    const Grid grid = gridFromAscii({".O", "O."});
    const std::string expected = rows({
        "##########",
        "##...OOO##",
        "##...OOO##",
        "##...OOO##",
        "##OOO...##",
        "##OOO...##",
        "##OOO...##",
        "##########",
    });
    for (const RenderStyle& style : {darkStyle(), lightStyle()})
        EXPECT_EQ(art(render(grid, viewportFor(grid, {10, 8}, 3), style), style), expected);
}

TEST(RasterizerTest, UsesTheColoursOfTheStyle)
{
    const Grid grid = gridFromAscii({".O", "O."});
    const RenderStyle dark = darkStyle();
    const RenderStyle light = lightStyle();
    ASSERT_NE(dark.alive, light.alive);
    ASSERT_NE(dark.dead, light.dead);

    for (const RenderStyle& style : {dark, light}) {
        // 5 px cells with lines, centred on a 12 × 12 canvas: the world starts at pixel (1, 1).
        const PixelBuffer frame = render(grid, viewportFor(grid, {12, 12}, 5), style);
        EXPECT_EQ(text(frame.at(0, 0)), text(style.outside));
        EXPECT_EQ(text(frame.at(1, 1)), text(style.dead));
        EXPECT_EQ(text(frame.at(6, 1)), text(style.alive));
        EXPECT_EQ(text(frame.at(5, 1)), text(style.gridLine));
        EXPECT_EQ(text(frame.at(11, 11)), text(style.outside));

        // The bytes are R, G, B in that order.
        const std::span<const std::uint8_t> pixel = frame.bytes().subspan((1 * 12 + 6) * 3, 3);
        EXPECT_EQ(pixel[0], style.alive.r);
        EXPECT_EQ(pixel[1], style.alive.g);
        EXPECT_EQ(pixel[2], style.alive.b);
    }
}

TEST(RasterizerTest, OnePixelCellsMapOneToOne)
{
    const RenderStyle style = darkStyle();
    const Grid grid = gridFromAscii({
        "O..O.O..",
        ".OO...O.",
        "O.O.O.OO",
        "...OO...",
        "OOOO....",
        ".O.O.O.O",
    });
    // Scrolled so that canvas pixel (x, y) shows cell (x + 2, y + 1).
    const std::string scrolled = rows({
        "O...O",
        "O.O.O",
        ".OO..",
        "OO...",
    });
    EXPECT_EQ(art(render(grid, viewportFor(grid, {5, 4}, 1, {2, 1}), style), style), scrolled);

    const Grid small = gridFromAscii({"O.O", ".OO"});
    const std::string centred = rows({
        "#######",
        "##O.O##",
        "##.OO##",
        "#######",
    });
    EXPECT_EQ(art(render(small, viewportFor(small, {7, 4}, 1), style), style), centred);
}

TEST(RasterizerTest, GridLinesNeedFivePixelCells)
{
    RenderStyle style = darkStyle();
    const Grid grid = gridFromAscii({".O"});

    const std::string fourPixels = rows({
        "....OOOO",
        "....OOOO",
        "....OOOO",
        "....OOOO",
    });
    EXPECT_EQ(art(render(grid, viewportFor(grid, {8, 4}, 4), style), style), fourPixels);

    const std::string fivePixels = rows({
        "....-OOOO-",
        "....-OOOO-",
        "....-OOOO-",
        "....-OOOO-",
        "----------",
    });
    EXPECT_EQ(art(render(grid, viewportFor(grid, {10, 5}, 5), style), style), fivePixels);

    style.showGrid = false;
    const std::string gridHidden = rows({
        ".....OOOOO",
        ".....OOOOO",
        ".....OOOOO",
        ".....OOOOO",
        ".....OOOOO",
    });
    EXPECT_EQ(art(render(grid, viewportFor(grid, {10, 5}, 5), style), style), gridHidden);
}

TEST(RasterizerTest, OnePixelCellsWithLinesAreAllLine)
{
    // A style that allows lines at 1 px leaves no body pixels at all.
    RenderStyle style = darkStyle();
    style.minCellSizeForGrid = 1;
    style.majorGridEvery = 2;
    const Grid grid = gridFromAscii({"OOO", "OOO"});
    const std::string expected = rows({
        "-=-",
        "===",
    });
    EXPECT_EQ(art(render(grid, viewportFor(grid, {3, 2}, 1), style), style), expected);
}

TEST(RasterizerTest, MajorLinesMarkEveryNthCell)
{
    // With majorGridEvery = 2 the lines after cell 1 are major; a major line wins where lines cross.
    RenderStyle style = darkStyle();
    style.majorGridEvery = 2;
    const Grid grid = gridFromAscii({"...", ".O.", "..."});
    const std::string expected = rows({
        "....-....=....-",
        "....-....=....-",
        "....-....=....-",
        "....-....=....-",
        "---------=-----",
        "....-OOOO=....-",
        "....-OOOO=....-",
        "....-OOOO=....-",
        "....-OOOO=....-",
        "===============",
        "....-....=....-",
        "....-....=....-",
        "....-....=....-",
        "....-....=....-",
        "---------=-----",
    });
    EXPECT_EQ(art(render(grid, viewportFor(grid, {15, 15}, 5), style), style), expected);
}

TEST(RasterizerTest, DefaultMajorLinesFollowEveryTenthCell)
{
    const RenderStyle style = darkStyle();
    ASSERT_EQ(style.majorGridEvery, 10);
    const Grid grid({12, 12});
    const Viewport viewport = viewportFor(grid, {60, 60}, 5);
    const PixelBuffer frame = render(grid, viewport, style);
    EXPECT_EQ(firstDifference(frame, grid, viewport, style), "");

    const auto pixel = [&frame](Pixel x, Pixel y) { return text(frame.at(x, y)); };
    EXPECT_EQ(pixel(49, 0), text(style.gridLineMajor));    // vertical line after cell 9
    EXPECT_EQ(pixel(44, 0), text(style.gridLine));         // after cell 8
    EXPECT_EQ(pixel(0, 49), text(style.gridLineMajor));    // horizontal line after row 9
    EXPECT_EQ(pixel(44, 49), text(style.gridLineMajor));   // crossings: major wins
    EXPECT_EQ(pixel(49, 44), text(style.gridLineMajor));
    EXPECT_EQ(pixel(49, 49), text(style.gridLineMajor));
    EXPECT_EQ(pixel(44, 44), text(style.gridLine));
    EXPECT_EQ(pixel(59, 59), text(style.gridLine));
    EXPECT_EQ(pixel(48, 48), text(style.dead));

    RenderStyle noMajor = style;
    noMajor.majorGridEvery = 0;
    const std::string minorOnly = art(render(grid, viewport, noMajor), noMajor);
    EXPECT_EQ(minorOnly.find('='), std::string::npos) << minorOnly;
    EXPECT_NE(minorOnly.find('-'), std::string::npos);
}

TEST(RasterizerTest, CellsCutByTheCanvasEdge)
{
    // Offset (4, 9) at 5 px: canvas column 0 is the grid line of cell 0, and canvas row 0 is
    // the grid line of cell row 1, the only visible pixel row of that cell row.
    Grid grid({20, 20});
    grid.set({1, 2}, core::kAlive);
    grid.set({3, 3}, core::kAlive);
    grid.set({2, 1}, core::kAlive);   // hidden: only its grid line is on the canvas

    RenderStyle style = darkStyle();
    const Viewport viewport = viewportFor(grid, {12, 7}, 5, {4, 9});
    ASSERT_EQ(viewport.offset(), (PixelPoint{4, 9}));
    const std::string expected = rows({
        "------------",
        "-OOOO-....-.",
        "-OOOO-....-.",
        "-OOOO-....-.",
        "-OOOO-....-.",
        "------------",
        "-....-....-O",
    });
    EXPECT_EQ(art(render(grid, viewport, style), style), expected);

    style.majorGridEvery = 2;   // now row 1 and column 1 end in major lines
    const std::string withMajorLines = rows({
        "============",
        "-OOOO=....-.",
        "-OOOO=....-.",
        "-OOOO=....-.",
        "-OOOO=....-.",
        "-----=------",
        "-....=....-O",
    });
    EXPECT_EQ(art(render(grid, viewport, style), style), withMajorLines);
}

TEST(RasterizerTest, FarCornerOfAWideWorld)
{
    // Content 10,000,000 px wide: pixel arithmetic must not overflow 32 bits.
    Grid grid({100'000, 2});
    grid.set({99'999, 1}, core::kAlive);
    grid.set({99'998, 0}, core::kAlive);
    const RenderStyle style = darkStyle();
    const Viewport viewport = viewportFor(grid, {250, 150}, 100, {1'000'000'000, 1'000'000'000});
    ASSERT_EQ(viewport.offset(), (PixelPoint{9'999'750, 50}));

    const PixelBuffer frame = render(grid, viewport, style);
    EXPECT_EQ(firstDifference(frame, grid, viewport, style), "");
    EXPECT_EQ(text(frame.at(200, 100)), text(style.alive));   // cell (99999, 1)
    EXPECT_EQ(text(frame.at(100, 0)), text(style.alive));     // cell (99998, 0)
    EXPECT_EQ(text(frame.at(10, 100)), text(style.dead));     // cell (99997, 1)
}

TEST(RasterizerTest, EmptyCanvasGivesAnEmptyFrame)
{
    const Grid grid({10, 10});
    Rasterizer rasterizer;
    PixelBuffer frame;
    rasterizer.render(grid, viewportFor(grid, {10, 10}, 1), darkStyle(), frame);
    ASSERT_EQ(frame.size(), (PixelSize{10, 10}));

    for (const PixelSize canvas : {PixelSize{0, 0}, PixelSize{0, 7}, PixelSize{7, 0}}) {
        rasterizer.render(grid, viewportFor(grid, canvas, 4), darkStyle(), frame);
        EXPECT_EQ(frame.size(), canvas);
        EXPECT_TRUE(frame.bytes().empty());
    }
}

TEST(RasterizerTest, EmptyWorldIsAllOutside)
{
    const Grid grid;
    const RenderStyle style = lightStyle();
    const std::string expected = rows({
        "####",
        "####",
        "####",
    });
    EXPECT_EQ(art(render(grid, viewportFor(grid, {4, 3}, 8), style), style), expected);
}

TEST(RasterizerTest, EveryCellSizeMatchesThePixelReference)
{
    core::SplitMix64 rng(5);
    const Grid grid = randomGrid(rng, {23, 17});
    Rasterizer rasterizer;
    PixelBuffer frame;
    for (int cellSize = kMinCellSize; cellSize <= kMaxCellSize; ++cellSize) {
        // The second offset cuts cells at every canvas edge and starts on a grid-line row;
        // small sizes leave the world centred instead.
        const PixelPoint cut{Pixel{cellSize} * 5 + cellSize / 2 + 1, Pixel{cellSize} * 3 + cellSize - 1};
        for (const PixelPoint offset : {PixelPoint{0, 0}, cut}) {
            for (const bool showGrid : {false, true}) {
                RenderStyle style = darkStyle();
                style.showGrid = showGrid;
                style.majorGridEvery = 4;
                const Viewport viewport = viewportFor(grid, {157, 113}, cellSize, offset);
                rasterizer.render(grid, viewport, style, frame);
                ASSERT_EQ(firstDifference(frame, grid, viewport, style), "")
                    << cellSize << " px, offset (" << viewport.offset().x << ", " << viewport.offset().y
                    << "), grid " << (showGrid ? "on" : "off");
            }
        }
    }
}

TEST(RasterizerTest, RandomScenesMatchThePixelReference)
{
    // One rasterizer and one frame for every scene, as in WorldCanvas, so stale buffers would show.
    core::SplitMix64 rng(20260916);
    Rasterizer rasterizer;
    PixelBuffer frame;
    for (int i = 0; i < 1500; ++i) {
        const Scene scene = randomScene(rng);
        rasterizer.render(scene.grid, scene.viewport, scene.style, frame);
        ASSERT_EQ(firstDifference(frame, scene.grid, scene.viewport, scene.style), "")
            << "scene " << i << ": " << scene.description;
    }
}

}
}
