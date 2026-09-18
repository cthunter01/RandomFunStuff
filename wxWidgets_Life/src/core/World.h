#pragma once

#include "core/Ant.h"
#include "core/Grid.h"
#include "core/Rule.h"
#include "core/Stepper.h"
#include "core/Types.h"

#include <cstdint>
#include <memory>
#include <span>
#include <vector>

namespace life::core {

/// The simulation model: current generation, automaton, rule, topology, stepping engine and counters.
/// @note Not thread-safe; the UI thread owns it. step() and randomize() use worker threads
///       internally and return only after they have finished.
/// @note Every ant is always inside the world: setAnts(), resetAnts(), toggleAntAt() and resize() are
///       the four places that have to keep it that way.
class World {
public:
    /// Uses a BandedStepper. @pre validateExtent(extent, ...) succeeded. @throws std::bad_alloc
    explicit World(Extent extent, Rule rule = {}, Topology topology = Topology::Torus);

    [[nodiscard]] Extent extent() const noexcept;
    [[nodiscard]] const Grid& cells() const noexcept;
    [[nodiscard]] Cell at(CellPos p) const noexcept;   ///< @pre extent().contains(p)
    [[nodiscard]] const Rule& rule() const noexcept;
    [[nodiscard]] Topology topology() const noexcept;
    [[nodiscard]] Automaton automaton() const noexcept;
    [[nodiscard]] std::span<const Ant> ants() const noexcept;   ///< Every ant is inside the world.
    [[nodiscard]] const Stepper& stepper() const noexcept;
    [[nodiscard]] std::uint64_t generation() const noexcept;
    [[nodiscard]] CellCount population() const noexcept;   ///< Kept up to date incrementally.

    /// Advances one generation: a whole Life step, or one move for each ant in turn.
    void step();

    /// Sets every listed cell; positions outside the world are ignored. generation is unchanged.
    /// @pre value is kDead or kAlive
    /// @return number of cells that actually changed.
    CellCount setCells(std::span<const CellPos> cells, Cell value) noexcept;
    bool setCell(CellPos p, Cell value) noexcept;   ///< @return true if the cell changed.
    void clear() noexcept;                          ///< All dead; generation = 0; the ants start over.
    /// Each cell becomes alive with probability `density` (clamped to [0, 1], resolution 1/256).
    /// The result depends only on (seed, extent, density), never on the thread count. generation = 0,
    /// and the ants start over: generation 0 means they are back on their starting spots.
    void randomize(double density, std::uint64_t seed);
    /// Changes the size. keepPattern keeps the overlapping region centred, the generation and the ants,
    /// which move with the pattern and are pulled back inside a world that cropped them; otherwise the
    /// world is cleared, generation = 0 and the ants start over.
    /// Strong exception guarantee. @throws std::bad_alloc
    /// @note The old and the new grids exist at the same time, so the peak memory is
    ///       worldBytes(old) + worldBytes(new).
    void resize(Extent newExtent, bool keepPattern);
    void setRule(const Rule& rule) noexcept;
    void setTopology(Topology topology) noexcept;
    /// Switching to LangtonAnt with no ants yet puts one in the middle. Switching to Life keeps the ants,
    /// so going back and forth loses nothing.
    void setAutomaton(Automaton automaton);
    void setAnts(std::span<const Ant> ants);   ///< Ants outside the world are dropped; at most kMaxAnts.
    void resetAnts(int count);                 ///< `count` ants (clamped to [0, kMaxAnts]) on their spots.
    /// Adds an ant facing north, or removes every ant already standing there. Outside the world: no-op.
    /// @return true if an ant was added, false otherwise.
    bool toggleAntAt(CellPos p) noexcept;
    void setStepper(std::unique_ptr<Stepper> stepper) noexcept;   ///< @pre stepper != nullptr

private:
    /// Puts the ants back on their starting spots, keeping how many there are. Never allocates.
    void layOutAnts() noexcept;

    Grid current_;
    Grid next_;   ///< Only the Life automaton uses it; the ants work on current_ alone.
    Rule rule_;
    Topology topology_;
    Automaton automaton_ = Automaton::Life;
    std::vector<Ant> ants_;
    std::unique_ptr<Stepper> stepper_;
    std::uint64_t generation_ = 0;
    CellCount population_ = 0;
};

}
