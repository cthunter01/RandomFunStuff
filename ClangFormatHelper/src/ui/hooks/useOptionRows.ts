/**
 * Turns the catalog plus current state into the rows a panel renders.
 *
 * Shared by the option rail and the card feed so the two layouts cannot disagree
 * about what "matching your search" or "affects your code" means.
 */

import { useMemo } from 'react';
import type { OptionDescriptor } from '../../core/catalog/types.ts';
import type { ConfigValue } from '../../core/config/model.ts';
import { getLanguage } from '../../core/languages/registry.ts';
import { catalog, useStore } from '../state/store.tsx';

export interface OptionRow {
    option: OptionDescriptor;
    path: string;
    value: ConfigValue | undefined;
    overridden: boolean;
    /** Ranking key: live options with the biggest effect first. */
    weight: number;
}

export interface OptionGroupRows {
    group: string;
    rows: OptionRow[];
}

export function useOptionRows(): { groups: OptionGroupRows[]; total: number; shown: number } {
    const { state } = useStore();
    const { doc, search, hideInert, onlyOverridden, impact, effective } = state;
    const language = getLanguage(doc.languageId);

    return useMemo(() => {
        const needle = search.trim().toLowerCase();
        const groups = new Map<string, OptionRow[]>();
        let shown = 0;

        for (const option of catalog.options) {
            if (option.deprecated) continue;
            const path = option.name;
            const result = impact?.get(path);

            if (needle && !option.name.toLowerCase().includes(needle) && !option.doc.toLowerCase().includes(needle)) {
                continue;
            }
            if (onlyOverridden && !doc.overrides.has(path)) continue;
            if (hideInert && result?.verdict === 'inert') continue;

            // Language-specific options that cannot apply here sink to the bottom
            // rather than disappearing: the hint is a heuristic, not a fact.
            const foreign =
                option.languageHints.length > 0 && !option.languageHints.includes(language.clangLanguage);

            const weight =
                (result?.verdict === 'live' ? 10_000 + result.magnitude : 0) +
                (doc.overrides.has(path) ? 5_000 : 0) +
                (language.signatureOptions.includes(option.name) ? 1_000 : 0) -
                (foreign ? 500 : 0);

            const row: OptionRow = {
                option,
                path,
                value: effective?.values.get(path),
                overridden: doc.overrides.has(path),
                weight,
            };
            const bucket = groups.get(option.group);
            if (bucket) bucket.push(row);
            else groups.set(option.group, [row]);
            shown++;
        }

        const ordered = [...groups.entries()]
            .map(([group, rows]) => ({
                group,
                rows: rows.sort((a, b) => b.weight - a.weight || a.option.name.localeCompare(b.option.name)),
            }))
            .sort((a, b) => {
                const best = (g: OptionGroupRows) => g.rows[0]?.weight ?? 0;
                return best(b) - best(a) || a.group.localeCompare(b.group);
            });

        return { groups: ordered, total: catalog.options.length, shown };
    }, [doc, search, hideInert, onlyOverridden, impact, effective, language]);
}
