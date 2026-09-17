#include "core/ParallelBands.hpp"

namespace life::core {

unsigned suggestedBandCount(CellCount cells, unsigned maxThreads, CellCount minCellsPerBand) noexcept
{
    // A band on an efficiency core is about 2.4x slower, and every step waits for its slowest band, so
    // splitting pays only with at least 4 bands. Deciding this first also skips hardware_concurrency(),
    // which reads sysfs on every call.
    const CellCount wanted = cells / std::max(minCellsPerBand, CellCount{1});
    if (wanted < 4)
        return 1;
    if (maxThreads == 0)
        maxThreads = std::max(std::thread::hardware_concurrency(), 1u);   // 0 means "unknown"
    return static_cast<unsigned>(std::min(wanted, CellCount{maxThreads}));
}

}
