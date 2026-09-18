/**
 * Resolves what clang-format will *actually* do, as opposed to what the user typed.
 *
 * Every displayed value comes from round-tripping the config through the real
 * binary's `dump_config`, never from our own notion of defaults. That matters
 * because clang-format derives values the app does not model — most visibly,
 * `BreakBeforeBraces: Allman` rewrites all 18 `BraceWrapping` flags. Showing the
 * dumped value, tagged as `derived`, is how that becomes visible instead of
 * mysterious.
 */

import yaml from 'js-yaml';
import { flatten, valuesEqual, type ConfigPath, type ConfigValue, type StyleDocument } from './model.ts';

/** Where a value came from, which the UI shows as a badge. */
export type Provenance =
    | 'base'
    /** The user set it, and clang-format honoured it. */
    | 'override'
    /** clang-format computed it — either from another option, or ignoring an override. */
    | 'derived'
    /** The user set it and clang-format ignored it. Almost always a missing prerequisite. */
    | 'ignored';

export interface EffectiveConfig {
    values: ReadonlyMap<ConfigPath, ConfigValue>;
    provenance: ReadonlyMap<ConfigPath, Provenance>;
}

export function resolveEffective(doc: StyleDocument, baseDump: string, currentDump: string): EffectiveConfig {
    const base = flatten(yaml.load(baseDump) ?? {});
    const current = flatten(yaml.load(currentDump) ?? {});

    const provenance = new Map<ConfigPath, Provenance>();
    for (const [path, value] of current) {
        const override = doc.overrides.get(path);
        if (override !== undefined) {
            provenance.set(path, valuesEqual(override, value) ? 'override' : 'ignored');
            continue;
        }
        provenance.set(path, valuesEqual(base.get(path), value) ? 'base' : 'derived');
    }
    return { values: current, provenance };
}
