#pragma once

#include "core/Speed.h"
#include "core/Types.h"
#include "render/Types.h"

#include <chrono>

namespace life::ui::defaults {

inline constexpr core::Extent kWorldExtent{512, 512};
inline constexpr core::Topology kTopology = core::Topology::Torus;
inline constexpr core::Speed kSpeed{.gensPerSecond = 30};
inline constexpr int kCellSize = 4;   ///< Used until the first fit.
inline constexpr bool kShowGrid = true;
inline constexpr int kRandomDensityPercent = 25;
inline constexpr int kAntCount = 1;   ///< Ants the panel starts with; the world seeds one with the mode.
inline constexpr int kControlPanelWidthDip = 260;
inline constexpr int kFrameWidthDip = 1280, kFrameHeightDip = 860;
inline constexpr int kMinFrameWidthDip = 800, kMinFrameHeightDip = 520;
inline constexpr std::chrono::milliseconds kStatusRefresh{100};    ///< Status bar updates at most this often.
inline constexpr render::Rgb kErrorTextOnDark{0xFF, 0x8A, 0x80};   ///< Error lines on dark themes.
inline constexpr render::Rgb kErrorTextOnLight{0xC6, 0x28, 0x28};   ///< Error lines on light themes.

}
