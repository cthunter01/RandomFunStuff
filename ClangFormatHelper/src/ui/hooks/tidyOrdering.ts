/**
 * Ordering for the check list — the same rules as the option list (`ordering.ts`).
 *
 * Static by default: modules in a fixed reading order, checks alphabetical within
 * each. Enabling or disabling a check never moves it. Ranking by findings is
 * opt-in, and only ever changes when a new analysis lands.
 */

import type { Survey } from '../../core/tidy/analysis.ts';

/**
 * Modules in the order they are presented: the broadly useful ones first, then
 * the house styles of particular projects, which most people never enable.
 * Anything not listed sorts after these, alphabetically.
 */
export const MODULE_ORDER: readonly string[] = [
    'bugprone',
    'clang-analyzer',
    'performance',
    'modernize',
    'readability',
    'misc',
    'cppcoreguidelines',
    'cert',
    'concurrency',
    'portability',
    'google',
    'llvm',
];

export function moduleRank(module: string): number {
    const index = MODULE_ORDER.indexOf(module);
    return index === -1 ? MODULE_ORDER.length : index;
}

export function compareModules(a: string, b: string): number {
    return moduleRank(a) - moduleRank(b) || a.localeCompare(b);
}

export type TidySortMode = 'static' | 'findings';

export function findingCount(survey: Survey | null, check: string): number {
    return survey?.findings.get(check)?.diagnostics.length ?? 0;
}

/**
 * Compares two checks within a module. In `static` mode this is the name alone —
 * there is no argument through which an edit could move a row.
 */
export function compareChecks(a: string, b: string, mode: TidySortMode, survey: Survey | null): number {
    if (mode === 'findings' && survey) {
        const difference = findingCount(survey, b) - findingCount(survey, a);
        if (difference !== 0) return difference;
    }
    return a.localeCompare(b);
}
