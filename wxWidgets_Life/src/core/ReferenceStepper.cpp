#include "core/ReferenceStepper.h"

#include <cassert>

namespace life::core {

CellCount ReferenceStepper::step(const Grid& src, Grid& dst, const Rule& rule, Topology topology)
{
    assert(dst.extent() == src.extent());
    const Extent extent = src.extent();
    const Coord width = extent.width;
    const Coord height = extent.height;

    // 1 if the cell at (x, y) is alive. Coordinates may lie one cell outside the world.
    const auto alive = [&](Coord x, Coord y) -> unsigned {
        switch (topology) {
        case Topology::Bounded:
            if (!extent.contains({x, y}))
                return 0;
            break;
        case Topology::Torus:
            x = ((x % width) + width) % width;   // % keeps the sign of x, so -1 needs the extra + width
            y = ((y % height) + height) % height;
            break;
        }
        return src.at({x, y});
    };

    CellCount population = 0;
    for (Coord y = 0; y < height; ++y) {
        for (Coord x = 0; x < width; ++x) {
            unsigned neighbours = 0;
            for (Coord dy = -1; dy <= 1; ++dy) {
                for (Coord dx = -1; dx <= 1; ++dx) {
                    if (dx != 0 || dy != 0)
                        neighbours += alive(x + dx, y + dy);
                }
            }
            const Cell next = rule.nextState(src.at({x, y}) == kAlive, neighbours);
            dst.set({x, y}, next);
            population += next;
        }
    }
    return population;
}

}
