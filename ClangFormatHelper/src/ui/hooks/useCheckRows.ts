/**
 * Turns the check catalog plus current state into the rows the Tidy panels render.
 *
 * Shared by the check rail and the card feed so the two cannot disagree about
 * what "matches your search" or "found nothing here" means.
 */

import { useMemo } from 'react';
import type { CheckFindings } from '../../core/tidy/analysis.ts';
import type { TidyCheckDescriptor } from '../../core/tidy/catalog.ts';
import { isCheckEnabled, parseChecks } from '../../core/tidy/checks.ts';
import { useTidyStore } from '../state/tidyStore.tsx';
import { compareChecks, compareModules } from './tidyOrdering.ts';

export interface CheckRow {
    check: TidyCheckDescriptor;
    enabled: boolean;
    findings: CheckFindings | undefined;
    /** The analysis ran this check and it found nothing. */
    silent: boolean;
}

export interface ModuleRows {
    module: string;
    description: string;
    rows: CheckRow[];
    /** Across the whole module, ignoring filters — for the module header. */
    total: number;
    enabledCount: number;
}

export function useCheckRows(): { modules: ModuleRows[]; total: number; shown: number } {
    const { state } = useTidyStore();
    const { catalog, doc, enabled, survey, search, onlyEnabled, hideSilent, sortMode } = state;

    return useMemo(() => {
        if (!catalog) return { modules: [], total: 0, shown: 0 };
        const builtin = parseChecks(catalog.defaultChecks);
        const needle = search.trim().toLowerCase();
        const descriptions = new Map(catalog.modules.map((m) => [m.name, m.description]));
        const byModule = new Map<string, ModuleRows>();
        let shown = 0;

        for (const check of catalog.checks) {
            // The binary's answer when we have it; the glob model fills in while it is on its way.
            const on = enabled ? enabled.has(check.name) : isCheckEnabled(doc.checks, check.name, builtin);
            let group = byModule.get(check.module);
            if (!group) {
                group = {
                    module: check.module,
                    description: descriptions.get(check.module) ?? '',
                    rows: [],
                    total: 0,
                    enabledCount: 0,
                };
                byModule.set(check.module, group);
            }
            group.total++;
            if (on) group.enabledCount++;

            const findings = survey?.findings.get(check.name);
            const silent = survey !== null && survey.covered.has(check.name) && !findings;
            if (needle && !check.name.toLowerCase().includes(needle) && !check.summary.toLowerCase().includes(needle)) {
                continue;
            }
            if (onlyEnabled && !on) continue;
            if (hideSilent && silent) continue;
            group.rows.push({ check, enabled: on, findings, silent });
            shown++;
        }

        const modules = [...byModule.values()]
            .map((m) => ({ ...m, rows: m.rows.sort((a, b) => compareChecks(a.check.name, b.check.name, sortMode, survey)) }))
            .sort((a, b) => compareModules(a.module, b.module));
        return { modules, total: catalog.checks.length, shown };
    }, [catalog, doc.checks, enabled, survey, search, onlyEnabled, hideSilent, sortMode]);
}
