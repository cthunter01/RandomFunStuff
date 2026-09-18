/**
 * Works out which options actually change *this* user's code.
 *
 * This is the feature the whole app is built around. Measured while designing it:
 * of ~170 tweakable options, 16 affect a toy snippet and 33 affect a real
 * 522-line file. Roughly four fifths of the option surface is noise for any given
 * sample, and no other clang-format tool tells you which fifth matters.
 *
 * The method is brute force and unapologetic about it — format the sample once
 * per candidate value and compare — which is only viable because a format call
 * costs about half a millisecond. Everything here is about keeping that honest:
 * type-aware candidates so we never fabricate invalid configs, chunking so the
 * editor never stalls, and cancellation so an edit mid-sweep costs nothing.
 */

import type { OptionCatalog, OptionDescriptor, NestedFieldDescriptor } from '../catalog/types.ts';
import { DEGENERATE_OPTIONS } from '../catalog/types.ts';
import type { FormatterPort } from '../formatter/port.ts';
import { changedLineCount, firstHunk, type Hunk } from '../diff/lineDiff.ts';
import { toNestedObject, type ConfigPath, type ConfigValue, type StyleDocument } from '../config/model.ts';
import yaml from 'js-yaml';

export type ImpactVerdict =
    /** At least one candidate value changed the sample. */
    | 'live'
    /** Every candidate we tried left the sample byte-identical. */
    | 'inert'
    /** Free-form value (a string, a regex list) — we cannot enumerate candidates. */
    | 'unknown'
    /** Deliberately not probed; see `skipReason`. */
    | 'skipped';

export interface ImpactResult {
    path: ConfigPath;
    verdict: ImpactVerdict;
    /** Largest changed-line count across candidates. */
    magnitude: number;
    /** The candidate that changed the most, with a small preview of what it did. */
    witness?: { value: ConfigValue; hunk: Hunk | null };
    candidatesTried: number;
    skipReason?: 'degenerate' | 'deprecated' | 'no-candidates' | 'needs-prerequisite';
    /**
     * Other settings that had to be switched on for this one to do anything.
     *
     * Plenty of options are inert purely because a parent feature is off —
     * `BraceWrapping.*` does nothing unless `BreakBeforeBraces: Custom`, and the
     * `AlignConsecutive*` modifiers do nothing unless that family's `Enabled` is
     * true. Reporting those as "no effect on your code" is a lie: the honest
     * question is whether they matter *once the feature is on*, so the sweep turns
     * the prerequisite on and says that it did.
     */
    assumes?: Array<{ path: ConfigPath; value: ConfigValue }>;
}

export interface ImpactOptions {
    catalog: OptionCatalog;
    doc: StyleDocument;
    code: string;
    filename: string;
    port: FormatterPort;
    signal?: AbortSignal;
    /** Styles per round trip. Small enough that a cancel lands promptly. */
    chunkSize?: number;
    onProgress?: (done: number, total: number) => void;
}

export type ImpactMap = Map<ConfigPath, ImpactResult>;

/** A candidate value to try for one path. */
interface Candidate {
    path: ConfigPath;
    value: ConfigValue;
    /** Settings applied alongside the candidate so it can have any effect at all. */
    assumes: Array<{ path: ConfigPath; value: ConfigValue }>;
}

/**
 * Settings that must accompany a probe of `path`, or the result is meaningless.
 *
 * Two sources: the catalog's declared dependencies (`BraceWrapping` needs
 * `BreakBeforeBraces: Custom`), and the near-universal convention that a nested
 * struct's modifier fields are dead unless that struct's own `Enabled` is true.
 */
function prerequisitesFor(
    option: OptionDescriptor,
    path: ConfigPath,
    effective: Map<string, unknown>,
): Array<{ path: ConfigPath; value: ConfigValue }> {
    const needed: Array<{ path: ConfigPath; value: ConfigValue }> = [];

    for (const requirement of option.requires) {
        // A requirement with no concrete value is advisory; we cannot act on it.
        if (!requirement.value) continue;
        // Catalog values are text, because that is how the docs spell them.
        const value: ConfigValue =
            requirement.value === 'true' ? true : requirement.value === 'false' ? false : requirement.value;
        if (effective.get(requirement.option) === value) continue;
        needed.push({ path: requirement.option, value });
    }

    const field = path.startsWith(`${option.name}.`) ? path.slice(option.name.length + 1) : null;
    if (field && field !== 'Enabled' && option.fields.some((f) => f.name === 'Enabled')) {
        if (effective.get(`${option.name}.Enabled`) !== true) {
            needed.push({ path: `${option.name}.Enabled`, value: true });
        }
    }
    return needed;
}

