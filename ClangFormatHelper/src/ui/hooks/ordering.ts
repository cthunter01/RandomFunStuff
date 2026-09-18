/**
 * Ordering for the option list.
 *
 * The order is **static by default**, and that is a deliberate choice rather than
 * an absence of one. An earlier version ranked rows by impact and pushed anything
 * you had changed to the top, which meant the row you were editing jumped out from
 * under the cursor the moment you touched it. A settings list you cannot build
 * muscle memory for is worse than one that is merely unsorted.
 *
 * So: groups in a fixed reading order, options alphabetical within each group.
 * Nothing an edit can do changes any of it. Ranking by impact is still available,
 * but it is opt-in and it too is stable while you edit, because the impact results
 * are kept (and marked stale) rather than thrown away on every keystroke.
 */

import type { OptionDescriptor } from '../../core/catalog/types.ts';
import type { ImpactMap } from '../../core/analysis/impact.ts';

/**
 * Groups in the order they are presented, roughly most- to least-reached-for.
 * Anything not listed sorts after these, alphabetically.
 */
export const GROUP_ORDER: readonly string[] = [
    'Indentation',
    'Braces',
    'Line breaking',
    'Short constructs',
    'Alignment',
    'Spaces',
    'Pointers & qualifiers',
    'Comments',
    'Includes',
    'Macros',
    'Cleanup & sorting',
    'Penalties',
    'Language-specific',
    'Other',
];

export function groupRank(group: string): number {
    const index = GROUP_ORDER.indexOf(group);
    return index === -1 ? GROUP_ORDER.length : index;
}

export interface Orderable {
    option: OptionDescriptor;
    path: string;
}

export type SortMode = 'static' | 'impact';

/** Compares two groups. Never depends on the current config, so it cannot shift. */
export function compareGroups(a: string, b: string): number {
    return groupRank(a) - groupRank(b) || a.localeCompare(b);
}

/**
 * Compares two rows within a group.
 *
 * In `static` mode this is purely the option name, so the position of a row is a
 * function of the catalog alone. In `impact` mode rows with a measured effect come
 * first, largest first — but still only ever re-orders when a *new analysis* lands,
 * never when a value changes.
 */
export function compareRows<T extends Orderable>(a: T, b: T, mode: SortMode, impact: ImpactMap | null): number {
    if (mode === 'impact' && impact) {
        const rank = (row: T): number => {
            const result = impact.get(row.path);
            if (!result) return -1;
            return result.verdict === 'live' ? result.magnitude : result.verdict === 'unknown' ? -1 : -2;
        };
        const difference = rank(b) - rank(a);
        if (difference !== 0) return difference;
    }
    return a.option.name.localeCompare(b.option.name);
}
