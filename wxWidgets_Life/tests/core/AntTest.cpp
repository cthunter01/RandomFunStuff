#include "core/Ant.h"

#include "support/AsciiGrid.h"

#include <algorithm>
#include <gtest/gtest.h>

namespace life::core {
namespace {

using test::gridFromAscii;

// Turning and stepping are arithmetic, so their whole contract is checked at compile time.
static_assert(std::ranges::all_of(kHeadings, [](Heading h) { return turnLeft(turnRight(h)) == h; }));
static_assert(std::ranges::all_of(kHeadings, [](Heading h) {
    return turnRight(turnRight(turnRight(turnRight(h)))) == h;
}));
static_assert(turnRight(Heading::North) == Heading::East);   // the four are in clockwise order
static_assert(turnRight(Heading::East) == Heading::South);
static_assert(turnRight(Heading::South) == Heading::West);
static_assert(turnRight(Heading::West) == Heading::North);
static_assert(toString(Heading::North) == "north");

// forward() steps inside a 4 × 3 world and wraps at each of its four edges.
static_assert(forward({1, 1}, Heading::North, {4, 3}) == CellPos{1, 0});
static_assert(forward({1, 0}, Heading::North, {4, 3}) == CellPos{1, 2});
static_assert(forward({3, 1}, Heading::East, {4, 3}) == CellPos{0, 1});
static_assert(forward({1, 2}, Heading::South, {4, 3}) == CellPos{1, 0});
static_assert(forward({0, 1}, Heading::West, {4, 3}) == CellPos{3, 1});

// One ant starts in the middle, where Langton's ant draws its classic pattern; several share the middle row.
static_assert(defaultAnt(0, 1, {9, 9}) == Ant{{4, 4}, Heading::North});
static_assert(defaultAnt(0, 3, {12, 4}).position == CellPos{3, 2});
static_assert(defaultAnt(1, 3, {12, 4}).position == CellPos{6, 2});
static_assert(defaultAnt(2, 3, {12, 4}).position == CellPos{9, 2});

TEST(AntTest, TurnsRightOnADeadCellAndLeftOnALiveOne)
{
    Grid grid = gridFromAscii({"...", ".O.", "..."});

    Ant onDead{{0, 1}, Heading::North};
    EXPECT_EQ(advance(onDead, grid), 1);   // the cell came alive
    EXPECT_EQ(onDead.heading, Heading::East);
    EXPECT_EQ(grid.at({0, 1}), kAlive);
    EXPECT_EQ(onDead.position, (CellPos{1, 1}));

    Ant onAlive{{1, 1}, Heading::North};
    EXPECT_EQ(advance(onAlive, grid), -1);   // and this one died
    EXPECT_EQ(onAlive.heading, Heading::West);
    EXPECT_EQ(grid.at({1, 1}), kDead);
    EXPECT_EQ(onAlive.position, (CellPos{0, 1}));
}

TEST(AntTest, FourMovesDrawABlockAndComeBack)
{
    Grid grid({5, 5});
    Ant ant{{2, 2}, Heading::North};

    // Turning right on every dead cell walks the ant clockwise around a 2 × 2 block.
    advance(ant, grid);
    EXPECT_EQ(grid, gridFromAscii({".....", ".....", "..O..", ".....", "....."}));
    EXPECT_EQ(ant, (Ant{{3, 2}, Heading::East}));

    advance(ant, grid);
    EXPECT_EQ(grid, gridFromAscii({".....", ".....", "..OO.", ".....", "....."}));
    EXPECT_EQ(ant, (Ant{{3, 3}, Heading::South}));

    advance(ant, grid);
    EXPECT_EQ(grid, gridFromAscii({".....", ".....", "..OO.", "...O.", "....."}));
    EXPECT_EQ(ant, (Ant{{2, 3}, Heading::West}));

    advance(ant, grid);
    EXPECT_EQ(grid, gridFromAscii({".....", ".....", "..OO.", "..OO.", "....."}));
    EXPECT_EQ(ant, (Ant{{2, 2}, Heading::North}));   // back where it started, having drawn the block
}

TEST(AntTest, MovingOffAnEdgeWrapsToTheOppositeOne)
{
    // Every cell is dead, so each ant turns right before it moves: it leaves facing `leaving`.
    struct Case {
        Ant start;
        Heading leaving;
        CellPos expected;
    };
    constexpr Case kCases[]{
        {{{1, 0}, Heading::West}, Heading::North, {1, 2}},
        {{{2, 1}, Heading::North}, Heading::East, {0, 1}},
        {{{1, 2}, Heading::East}, Heading::South, {1, 0}},
        {{{0, 1}, Heading::South}, Heading::West, {2, 1}},
    };

    for (const Case& scenario : kCases) {
        SCOPED_TRACE(toString(scenario.leaving));
        Grid grid({3, 3});
        Ant ant = scenario.start;
        advance(ant, grid);
        EXPECT_EQ(ant.heading, scenario.leaving);
        EXPECT_EQ(ant.position, scenario.expected);
    }
}

}
}