/** Plausible alternatives for a numeric option, kept deliberately short. */
function numericCandidates(name: string, current: unknown): number[] {
    if (name === 'ColumnLimit') return [0, 80, 100, 120];
    if (name.endsWith('Width') || name.endsWith('Indent') || name === 'AccessModifierOffset') {
        return [0, 2, 4, 8].filter((n) => n !== current);
    }
    const base = typeof current === 'number' ? current : 0;
    return [...new Set([0, 1, 2, base + 1])].filter((n) => n !== current && n >= 0);
}

function candidatesForField(
    option: OptionDescriptor,
    field: NestedFieldDescriptor,
    current: unknown,
): ConfigValue[] {
    const path = `${option.name}.${field.name}`;
    switch (field.kind) {
        case 'bool':
            return [!(current === true)];
        case 'enum':
            return field.values.filter((v) => v.value !== current).map((v) => v.value);
        case 'integer':
        case 'unsigned':
            return numericCandidates(path, current);
        default:
            return [];
    }
}

function candidatesForOption(option: OptionDescriptor, current: unknown): ConfigValue[] {
    switch (option.kind) {
        case 'bool':
            return [!(current === true)];
        case 'enum':
            // A value that needs a prerequisite would just produce a rejected config.
            return option.values
                .filter((v) => !v.needsPrerequisite && v.value !== current)
                .map((v) => v.value);
        case 'unsigned':
        case 'integer':
            return numericCandidates(option.name, current);
        case 'nested':
            // Shorthand scalars only; individual fields are probed on their own paths.
            return option.shorthandValues.filter((v) => v !== current);
        default:
            // Strings, string lists, IncludeCategories, RawStringFormats: no meaningful
            // enumeration exists, so these report `unknown` rather than a false `inert`.
            return [];
    }
}

/** Builds the style string for "current config, but with `path` set to `value`". */
function styleWith(doc: StyleDocument, candidate: Candidate): string {
    const overrides = new Map(doc.overrides);
    for (const assumption of candidate.assumes) overrides.set(assumption.path, assumption.value);
    // An empty path means "just the prerequisites", used to build their baseline.
    if (candidate.path) overrides.set(candidate.path, candidate.value);
    const body = { BasedOnStyle: doc.baseStyle, ...toNestedObject(overrides) };
    return yaml.dump(body, { flowLevel: 0, lineWidth: -1 }).trim();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new DOMException('Impact analysis cancelled', 'AbortError');
}

