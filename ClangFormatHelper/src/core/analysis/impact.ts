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
function styleWith(doc: StyleDocument, path: ConfigPath, value: ConfigValue): string {
    const overrides = new Map(doc.overrides);
    overrides.set(path, value);
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

    const enqueue = (path: ConfigPath, values: ConfigValue[], skipReason?: ImpactResult['skipReason']): void => {
        if (skipReason) {
            results.set(path, { path, verdict: 'skipped', magnitude: 0, candidatesTried: 0, skipReason });
            return;
        }
        if (values.length === 0) {
            results.set(path, { path, verdict: 'unknown', magnitude: 0, candidatesTried: 0 });
            return;
        }
        results.set(path, { path, verdict: 'inert', magnitude: 0, candidatesTried: values.length });
        for (const value of values) queue.push({ path, value });
    };

    for (const option of catalog.options) {
        if (DEGENERATE_OPTIONS.has(option.name)) {
            enqueue(option.name, [], 'degenerate');
            continue;
        }
        if (option.kind === 'deprecated' || option.deprecated) {
            enqueue(option.name, [], 'deprecated');
            continue;
        }
        enqueue(option.name, candidatesForOption(option, effective.get(option.name)));
        for (const field of option.fields) {
            const path = `${option.name}.${field.name}`;
            if (field.deprecated) {
                enqueue(path, [], 'deprecated');
                continue;
            }
            enqueue(path, candidatesForField(option, field, effective.get(path)));
        }
    }

    let done = 0;
    for (let i = 0; i < queue.length; i += chunkSize) {
        throwIfAborted(signal);
        const chunk = queue.slice(i, i + chunkSize);
        const outcomes = await port.formatBatch(
            code,
            filename,
            chunk.map((c) => styleWith(doc, c.path, c.value)),
        );
        for (let j = 0; j < chunk.length; j++) {
            const candidate = chunk[j]!;
            const outcome = outcomes[j]!;
            // `unchanged` means clang-format itself reported the input was already
            // formatted — an inert candidate that cost us no text over the wire.
            if (outcome.status !== 'changed') continue;
            const text = outcome.text ?? baselineText;
            if (text === baselineText) continue;

            const magnitude = changedLineCount(baselineText, text);
            const existing = results.get(candidate.path)!;
            if (magnitude > existing.magnitude || existing.verdict !== 'live') {
                results.set(candidate.path, {
                    ...existing,
                    verdict: 'live',
                    magnitude: Math.max(existing.magnitude, magnitude),
                    witness: { value: candidate.value, hunk: firstHunk(baselineText, text) },
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
