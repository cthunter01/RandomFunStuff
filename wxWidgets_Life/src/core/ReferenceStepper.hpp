#pragma once

#include "core/Grid.hpp"
#include "core/Rule.hpp"
#include "core/Stepper.hpp"
#include "core/Types.hpp"

namespace life::core {

/// The executable specification: counts all eight neighbours of every cell with explicit edge rules.
/// It ignores ghost cells. Slow on purpose: read it first, and use it as the oracle in tests.
class ReferenceStepper final : public Stepper {
public:
    static constexpr CellCount kRecommendedMaxCells = 1'000'000;   ///< The UI offers it only up to this size.

    [[nodiscard]] StepperKind kind() const noexcept override { return StepperKind::Reference; }
    CellCount step(const Grid& src, Grid& dst, const Rule& rule, Topology topology) override;
};

}