export async function analyseImpact(options: ImpactOptions): Promise<ImpactMap> {
    const { catalog, doc, code, filename, port, signal, chunkSize = 64, onProgress } = options;

    const baseline = await port.format({ code, filename, style: styleWithNothing(doc) });
    if (baseline.status === 'error') throw new Error(baseline.error?.message ?? 'Baseline format failed');
    const baselineText = baseline.text ?? code;

    // The effective config tells us each option's *current* value, so candidates
    // are alternatives to what is actually in force rather than to a guess.
    const effective = flattenYaml(await port.dumpConfig(styleWithNothing(doc), filename));

    const results: ImpactMap = new Map();
    const queue: Candidate[] = [];

    const enqueue = (
        option: OptionDescriptor | null,
        path: ConfigPath,
        values: ConfigValue[],
        skipReason?: ImpactResult['skipReason'],
    ): void => {
        if (skipReason) {
            results.set(path, { path, verdict: 'skipped', magnitude: 0, candidatesTried: 0, skipReason });
            return;
        }
        if (values.length === 0) {
            results.set(path, { path, verdict: 'unknown', magnitude: 0, candidatesTried: 0 });
            return;
        }
        const assumes = option ? prerequisitesFor(option, path, effective) : [];
        results.set(path, {
            path,
            verdict: 'inert',
            magnitude: 0,
            candidatesTried: values.length,
            ...(assumes.length > 0 ? { assumes } : {}),
        });
        for (const value of values) queue.push({ path, value, assumes });
    };

    for (const option of catalog.options) {
        if (DEGENERATE_OPTIONS.has(option.name)) {
            enqueue(null, option.name, [], 'degenerate');
            continue;
        }
        if (option.kind === 'deprecated' || option.deprecated) {
            enqueue(null, option.name, [], 'deprecated');
            continue;
        }
        enqueue(option, option.name, candidatesForOption(option, effective.get(option.name)));
        for (const field of option.fields) {
            const path = `${option.name}.${field.name}`;
            if (field.deprecated) {
                enqueue(null, path, [], 'deprecated');
                continue;
            }
            enqueue(option, path, candidatesForField(option, field, effective.get(path)));
        }
    }

    // A candidate probed with prerequisites must be compared against the config
    // that *already has those prerequisites* — otherwise the prerequisite's own
    // effect is attributed to the option under test and everything downstream of a
    // newly-enabled feature looks falsely live.
    const assumptionKey = (assumes: Candidate['assumes']): string =>
        assumes.map((a) => `${a.path}=${JSON.stringify(a.value)}`).join('&');

    const baselines = new Map<string, string>([['', baselineText]]);
    const needed = [...new Set(queue.map((c) => assumptionKey(c.assumes)))].filter((k) => k !== '');
    if (needed.length > 0) {
        const byKey = new Map(queue.map((c) => [assumptionKey(c.assumes), c.assumes]));
        for (let i = 0; i < needed.length; i += chunkSize) {
            throwIfAborted(signal);
            const slice = needed.slice(i, i + chunkSize);
            const outcomes = await port.formatBatch(
                code,
                filename,
                // The prerequisites alone, with nothing else changed.
                slice.map((key) => styleWith(doc, { path: '', value: '', assumes: byKey.get(key)! })),
            );
            slice.forEach((key, index) => {
                const outcome = outcomes[index]!;
                baselines.set(key, outcome.status === 'changed' ? (outcome.text ?? baselineText) : baselineText);
            });
        }
    }

    let done = 0;
    for (let i = 0; i < queue.length; i += chunkSize) {
        throwIfAborted(signal);
        const chunk = queue.slice(i, i + chunkSize);
        const outcomes = await port.formatBatch(
            code,
            filename,
            chunk.map((c) => styleWith(doc, c)),
        );
        for (let j = 0; j < chunk.length; j++) {
            const candidate = chunk[j]!;
            const outcome = outcomes[j]!;
            const reference = baselines.get(assumptionKey(candidate.assumes)) ?? baselineText;
            // `unchanged` means clang-format itself reported the input was already
            // formatted — an inert candidate that cost us no text over the wire.
            if (outcome.status !== 'changed') continue;
            const text = outcome.text ?? code;
            if (text === reference) continue;

            const magnitude = changedLineCount(reference, text);
            const existing = results.get(candidate.path)!;
            if (magnitude > existing.magnitude || existing.verdict !== 'live') {
                results.set(candidate.path, {
                    ...existing,
                    verdict: 'live',
                    magnitude: Math.max(existing.magnitude, magnitude),
                    witness: { value: candidate.value, hunk: firstHunk(reference, text) },
                });
            }
        }
        done += chunk.length;
        onProgress?.(done, queue.length);
    }
    return results;
}

function styleWithNothing(doc: StyleDocument): string {
    const body = { BasedOnStyle: doc.baseStyle, ...toNestedObject(doc.overrides) };
    return yaml.dump(body, { flowLevel: 0, lineWidth: -1 }).trim();
}

function flattenYaml(text: string): Map<string, unknown> {
    const parsed = (yaml.load(text) ?? {}) as Record<string, unknown>;
    const out = new Map<string, unknown>();
    for (const [key, value] of Object.entries(parsed)) {
        out.set(key, value);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [field, inner] of Object.entries(value as Record<string, unknown>)) {
                out.set(`${key}.${field}`, inner);
            }
        }
    }
    return out;
}

/** Convenience summary for the header chip. */
export function summarise(map: ImpactMap): { live: number; inert: number; unknown: number; skipped: number } {
    let live = 0;
    let inert = 0;
    let unknown = 0;
    let skipped = 0;
    for (const result of map.values()) {
        if (result.verdict === 'live') live++;
        else if (result.verdict === 'inert') inert++;
        else if (result.verdict === 'unknown') unknown++;
        else skipped++;
    }
    return { live, inert, unknown, skipped };
}
