#pragma once

#include "core/Grid.hpp"
#include "core/ParallelBands.hpp"
#include "core/Rule.hpp"
#include "core/Stepper.hpp"
#include "core/Types.hpp"

#include <cstdint>
#include <vector>

namespace life::core {

/// Production stepper: kernel::stepRow over row bands that run in parallel.
class BandedStepper final : public Stepper {
public:
    /// @param maxThreads 0 = hardware concurrency.
    /// @param minCellsPerBand Tests pass 1 to force many bands.
    explicit BandedStepper(unsigned maxThreads = 0, CellCount minCellsPerBand = kMinCellsPerBand) noexcept;

    [[nodiscard]] StepperKind kind() const noexcept override { return StepperKind::Banded; }
    CellCount step(const Grid& src, Grid& dst, const Rule& rule, Topology topology) override;

private:
    unsigned maxThreads_;
    CellCount minCellsPerBand_;
    /// One scratch row per band, sized before the bands start.
    std::vector<std::vector<std::uint8_t>> columnSums_;
    std::vector<CellCount> bandPopulation_;
};

}
