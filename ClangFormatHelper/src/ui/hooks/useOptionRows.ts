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
import { compareGroups, compareRows } from './ordering.ts';

export interface OptionRow {
    option: OptionDescriptor;
    path: string;
    value: ConfigValue | undefined;
    overridden: boolean;
    /** True when this option is specific to some other language. */
    foreign: boolean;
}

export interface OptionGroupRows {
    group: string;
    rows: OptionRow[];
}

export function useOptionRows(): { groups: OptionGroupRows[]; total: number; shown: number } {
    const { state } = useStore();
    const { doc, search, hideInert, onlyOverridden, impact, effective, sortMode } = state;
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

            // A hint, not a fact: these are marked but never hidden or moved.
            const foreign =
                option.languageHints.length > 0 && !option.languageHints.includes(language.clangLanguage);

            const row: OptionRow = {
                option,
                path,
                value: effective?.values.get(path),
                overridden: doc.overrides.has(path),
                foreign,
            };
            const bucket = groups.get(option.group);
            if (bucket) bucket.push(row);
            else groups.set(option.group, [row]);
            shown++;
        }

        const ordered = [...groups.entries()]
            .map(([group, rows]) => ({ group, rows: rows.sort((a, b) => compareRows(a, b, sortMode, impact)) }))
            .sort((a, b) => compareGroups(a.group, b.group));

        return { groups: ordered, total: catalog.options.length, shown };
    }, [doc, search, hideInert, onlyOverridden, impact, effective, language, sortMode]);
}
