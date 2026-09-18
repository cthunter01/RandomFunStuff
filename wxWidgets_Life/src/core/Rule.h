#pragma once

#include "core/Types.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace life::core {

/// Why Rule::parse() rejected a text.
enum class RuleError : std::uint8_t { Empty, Syntax, NeighbourOutOfRange };

/// Message for the user.
[[nodiscard]] constexpr std::string_view describe(RuleError e) noexcept
{
    switch (e) {
    case RuleError::Empty:
        return "Enter a rule such as B3/S23.";
    case RuleError::Syntax:
        return "Rules look like B3/S23: digits after B and S.";
    case RuleError::NeighbourOutOfRange:
        return "Neighbour counts go from 0 to 8.";
    }
    std::unreachable();
}

/// Two-state outer-totalistic rule in B/S notation, e.g. "B3/S23".
class Rule {
public:
    using Mask = std::uint16_t;   ///< Bit n set = applies to a cell with n live neighbours (n = 0..8).

    /// Masks indexed by the 3×3 sum *including* the centre cell: next = (mask >> sum) & 1.
    struct KernelMasks {
        std::uint32_t dead;    ///< == birth mask (a dead centre adds 0)
        std::uint32_t alive;   ///< == survival mask << 1 (a live centre adds 1)
    };

    constexpr Rule() noexcept = default;   ///< Conway's Life, B3/S23.
    /// Bits above 8 are dropped.
    constexpr Rule(Mask birth, Mask survival) noexcept
        : birth_(static_cast<Mask>(birth & kAllCounts)), survival_(static_cast<Mask>(survival & kAllCounts))
    {
    }

    /// Accepts "B3/S23", "b36/s23", "S23/B3", "B3S23", "B/S", and the legacy survival/birth form "23/3"
    /// (which needs its slash). Letters are case-insensitive; surrounding whitespace is ignored.
    [[nodiscard]] static constexpr std::expected<Rule, RuleError> parse(std::string_view text) noexcept;
    [[nodiscard]] std::string toString() const;   ///< Canonical form, e.g. "B36/S23".

    /// @pre liveNeighbours <= 8
    [[nodiscard]] constexpr Cell nextState(bool alive, unsigned liveNeighbours) const noexcept
    {
        return static_cast<Cell>((unsigned{alive ? survival_ : birth_} >> liveNeighbours) & 1u);
    }
    [[nodiscard]] constexpr KernelMasks kernelMasks() const noexcept
    {
        return {birth_, static_cast<std::uint32_t>(survival_) << 1};
    }
    [[nodiscard]] constexpr Mask birthMask() const noexcept { return birth_; }
    [[nodiscard]] constexpr Mask survivalMask() const noexcept { return survival_; }
    friend constexpr bool operator==(const Rule&, const Rule&) noexcept = default;

private:
    static constexpr Mask kAllCounts = 0x1FF;
    Mask birth_ = 1u << 3;
    Mask survival_ = (1u << 2) | (1u << 3);
};

// Defined outside the class: std::expected<Rule, ...> needs the complete Rule.
constexpr std::expected<Rule, RuleError> Rule::parse(std::string_view text) noexcept
{
    constexpr std::string_view kSpace = " \t\n\v\f\r";
    const std::size_t first = text.find_first_not_of(kSpace);
    if (first == std::string_view::npos)
        return std::unexpected(RuleError::Empty);
    text = text.substr(first, text.find_last_not_of(kSpace) + 1 - first);

    const auto lower = [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; };
    const auto isLetter = [&](char c) { return lower(c) == 'b' || lower(c) == 's'; };
    const bool legacy = !isLetter(text.front());   // "23/3": survival digits, '/', birth digits

    Mask birth = 0;
    Mask survival = 0;
    bool toBirth = false;   // which mask the next digit goes to
    bool seenB = false;
    bool seenS = false;
    bool seenSlash = false;
    for (std::size_t i = 0; i < text.size(); ++i) {
        const char c = lower(text[i]);
        if (c >= '0' && c <= '8') {
            Mask& mask = toBirth ? birth : survival;
            mask = static_cast<Mask>(unsigned{mask} | (1u << static_cast<unsigned>(c - '0')));
        } else if (c == '9') {
            return std::unexpected(RuleError::NeighbourOutOfRange);
        } else if (c == '/') {
            // At most one slash; in the B/S form it may only separate the two parts.
            const bool beforeLetter = i + 1 < text.size() && isLetter(text[i + 1]);
            if (seenSlash || (!legacy && !beforeLetter))
                return std::unexpected(RuleError::Syntax);
            seenSlash = true;
            if (legacy)
                toBirth = true;
        } else if (!legacy && c == 'b' && !seenB) {
            seenB = true;
            toBirth = true;
        } else if (!legacy && c == 's' && !seenS) {
            seenS = true;
            toBirth = false;
        } else {
            return std::unexpected(RuleError::Syntax);
        }
    }
    if (legacy && !seenSlash)   // "23" alone is ambiguous
        return std::unexpected(RuleError::Syntax);
    return Rule{birth, survival};
}

/// A rule with its display name, for the preset list.
struct NamedRule {
    std::string_view name;
    Rule rule;
};

/// Built-in presets in UI order. `.value()` makes a typo a compile error.
inline constexpr std::array kRulePresets{
    NamedRule{"Conway's Life", Rule::parse("B3/S23").value()},
    NamedRule{"HighLife", Rule::parse("B36/S23").value()},
    NamedRule{"Seeds", Rule::parse("B2/S").value()},
    NamedRule{"Day & Night", Rule::parse("B3678/S34678").value()},
    NamedRule{"Life without Death", Rule::parse("B3/S012345678").value()},
    NamedRule{"Maze", Rule::parse("B3/S12345").value()},
    NamedRule{"2x2", Rule::parse("B36/S125").value()},
    NamedRule{"Replicator", Rule::parse("B1357/S1357").value()},
    NamedRule{"Diamoeba", Rule::parse("B35678/S5678").value()},
    NamedRule{"Morley", Rule::parse("B368/S245").value()},
};

/// Index into kRulePresets of the preset equal to `rule`, if there is one.
[[nodiscard]] constexpr std::optional<std::size_t> findPreset(const Rule& rule) noexcept
{
    for (std::size_t i = 0; i < kRulePresets.size(); ++i) {
        if (kRulePresets[i].rule == rule)
            return i;
    }
    return std::nullopt;
}

}
