/**
 * The `.clang-tidy` configuration the user is building.
 *
 * Same principle as the format side's `StyleDocument`: store what a hand-written
 * file would say and nothing more. The `Checks` globs as written, a sparse map of
 * the `CheckOptions` the user actually changed, and whichever other top-level
 * keys they set. Every default comes from the binary, never from here.
 *
 * clang-tidy has no `BasedOnStyle`. The nearest thing is a starting set of checks,
 * so "presets" below replace the glob list and nothing else.
 */

import yaml from 'js-yaml';
import { sameOptionValue, type TidyCatalog, type TidyOptionKind } from './catalog.ts';
import { formatChecks, parseChecks, type CheckGlob } from './checks.ts';

/** Structured YAML, kept verbatim — for keys like `CustomChecks` that hold objects. */
export type TidyStructuredValue = { [key: string]: TidyStructuredValue } | TidyStructuredValue[] | string | number | boolean | null;

/**
 * A top-level setting's value, e.g. `WarningsAsErrors: '*'` or `SystemHeaders: false`.
 * Keys the catalog calls `complex` keep their YAML structure as-is.
 */
export type TidySettingValue = string | boolean | string[] | { structured: TidyStructuredValue };

export interface TidyDocument {
    checks: readonly CheckGlob[];
    /** `check-name.Option` → value. Strings throughout, because that is how clang-tidy stores them. */
    options: ReadonlyMap<string, string>;
    /** Top-level keys other than `Checks` and `CheckOptions`. */
    settings: ReadonlyMap<string, TidySettingValue>;
}

export interface TidyPreset {
    id: string;
    label: string;
    blurb: string;
    checks: string;
}

/**
 * Starting points. Each is only a `Checks` line — a module-level selection that
 * people commonly start from — so choosing one never touches option values.
 */
export const TIDY_PRESETS: readonly TidyPreset[] = [
    {
        id: 'none',
        label: 'Nothing',
        blurb: 'Every check off, compiler warnings included. Build up from zero.',
        checks: '-*',
    },
    {
        id: 'default',
        label: "clang-tidy's default",
        blurb: 'No Checks line at all: only compiler warnings, reported as clang-diagnostic-*.',
        checks: '',
    },
    {
        id: 'bugs',
        label: 'Bug finders',
        blurb: 'Likely bugs, the static analyzer, and performance traps. Low noise.',
        checks: '-*,bugprone-*,clang-analyzer-*,performance-*',
    },
    {
        id: 'modern',
        label: 'Modern C++',
        blurb: 'Bug finders plus modernize and readability — the usual application-code set.',
        checks: '-*,bugprone-*,clang-analyzer-*,performance-*,modernize-*,readability-*',
    },
    {
        id: 'core-guidelines',
        label: 'C++ Core Guidelines',
        blurb: 'The cppcoreguidelines-* module on its own. Strict; expect many findings.',
        checks: '-*,cppcoreguidelines-*',
    },
    {
        id: 'everything',
        label: 'Everything',
        blurb: 'Every check. For exploring — no real project runs all of these.',
        checks: '*',
    },
];

export function createTidyDocument(preset: TidyPreset = TIDY_PRESETS[2]!): TidyDocument {
    return { checks: parseChecks(preset.checks), options: new Map(), settings: new Map() };
}

export function withChecks(doc: TidyDocument, checks: readonly CheckGlob[]): TidyDocument {
    return { ...doc, checks };
}

export function setOption(doc: TidyDocument, key: string, value: string): TidyDocument {
    const options = new Map(doc.options);
    options.set(key, value);
    return { ...doc, options };
}

export function clearOption(doc: TidyDocument, key: string): TidyDocument {
    const options = new Map(doc.options);
    options.delete(key);
    return { ...doc, options };
}

export function setSetting(doc: TidyDocument, key: string, value: TidySettingValue | null): TidyDocument {
    const settings = new Map(doc.settings);
    if (value === null) settings.delete(key);
    else settings.set(key, value);
    return { ...doc, settings };
}

function sortedObject<V>(entries: Iterable<[string, V]>): Record<string, V> {
    return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}

/** A setting as it is written to the file. */
function plainSetting(value: TidySettingValue): TidyStructuredValue {
    return typeof value === 'object' && !Array.isArray(value) ? value.structured : value;
}

/**
 * The config as `--config=` wants it. JSON is a subset of YAML, so it is valid,
 * and it sidesteps every question of quoting a value like `*` or `-1`.
 */
export function toConfigJson(doc: TidyDocument, extra: { checks?: string; options?: ReadonlyMap<string, string> } = {}): string {
    const checks = extra.checks ?? formatChecks(doc.checks);
    const options = new Map(doc.options);
    for (const [k, v] of extra.options ?? []) options.set(k, v);
    return JSON.stringify({
        ...(checks ? { Checks: checks } : {}),
        ...sortedObject([...doc.settings].map(([k, v]): [string, TidyStructuredValue] => [k, plainSetting(v)])),
        ...(options.size > 0 ? { CheckOptions: sortedObject(options) } : {}),
    });
}

/**
 * The `.clang-tidy` file the user exports.
 *
 * Long `Checks` lists are written one glob per line in a folded block, which is
 * how well-kept configs look and what makes them diff well. Folding joins the
 * lines with spaces; clang-tidy trims whitespace around each glob, so that is
 * harmless — and the round-trip test proves it against the binary.
 */
