#pragma once

#include "core/Grid.hpp"
#include "core/Rule.hpp"
#include "core/Stepper.hpp"
#include "core/Types.hpp"

#include <cstdint>
#include <memory>
#include <span>

namespace life::core {

/// The simulation model: current generation, rule, topology, stepping engine and counters.
/// @note Not thread-safe; the UI thread owns it. step() and randomize() use worker threads
///       internally and return only after they have finished.
class World {
public:
    /// Uses a BandedStepper. @pre validateExtent(extent, ...) succeeded. @throws std::bad_alloc
    explicit World(Extent extent, Rule rule = {}, Topology topology = Topology::Torus);

    [[nodiscard]] Extent extent() const noexcept;
    [[nodiscard]] const Grid& cells() const noexcept;
    [[nodiscard]] Cell at(CellPos p) const noexcept;   ///< @pre extent().contains(p)
    [[nodiscard]] const Rule& rule() const noexcept;
    [[nodiscard]] Topology topology() const noexcept;
    [[nodiscard]] const Stepper& stepper() const noexcept;
    [[nodiscard]] std::uint64_t generation() const noexcept;
    [[nodiscard]] CellCount population() const noexcept;   ///< Kept up to date incrementally.

    void step();   ///< Advances one generation.

    /// Sets every listed cell; positions outside the world are ignored. generation is unchanged.
    /// @pre value is kDead or kAlive
    /// @return number of cells that actually changed.
    CellCount setCells(std::span<const CellPos> cells, Cell value) noexcept;
    bool setCell(CellPos p, Cell value) noexcept;   ///< @return true if the cell changed.
    void clear() noexcept;                          ///< All dead; generation = 0.
    /// Each cell becomes alive with probability `density` (clamped to [0, 1], resolution 1/256).
    /// The result depends only on (seed, extent, density), never on the thread count. generation = 0.
    void randomize(double density, std::uint64_t seed);
    /// Changes the size. keepPattern keeps the overlapping region centred and the generation; otherwise
    /// the world is cleared and generation = 0. Strong exception guarantee. @throws std::bad_alloc
    /// @note The old and the new grids exist at the same time, so the peak memory is
    ///       worldBytes(old) + worldBytes(new).
    void resize(Extent newExtent, bool keepPattern);
    void setRule(const Rule& rule) noexcept;
    void setTopology(Topology topology) noexcept;
    void setStepper(std::unique_ptr<Stepper> stepper) noexcept;   ///< @pre stepper != nullptr

private:
    Grid current_;
    Grid next_;
    Rule rule_;
    Topology topology_;
    std::unique_ptr<Stepper> stepper_;
    std::uint64_t generation_ = 0;
    CellCount population_ = 0;
};

}
