#include "core/BandedStepper.h"

#include "core/StepKernel.h"

#include <cassert>
#include <cstddef>
#include <numeric>

namespace life::core {

BandedStepper::BandedStepper(unsigned maxThreads, CellCount minCellsPerBand) noexcept
    : maxThreads_(maxThreads), minCellsPerBand_(minCellsPerBand)
{
}

CellCount BandedStepper::step(const Grid& src, Grid& dst, const Rule& rule, Topology /*topology*/)
{
    // The topology is already in src's ghost border.
    assert(dst.extent() == src.extent());
    const Extent extent = src.extent();
    const auto width = static_cast<std::size_t>(extent.width);
    const unsigned bands = suggestedBandCount(extent.cellCount(), maxThreads_, minCellsPerBand_);

    // Size the scratch here, so the band jobs never allocate. Each band owns one slot of each vector.
    columnSums_.resize(bands);
    for (std::vector<std::uint8_t>& sums : columnSums_)
        sums.resize(width + 2);
    bandPopulation_.assign(bands, 0);

    const Rule::KernelMasks masks = rule.kernelMasks();
    forEachBand(extent.height, bands, [&](unsigned band, Coord firstRow, Coord endRow) {
        CellCount population = 0;
        for (Coord y = firstRow; y < endRow; ++y) {
            population += kernel::stepRow(src.paddedRow(y - 1).data(), src.paddedRow(y).data(),
                                          src.paddedRow(y + 1).data(), dst.row(y).data(),
                                          columnSums_[band].data(), width, masks);
        }
        bandPopulation_[band] = population;
    });
    return std::reduce(bandPopulation_.begin(), bandPopulation_.end(), CellCount{0});
}

}