export function toTidyFileText(doc: TidyDocument): string {
    const lines: string[] = [];
    const checks = formatChecks(doc.checks);
    if (doc.checks.length > 3 || checks.length > 70) {
        lines.push('Checks: >-');
        doc.checks.forEach((glob, i) => {
            lines.push(`  ${glob.enable ? '' : '-'}${glob.pattern}${i < doc.checks.length - 1 ? ',' : ''}`);
        });
    } else if (doc.checks.length > 0) {
        lines.push(`Checks: '${checks}'`);
    }
    for (const [key, value] of Object.entries(sortedObject(doc.settings))) {
        lines.push(yaml.dump({ [key]: plainSetting(value) }, { lineWidth: -1 }).trimEnd());
    }
    if (doc.options.size > 0) {
        lines.push('CheckOptions:');
        const body = yaml.dump(sortedObject(doc.options), { lineWidth: -1, quotingType: "'" }).trimEnd();
        for (const line of body.split('\n')) lines.push(`  ${line}`);
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export interface ParsedTidyConfig {
    doc: TidyDocument;
    /** Keys this clang-tidy does not know, reported rather than silently kept. */
    unknownKeys: string[];
    /** Option keys naming no known check option — often a typo, or a removed option. */
    unknownOptions: string[];
}

/**
 * Reads an existing `.clang-tidy` back into the model. Accepts both spellings
 * clang-tidy does: `Checks` as a string or a list, and `CheckOptions` as a map or
 * as the older list of `{key, value}` pairs.
 */
export function fromTidyFileText(text: string, catalog: TidyCatalog): ParsedTidyConfig {
    const parsed = (yaml.load(text) ?? {}) as Record<string, unknown>;
    if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('A .clang-tidy file must be a YAML mapping');

    const rawChecks = parsed['Checks'];
    const checksText = Array.isArray(rawChecks) ? rawChecks.map(String).join(',') : String(rawChecks ?? '');

    const options = new Map<string, string>();
    const rawOptions = parsed['CheckOptions'];
    if (Array.isArray(rawOptions)) {
        for (const entry of rawOptions as Array<{ key?: unknown; value?: unknown }>) {
            if (entry && entry.key !== undefined) options.set(String(entry.key), String(entry.value ?? ''));
        }
    } else if (rawOptions && typeof rawOptions === 'object') {
        for (const [key, value] of Object.entries(rawOptions)) options.set(key, String(value));
    }

    const known = new Map(catalog.topLevelKeys.map((k) => [k.name, k]));
    const settings = new Map<string, TidySettingValue>();
    const unknownKeys: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
        if (key === 'Checks' || key === 'CheckOptions') continue;
        if (!known.has(key)) {
            unknownKeys.push(key);
            continue;
        }
        if (known.get(key)!.kind === 'complex') settings.set(key, { structured: value as TidyStructuredValue });
        else if (Array.isArray(value)) settings.set(key, value.map(String));
        else settings.set(key, typeof value === 'boolean' ? value : String(value));
    }

    const optionKeys = new Set(catalog.checks.flatMap((c) => c.options.map((o) => `${c.name}.${o.name}`)));
    // A key without a check prefix is a global option (`StrictMode`), which
    // clang-tidy reads as a fallback for every check that asks for it.
    const unknownOptions = [...options.keys()].filter((k) => k.includes('.') && !optionKeys.has(k));

    return { doc: { checks: parseChecks(checksText), options, settings }, unknownKeys, unknownOptions };
}

/** Where an option's effective value came from. */
export type TidyProvenance =
    | 'default'
    /** Set by the user, and in force. */
    | 'override'
    /** Set by the user, but clang-tidy refused the value and fell back to the default. */
    | 'rejected'
    /** Set by the user, but its check is not enabled, so it does nothing. */
    | 'inactive';

export interface TidyEffective {
    /** Every option of every enabled check, from `--dump-config`. */
    values: ReadonlyMap<string, string>;
    provenance: ReadonlyMap<string, TidyProvenance>;
}

/**
 * Resolves effective option values from the binary's `--dump-config` of the
 * document. `kindOf` lets an override be compared the way clang-tidy reads it, so
 * `true` and a dumped `1` agree while a refused enum value shows as rejected.
 */
export function resolveTidyEffective(
    doc: TidyDocument,
    dump: string,
    kindOf: (key: string) => TidyOptionKind | undefined = () => undefined,
): TidyEffective {
    const parsed = (yaml.load(dump) ?? {}) as { CheckOptions?: Record<string, unknown> };
    const values = new Map(Object.entries(parsed.CheckOptions ?? {}).map(([k, v]) => [k, String(v)]));
    const provenance = new Map<string, TidyProvenance>();
    for (const [key, value] of values) {
        const override = doc.options.get(key);
        if (override === undefined) provenance.set(key, 'default');
        else provenance.set(key, sameOptionValue(kindOf(key) ?? 'string', override, value) ? 'override' : 'rejected');
    }
    // clang-tidy dumps options only for enabled checks, so an override missing from
    // the dump belongs to a check that is off.
    for (const key of doc.options.keys()) if (!values.has(key) && key.includes('.')) provenance.set(key, 'inactive');
    return { values, provenance };
}
