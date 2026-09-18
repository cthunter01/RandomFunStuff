/**
 * Turning the config model into the two different texts clang-format wants.
 *
 * There are genuinely two, and the difference is not cosmetic:
 *
 *  - `dump_config` accepts ONLY a predefined style name or inline flow
 *    (`{Key: Value, ...}`). Handing it ordinary multi-line YAML fails with
 *    "Invalid value for -style".
 *  - `format` accepts both, plus the full text of a `.clang-format` file.
 *
 * Verified against 23.1.1. Mixing the two up produces a bug that only shows up on
 * the "what is my effective config?" path, so `toInlineStyle` exists to make the
 * correct choice the easy one.
 */

import yaml from 'js-yaml';
import type { BaseStyle } from '../catalog/types.ts';
import { flatten, toNestedObject, valuesEqual, type ConfigPath, type ConfigValue, type StyleDocument } from './model.ts';

/** Inline flow form, for `dumpConfig`. */
export function toInlineStyle(doc: StyleDocument): string {
    const body = { BasedOnStyle: doc.baseStyle, ...toNestedObject(doc.overrides) };
    return yaml.dump(body, { flowLevel: 0, lineWidth: -1 }).trim();
}

/** The `.clang-format` file the user exports: base style plus only what they changed. */
export function toFileText(doc: StyleDocument): string {
    const body = { BasedOnStyle: doc.baseStyle, ...toNestedObject(doc.overrides) };
    return yaml.dump(body, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

/**
 * Every option spelled out, for teams that would rather pin the lot than inherit
 * from a base style that may shift between clang-format releases.
 */
export function toExpandedFileText(effectiveYaml: string): string {
    // `dump_config` already emits exactly this; strip its leading document marker
    // so the result looks like a file somebody would commit.
    return effectiveYaml.replace(/^---\n/, '');
}

export interface ParsedConfig {
    baseStyle: BaseStyle | null;
    /** Sparse: only what differs from the resolved base style. */
    overrides: Map<ConfigPath, ConfigValue>;
    /** Keys present in the file that this clang-format version does not know. */
    unknownKeys: string[];
}

/**
 * Reads an existing `.clang-format` back into the sparse model.
 *
 * `baseDump` is the effective config of the file's `BasedOnStyle` (or of the
 * fallback style when it declares none), as returned by `dumpConfig`. Anything
 * matching the base is dropped, which is what keeps a re-export as small as the
 * original rather than ballooning to all 209 options.
 */
export function fromFileText(text: string, baseDump: string, knownPaths: ReadonlySet<string>): ParsedConfig {
    const documents = yaml.loadAll(text) as unknown[];
    // A multi-document file carries one section per language. Until the UI edits
    // several at once, take the first section that is not a bare language selector.
    const parsed =
        (documents.find((d) => d && typeof d === 'object' && Object.keys(d as object).length > 1) as Record<
            string,
            unknown
        > | undefined) ?? {};

    const baseStyle = (parsed['BasedOnStyle'] as BaseStyle | undefined) ?? null;
    const declared = flatten({ ...parsed, BasedOnStyle: undefined, Language: undefined });
    const base = flatten(yaml.load(baseDump) ?? {});

    const overrides = new Map<ConfigPath, ConfigValue>();
    const unknownKeys: string[] = [];
    for (const [path, value] of declared) {
        const topLevel = path.split('.')[0]!;
        if (!knownPaths.has(path) && !knownPaths.has(topLevel)) {
            unknownKeys.push(path);
            continue;
        }
        if (!valuesEqual(base.get(path), value)) overrides.set(path, value);
    }
    return { baseStyle, overrides, unknownKeys };
}
