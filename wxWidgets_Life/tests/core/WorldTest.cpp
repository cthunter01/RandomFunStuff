#include "core/World.h"

#include "core/Ant.h"
#include "core/ParallelBands.h"
#include "core/Random.h"
#include "core/ReferenceStepper.h"
#include "support/AsciiGrid.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <format>
#include <gtest/gtest.h>
#include <initializer_list>
#include <limits>
#include <memory>
#include <new>
#include <span>
#include <string_view>
#include <vector>

namespace life::core {
namespace {

using test::gridFromAscii;
using test::toAscii;

using Pattern = std::initializer_list<std::string_view>;

// Sets the live cells of `pattern` with its top-left cell at `at`.
void draw(World& world, Pattern pattern, CellPos at = {0, 0})
{
    const Grid source = gridFromAscii(pattern);
    for (Coord y = 0; y < source.extent().height; ++y) {
        for (Coord x = 0; x < source.extent().width; ++x) {
            if (source.at({x, y}) == kAlive)
                world.setCell({at.x + x, at.y + y}, kAlive);
        }
    }
}

const Pattern kGlider = {
    ".O.",
    "..O",
    "OOO",
};

TEST(WorldTest, StartsEmptyWithTheGivenSettings)
{
    const World world({7, 5}, Rule::parse("B36/S23").value(), Topology::Bounded);
    EXPECT_EQ(world.extent(), (Extent{7, 5}));
    EXPECT_EQ(world.cells().extent(), (Extent{7, 5}));
    EXPECT_EQ(world.rule().toString(), "B36/S23");
    EXPECT_EQ(world.topology(), Topology::Bounded);
    EXPECT_EQ(world.stepper().kind(), StepperKind::Banded);
    EXPECT_EQ(world.generation(), 0u);
    EXPECT_EQ(world.population(), 0);

    const World defaults({1, 1});
    EXPECT_EQ(defaults.rule().toString(), "B3/S23");
    EXPECT_EQ(defaults.topology(), Topology::Torus);
}

TEST(WorldTest, GliderOnATorusReturnsHome)
{
    World world({8, 8});
    draw(world, kGlider, {2, 3});
    const Grid start = world.cells();
    for (int g = 0; g < 32; ++g)
        world.step();
    EXPECT_EQ(world.cells(), start);
    EXPECT_EQ(world.generation(), 32u);
    EXPECT_EQ(world.population(), 5);
}

TEST(WorldTest, OnlyStepAdvancesTheGeneration)
{
    World world({10, 10});
    world.step();
    world.step();
    EXPECT_EQ(world.generation(), 2u);

    world.setCell({1, 1}, kAlive);
    world.setRule(Rule::parse("B36/S23").value());
    world.setTopology(Topology::Bounded);
    world.setStepper(makeStepper(StepperKind::Reference));
    world.resize({12, 9}, true);
    EXPECT_EQ(world.generation(), 2u);
}

TEST(WorldTest, ClearRandomizeAndPlainResizeResetTheGeneration)
{
    World world({10, 10});
    const auto advanced = [&] {
        world.step();
        return world.generation() == 1u;
    };

    ASSERT_TRUE(advanced());
    world.clear();
    EXPECT_EQ(world.generation(), 0u);

    ASSERT_TRUE(advanced());
    world.randomize(0.5, 1);
    EXPECT_EQ(world.generation(), 0u);

    world.clear();
    ASSERT_TRUE(advanced());
    world.resize({4, 4}, false);
    EXPECT_EQ(world.generation(), 0u);
}

TEST(WorldTest, SetCellsIgnoresOutsidePositionsAndCountsChanges)
{
    World world({5, 5});
    const std::vector<CellPos> cells = {{0, 0}, {0, 0}, {-1, 0}, {5, 5}, {4, 4}, {2, -3}, {4, 0}};
    EXPECT_EQ(world.setCells(cells, kAlive), 3);   // (0, 0) counts once
    EXPECT_EQ(world.population(), 3);
    EXPECT_EQ(world.setCells(cells, kAlive), 0);
    EXPECT_EQ(toAscii(world.cells()), "O...O\n"
                                      ".....\n"
                                      ".....\n"
                                      ".....\n"
                                      "....O\n");
    EXPECT_EQ(world.setCells(std::vector<CellPos>{{4, 4}, {3, 3}}, kDead), 1);
    EXPECT_EQ(world.population(), 2);

    EXPECT_TRUE(world.setCell({3, 3}, kAlive));
    EXPECT_FALSE(world.setCell({3, 3}, kAlive));
    EXPECT_FALSE(world.setCell({5, 3}, kAlive));
    EXPECT_EQ(world.at({3, 3}), kAlive);
    EXPECT_EQ(world.population(), 3);
}

TEST(WorldTest, PopulationStaysExactThroughRandomOperations)
{
    World world({20, 20});
    SplitMix64 random(314);
    const auto below = [&](Coord n) { return static_cast<Coord>(random() % static_cast<std::uint64_t>(n)); };
    for (int i = 0; i < 400; ++i) {
        const std::uint64_t operation = random() % 10;
        if (operation < 4) {
            std::vector<CellPos> stroke;
            for (int k = 0; k < 20; ++k)   // a few land outside the world
                stroke.push_back({below(world.extent().width + 4) - 2, below(world.extent().height + 4) - 2});
            world.setCells(stroke, random() % 2 == 0 ? kAlive : kDead);
        } else if (operation < 7) {
            world.step();
        } else if (operation == 7) {
            world.randomize(static_cast<double>(below(101)) / 100.0, random());
        } else if (operation == 8) {
            world.resize({1 + below(40), 1 + below(40)}, random() % 4 != 0);
        } else if (random() % 3 == 0) {
            world.clear();
        } else {
            world.setTopology(kTopologies[random() % kTopologies.size()]);
        }
        ASSERT_EQ(world.population(), world.cells().countAlive()) << "after operation " << i;
    }
}

// World::randomize(0.3, seed), computed serially: row y uses
// SplitMix64(SplitMix64(seed ^ (0x9E3779B97F4A7C15 * (y + 1)))()), and each number supplies eight cells,
// lowest byte first. A cell lives if its byte is below 77.
Grid serialRandomize(Extent extent, std::uint64_t seed)
{
    const unsigned threshold = 77;   // lround(0.3 * 256)
    Grid grid(extent);
    for (Coord y = 0; y < extent.height; ++y) {
        const std::uint64_t rowSeed = seed ^ (0x9E3779B97F4A7C15u * (static_cast<std::uint64_t>(y) + 1));
        const std::uint64_t hashedSeed = SplitMix64(rowSeed)();
        SplitMix64 random(hashedSeed);
        std::uint64_t bytes = 0;
        for (Coord x = 0; x < extent.width; ++x) {
            bytes = x % 8 == 0 ? random() : bytes >> 8;
            grid.set({x, y}, (bytes & 0xFF) < threshold ? kAlive : kDead);
        }
    }
    return grid;
}

TEST(WorldTest, RandomizeFollowsThePerRowFormula)
{
    // randomize() splits the rows with suggestedBandCount(), so on a host with at least 16 hardware
    // threads these sizes use 1, 4, 8 and 16 bands. Any other split must give the same cells.
    const std::uint64_t seed = 0xC0FFEE;
    for (const Extent extent : {Extent{100, 50}, Extent{1001, 500}, Extent{1024, 1024}, Extent{2048, 1024}}) {
        SCOPED_TRACE(std::format("{}x{}, {} bands", extent.width, extent.height,
                                 suggestedBandCount(extent.cellCount())));
        World world(extent);
        world.randomize(0.3, seed);
        const Grid expected = serialRandomize(extent, seed);
        EXPECT_EQ(world.cells(), expected);
        EXPECT_EQ(world.population(), expected.countAlive());
    }

    World world({300, 200});
    world.randomize(0.3, seed);
    World again({300, 200});
    again.randomize(0.3, seed);
    EXPECT_EQ(again.cells(), world.cells());
    again.randomize(0.3, seed + 1);
    EXPECT_NE(again.cells(), world.cells());
}

// Seeding each row with an unhashed seed made small seeds produce rows that repeat an earlier row shifted
// by 8 cells per row of distance (seed 0: every row; seed 1: every second row), with a biased density.
TEST(WorldTest, RandomizeRowsAreIndependentForSmallSeeds)
{
    const Extent extent{1000, 1000};
    const auto width = static_cast<std::size_t>(extent.width);
    World world(extent);
    for (const std::uint64_t seed : {0u, 1u}) {
        SCOPED_TRACE(std::format("seed {}", seed));
        world.randomize(0.25, seed);
        // Five standard deviations of the live fraction of 10^6 cells that live with probability 1/4.
        EXPECT_NEAR(static_cast<double>(world.population()) / 1e6, 0.25, 0.0022);

        int shiftedCopies = 0;
        for (Coord y = 0; y < extent.height; ++y) {
            for (Coord distance = 1; distance <= 16 && y + distance < extent.height; ++distance) {
                const auto shift = static_cast<std::size_t>(8 * distance);
                const std::span<const Cell> row = world.cells().row(y);
                const std::span<const Cell> later = world.cells().row(y + distance);
                if (std::ranges::equal(row.subspan(shift), later.first(width - shift)))
                    ++shiftedCopies;
            }
        }
        EXPECT_EQ(shiftedCopies, 0);
    }
}

TEST(WorldTest, RandomizeDensityLimits)
{
    World world({300, 200});
    world.randomize(0.0, 5);
    EXPECT_EQ(world.population(), 0);
    world.randomize(1.0, 5);
    EXPECT_EQ(world.population(), world.extent().cellCount());
    world.randomize(-3.0, 5);   // clamped
    EXPECT_EQ(world.population(), 0);
    world.randomize(7.0, 5);
    EXPECT_EQ(world.population(), world.extent().cellCount());
}

TEST(WorldTest, RandomizeHitsTheRequestedDensity)
{
    World world({512, 512});
    const auto cells = static_cast<double>(world.extent().cellCount());
    for (const double density : {0.1, 0.25, 0.5, 0.9}) {
        world.randomize(density, 17);
        EXPECT_NEAR(static_cast<double>(world.population()) / cells, density, 0.01) << "density " << density;
    }
}

TEST(WorldTest, ResizeKeepsThePatternCentredWhenGrowing)
{
    World world({3, 2});
    draw(world, {
                    "O.O",
                    ".OO",
                });
    world.resize({7, 5}, true);   // offset ((7 - 3) / 2, (5 - 2) / 2) = (2, 1)
    EXPECT_EQ(toAscii(world.cells()), ".......\n"
                                      "..O.O..\n"
                                      "...OO..\n"
                                      ".......\n"
                                      ".......\n");
    EXPECT_EQ(world.population(), 4);
}

TEST(WorldTest, ResizeKeepsTheCentreWhenShrinking)
{
    World world({7, 6});
    draw(world, {
                    "O......",
                    ".OOOOO.",
                    ".O...O.",
                    ".O.O.O.",
                    ".OOOOO.",
                    "......O",
                });
    world.resize({4, 3}, true);   // offset ((4 - 7) / 2, (3 - 6) / 2) = (-1, -1), truncated toward zero
    EXPECT_EQ(toAscii(world.cells()), "OOOO\n"
                                      "O...\n"
                                      "O.O.\n");
    EXPECT_EQ(world.population(), 7);
}

TEST(WorldTest, GrowingAndShrinkingBackRestoresThePattern)
{
    for (const Extent from : {Extent{4, 4}, Extent{5, 5}, Extent{4, 5}}) {
        for (const Extent to : {Extent{7, 7}, Extent{8, 8}, Extent{7, 8}, Extent{100, 1}}) {
            World world(from);
            world.randomize(0.5, 3);
            const Grid original = world.cells();
            world.resize({std::max(from.width, to.width), std::max(from.height, to.height)}, true);
            world.resize(from, true);
            EXPECT_EQ(world.cells(), original)
                << from.width << "x" << from.height << " via " << to.width << "x" << to.height;
        }
    }
}

TEST(WorldTest, ResizeWithoutKeepingClears)
{
    World world({6, 6});
    draw(world, kGlider);
    world.step();
    world.resize({9, 3}, false);
    EXPECT_EQ(world.extent(), (Extent{9, 3}));
    EXPECT_EQ(world.population(), 0);
    EXPECT_EQ(world.cells().countAlive(), 0);
    EXPECT_EQ(world.generation(), 0u);
}

TEST(WorldTest, OneByOneWorld)
{
    World world({3, 3});
    world.setCell({1, 1}, kAlive);
    world.resize({1, 1}, true);   // the centre cell survives
    EXPECT_EQ(world.population(), 1);
    EXPECT_EQ(world.at({0, 0}), kAlive);

    // On a 1×1 torus all eight neighbours are the cell itself: B3/S23 kills it, B/S8 keeps it.
    world.setRule(Rule::parse("B/S8").value());
    world.step();
    EXPECT_EQ(world.population(), 1);
    world.setRule(Rule{});
    world.step();
    EXPECT_EQ(world.population(), 0);

    world.setCell({0, 0}, kAlive);
    world.resize({3, 3}, true);
    EXPECT_EQ(toAscii(world.cells()), "...\n"
                                      ".O.\n"
                                      "...\n");
}

// Allocating an absurd size must throw without touching the world. Sanitizer allocators abort on such
// requests instead of throwing, so the test is skipped there.
#if defined(__SANITIZE_ADDRESS__) || defined(__SANITIZE_THREAD__)
constexpr bool kSanitizedAllocator = true;
#elif defined(__has_feature)
constexpr bool kSanitizedAllocator = __has_feature(address_sanitizer) || __has_feature(thread_sanitizer);
#else
constexpr bool kSanitizedAllocator = false;
#endif

TEST(WorldTest, FailedResizeLeavesTheWorldUnchanged)
{
    if (kSanitizedAllocator)
        GTEST_SKIP() << "sanitizer allocators do not throw std::bad_alloc";

    World world({8, 8});
    draw(world, kGlider, {2, 2});
    world.step();
    const Grid before = world.cells();

    const Coord huge = std::numeric_limits<Coord>::max() - 2;   // about 4 EiB per grid
    EXPECT_THROW(world.resize({huge, huge}, true), std::bad_alloc);
    EXPECT_EQ(world.extent(), (Extent{8, 8}));
    EXPECT_EQ(world.cells(), before);
    EXPECT_EQ(world.generation(), 1u);
    EXPECT_EQ(world.population(), 5);

    EXPECT_THROW(world.resize({huge, huge}, false), std::bad_alloc);
    EXPECT_EQ(world.cells(), before);
    EXPECT_EQ(world.generation(), 1u);
}

TEST(WorldTest, SetRuleChangesTheDynamics)
{
    // In HighLife (B36/S23) this pattern copies itself every 12 generations; in Conway's Life it does not.
    const Pattern replicator = {
        "..OOO", ".O..O", "O...O", "O..O.", "OOO..",
    };
    World world({21, 21});
    world.setRule(Rule::parse("B36/S23").value());
    draw(world, replicator, {8, 8});
    for (int g = 0; g < 12; ++g)
        world.step();

    World copies({21, 21});
    draw(copies, replicator, {6, 6});
    draw(copies, replicator, {10, 10});
    EXPECT_EQ(world.cells(), copies.cells());
    EXPECT_EQ(world.population(), 24);

    World conway({21, 21});
    draw(conway, replicator, {8, 8});
    for (int g = 0; g < 12; ++g)
        conway.step();
    EXPECT_NE(conway.cells(), copies.cells());
}

TEST(WorldTest, SetTopologyChangesTheNextStep)
{
    // A full row in a 3-high world: with wrapping, the rows above and below both see three neighbours.
    const Pattern row = {
        "...",
        "OOO",
        "...",
    };
    World world({3, 3}, Rule{}, Topology::Bounded);
    draw(world, row);
    world.step();
    EXPECT_EQ(toAscii(world.cells()), ".O.\n"
                                      ".O.\n"
                                      ".O.\n");

    world.clear();
    draw(world, row);
    world.setTopology(Topology::Torus);
    EXPECT_EQ(world.topology(), Topology::Torus);
    world.step();
    EXPECT_EQ(toAscii(world.cells()), "OOO\n"
                                      "OOO\n"
                                      "OOO\n");
}

TEST(WorldTest, SetStepperKeepsTheState)
{
    World banded({30, 20});
    banded.randomize(0.4, 8);
    for (int g = 0; g < 5; ++g)
        banded.step();

    World reference({30, 20});
    reference.randomize(0.4, 8);
    for (int g = 0; g < 5; ++g)
        reference.step();
    const Grid before = reference.cells();
    const CellCount population = reference.population();

    reference.setStepper(std::make_unique<ReferenceStepper>());
    EXPECT_EQ(reference.stepper().kind(), StepperKind::Reference);
    EXPECT_EQ(reference.cells(), before);
    EXPECT_EQ(reference.population(), population);
    EXPECT_EQ(reference.generation(), 5u);

    for (int g = 0; g < 20; ++g) {
        banded.step();
        reference.step();
    }
    EXPECT_EQ(reference.cells(), banded.cells());
    EXPECT_EQ(reference.population(), banded.population());
}

// ---- Langton's ant ---------------------------------------------------------------------------------

TEST(WorldTest, TheAntModeMovesEveryAntOncePerGeneration)
{
    World world({10, 10});
    world.setAutomaton(Automaton::LangtonAnt);
    world.setAnts(std::vector<Ant>{{{2, 2}, Heading::North}, {{7, 7}, Heading::South}});

    world.step();
    EXPECT_EQ(world.generation(), 1u);
    EXPECT_EQ(world.population(), 2);   // each ant lit the cell it stood on
    EXPECT_EQ(world.at({2, 2}), kAlive);
    EXPECT_EQ(world.at({7, 7}), kAlive);
    EXPECT_EQ(world.ants()[0], (Ant{{3, 2}, Heading::East}));
    EXPECT_EQ(world.ants()[1], (Ant{{6, 7}, Heading::West}));
    EXPECT_EQ(world.population(), world.cells().countAlive());
}

TEST(WorldTest, AntsShareTheGridInIndexOrder)
{
    // Both ants start on the same dead cell, so the first lights it and the second finds it alight.
    World world({9, 9});
    world.setAutomaton(Automaton::LangtonAnt);
    world.setAnts(std::vector<Ant>{{{4, 4}, Heading::North}, {{4, 4}, Heading::North}});

    world.step();
    EXPECT_EQ(world.at({4, 4}), kDead);
    EXPECT_EQ(world.population(), 0);
    EXPECT_EQ(world.ants()[0], (Ant{{5, 4}, Heading::East}));   // turned right on a dead cell
    EXPECT_EQ(world.ants()[1], (Ant{{3, 4}, Heading::West}));   // turned left on a live one
}

TEST(WorldTest, TheAntAlwaysWrapsWhateverTheTopology)
{
    for (const Topology topology : kTopologies) {
        SCOPED_TRACE(toString(topology));
        World world({4, 4}, Rule{}, topology);
        world.setAutomaton(Automaton::LangtonAnt);
        world.setAnts(std::vector<Ant>{{{0, 0}, Heading::West}});   // turns right to north, off the top

        world.step();
        EXPECT_EQ(world.ants()[0], (Ant{{0, 3}, Heading::North}));
        EXPECT_EQ(world.at({0, 0}), kAlive);
    }
}

TEST(WorldTest, SwitchingAutomatonKeepsTheCellsAndSeedsAnAnt)
{
    World world({9, 7});
    draw(world, kGlider, {1, 1});
    const Grid before = world.cells();
    EXPECT_EQ(world.automaton(), Automaton::Life);
    EXPECT_TRUE(world.ants().empty());

    world.setAutomaton(Automaton::LangtonAnt);
    EXPECT_EQ(world.automaton(), Automaton::LangtonAnt);
    EXPECT_EQ(world.cells(), before);
    ASSERT_EQ(world.ants().size(), 1u);
    EXPECT_EQ(world.ants()[0], defaultAnt(0, 1, world.extent()));

    world.step();
    const Ant moved = world.ants()[0];
    world.setAutomaton(Automaton::Life);   // the ant is kept, and a Life step leaves it alone
    ASSERT_EQ(world.ants().size(), 1u);
    EXPECT_EQ(world.ants()[0], moved);
    world.step();
    EXPECT_EQ(world.ants()[0], moved);
}

TEST(WorldTest, ClearAndRandomizePutTheAntsBack)
{
    World world({20, 12});
    world.setAutomaton(Automaton::LangtonAnt);
    world.resetAnts(3);
    const std::vector<Ant> start(world.ants().begin(), world.ants().end());
    ASSERT_EQ(start.size(), 3u);

    const auto run = [&] {
        for (int g = 0; g < 25; ++g)
            world.step();
    };

    run();
    EXPECT_NE(world.ants()[0], start[0]);
    world.clear();
    EXPECT_TRUE(std::ranges::equal(world.ants(), start));
    EXPECT_EQ(world.generation(), 0u);

    run();
    world.randomize(0.5, 9);
    EXPECT_TRUE(std::ranges::equal(world.ants(), start));
    EXPECT_EQ(world.generation(), 0u);
}

TEST(WorldTest, ResizeMovesTheAntsWithThePattern)
{
    World world({4, 4});
    world.setAutomaton(Automaton::LangtonAnt);
    world.setAnts(std::vector<Ant>{{{1, 1}, Heading::East}});

    world.resize({8, 8}, true);   // offset ((8 - 4) / 2, (8 - 4) / 2) = (2, 2)
    EXPECT_EQ(world.ants()[0], (Ant{{3, 3}, Heading::East}));
    world.resize({4, 4}, true);
    EXPECT_EQ(world.ants()[0], (Ant{{1, 1}, Heading::East}));

    // A world that cropped an ant pulls it back to the nearest edge.
    world.setAnts(std::vector<Ant>{{{3, 3}, Heading::North}});
    world.resize({2, 2}, true);   // offset (-1, -1)
    EXPECT_EQ(world.ants()[0].position, (CellPos{1, 1}));
    EXPECT_TRUE(world.extent().contains(world.ants()[0].position));

    world.resize({6, 5}, false);   // nothing kept, so the ants start over
    EXPECT_EQ(world.ants()[0], defaultAnt(0, 1, (Extent{6, 5})));
}

TEST(WorldTest, ToggleAntAtAddsAndRemoves)
{
    World world({6, 6});
    EXPECT_TRUE(world.toggleAntAt({2, 3}));
    ASSERT_EQ(world.ants().size(), 1u);
    EXPECT_EQ(world.ants()[0], (Ant{{2, 3}, Heading::North}));

    EXPECT_FALSE(world.toggleAntAt({2, 3}));
    EXPECT_TRUE(world.ants().empty());

    EXPECT_FALSE(world.toggleAntAt({-1, 0}));   // outside the world
    EXPECT_FALSE(world.toggleAntAt({6, 6}));
    EXPECT_TRUE(world.ants().empty());

    World crowded({kMaxAnts + 1, 1});
    for (Coord x = 0; x < kMaxAnts; ++x)
        EXPECT_TRUE(crowded.toggleAntAt({x, 0})) << "ant " << x;
    EXPECT_FALSE(crowded.toggleAntAt({kMaxAnts, 0}));   // kMaxAnts is the limit
    EXPECT_EQ(crowded.ants().size(), static_cast<std::size_t>(kMaxAnts));
}

// Langton's ant is chaotic for about ten thousand moves and then starts building a "highway": the same
// 104 moves over and over, each time two cells further down the diagonal and twelve live cells heavier.
// These numbers pin the turn rule, the wrapping and World's incremental population count at once.
TEST(WorldTest, TheAntBuildsTheKnownHighway)
{
    constexpr int kChaos = 9977;   // moves before the highway begins
    constexpr int kPeriod = 104;
    constexpr Coord kShiftX = -2;
    constexpr Coord kShiftY = 2;

    // Wide enough that the ant never reaches an edge here, so wrapping cannot disturb the pattern.
    World world({128, 128});
    world.setAutomaton(Automaton::LangtonAnt);
    const CellPos start = world.ants()[0].position;
    const auto run = [&](int moves) {
        for (int i = 0; i < moves; ++i)
            world.step();
    };

    run(kChaos);
    EXPECT_EQ(world.population(), 715);
    EXPECT_EQ(world.ants()[0], (Ant{{start.x - 15, start.y - 10}, Heading::West}));

    for (int period = 0; period < 10; ++period) {
        SCOPED_TRACE(std::format("period {}", period));
        const Ant before = world.ants()[0];
        const CellCount population = world.population();
        run(kPeriod);
        EXPECT_EQ(world.ants()[0].heading, before.heading);
        EXPECT_EQ(world.ants()[0].position,
                  (CellPos{before.position.x + kShiftX, before.position.y + kShiftY}));
        EXPECT_EQ(world.population(), population + 12);
    }

    // By now the ant has left the chaotic core behind, so its whole neighbourhood is a plain copy.
    const Grid before = world.cells();
    const CellPos at = world.ants()[0].position;
    run(kPeriod);
    const CellPos moved = world.ants()[0].position;
    constexpr Coord kRadius = 16;
    for (Coord dy = -kRadius; dy <= kRadius; ++dy) {
        for (Coord dx = -kRadius; dx <= kRadius; ++dx) {
            ASSERT_EQ(before.at({at.x + dx, at.y + dy}), world.cells().at({moved.x + dx, moved.y + dy}))
                << "at (" << dx << ", " << dy << ")";
        }
    }
    EXPECT_EQ(world.population(), world.cells().countAlive());
}

}
}
