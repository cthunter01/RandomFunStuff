#include "core/Stepper.h"

#include "core/BandedStepper.h"
#include "core/ReferenceStepper.h"

#include <algorithm>

namespace life::core {

std::optional<StepperKind> parseStepperKind(std::string_view name) noexcept
{
    const auto lower = [](char c) { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; };
    const auto sameLetter = [&](char a, char b) { return lower(a) == lower(b); };
    for (const StepperKind kind : kStepperKinds) {
        if (std::ranges::equal(name, toString(kind), sameLetter))
            return kind;
    }
    return std::nullopt;
}

std::unique_ptr<Stepper> makeStepper(StepperKind kind, unsigned maxThreads)
{
    switch (kind) {
    case StepperKind::Banded:
        return std::make_unique<BandedStepper>(maxThreads);
    case StepperKind::Reference:
        return std::make_unique<ReferenceStepper>();
    }
    std::unreachable();
}

}
