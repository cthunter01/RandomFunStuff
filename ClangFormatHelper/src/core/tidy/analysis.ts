/**
 * Works out which checks — and which of their options — matter for *this* code.
 *
 * The format side answers that by brute force, one format per candidate value,
 * because a format costs half a millisecond. A clang-tidy run costs the better
 * part of a second, since it re-parses the whole translation unit, standard
 * headers and all. So every run here is made to answer many questions at once:
 *
 *  - The **survey** runs every check in one go, and reads per-check findings and
 *    fix-its out of the result. One run answers "what would enabling each of 537
 *    checks do to my code".
 *  - The **option sweep** exploits the fact that a check's options affect only
 *    that check. Run `k` gives *every* check its `k`-th candidate option value at
 *    once, and each check's findings are compared with its own baseline. The run
 *    count is the largest number of candidates any one check has, not the total.
 *
 * Two clang-tidy behaviours would quietly distort that, and are handled here:
 *
 *  - When a check and its alias both report something, clang-tidy keeps only the
 *    one whose name sorts first. Surveying with aliases enabled would make
 *    `readability-magic-numbers` look silent because
 *    `cppcoreguidelines-avoid-magic-numbers` took its findings. So only primary
 *    checks run, and an alias is credited with its target's findings.
 *  - When fixes from *different* checks overlap, clang-tidy drops all of them. With
 *    every check enabled that happens a lot, and a check's fix preview would come
 *    out empty through no fault of its own. Checks that lost fixes are re-run in
 *    small rounds, grouped so that checks firing on the same lines are kept apart.
 */

import type { TidyCatalog, TidyCheckDescriptor, TidyOptionDescriptor } from './catalog.ts';
import { parseTidyBool } from './catalog.ts';
import type { TidyDocument } from './config.ts';
import { applyReplacements } from './diagnostics.ts';
import type { TidyDiagnostic, TidyOutcome, TidyPort } from './port.ts';
import { changedLineCount, firstHunk, type Hunk } from '../diff/lineDiff.ts';

/** The note clang-tidy attaches to a finding whose fix it dropped for overlapping another. */
export const OVERLAP_NOTE = 'this fix will not be applied because it overlaps with another fix';

export interface FixWitness {
    /** The first changed stretch of the sample once this check's fixes are applied. */
    hunk: Hunk | null;
    /** Lines the fixes change in total. */
    changedLines: number;
    /** Fixes that could not be applied because they overlapped. */
    skipped: number;
}

export interface CheckFindings {
    check: string;
    diagnostics: TidyDiagnostic[];
    /** Null when the check offered no fix for anything it found here. */
    witness: FixWitness | null;
    /** Set when these are the findings of the check this one is an alias of. */
    via: string | null;
}

export interface Survey {
    /** Only checks that found something. Absence means "silent on this code". */
    findings: Map<string, CheckFindings>;
    /** Every check the survey covered, silent or not. */
    covered: Set<string>;
    compileErrors: TidyDiagnostic[];
    stubbedIncludes: string[];
    /**
     * Per-check findings from the first, everything-enabled run, before any fix
     * recovery. The option sweep compares against these, because its runs are
     * made under the same conditions.
     */
    baseline: Map<string, TidyDiagnostic[]>;
    runs: number;
    millis: number;
}

export interface AnalysisInput {
    catalog: TidyCatalog;
    doc: TidyDocument;
    code: string;
    filename: string;
    compileArgs: readonly string[];
    port: TidyPort;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    /** Configs per round trip. The port may run a batch in parallel. */
    batchSize?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
}

/**
 * A config for analysis runs: the given checks, the user's option values, and
 * nothing else. Top-level settings are deliberately left out — `WarningsAsErrors`
 * would turn findings into errors and hide real compile errors among them.
 */
function analysisConfig(checks: string, options: ReadonlyMap<string, string>): string {
    return JSON.stringify({ Checks: checks, CheckOptions: Object.fromEntries(options) });
}

function groupByCheck(diagnostics: readonly TidyDiagnostic[]): Map<string, TidyDiagnostic[]> {
    const out = new Map<string, TidyDiagnostic[]>();
    for (const d of diagnostics) {
        if (d.level === 'error') continue;
        const list = out.get(d.check);
        if (list) list.push(d);
        else out.set(d.check, [d]);
    }
    return out;
}

function witnessFor(code: string, diagnostics: readonly TidyDiagnostic[]): FixWitness | null {
    const replacements = diagnostics.flatMap((d) => d.replacements);
    if (replacements.length === 0) return null;
    const { text, skipped } = applyReplacements(code, replacements);
    if (text === code) return null;
    return { hunk: firstHunk(code, text), changedLines: changedLineCount(code, text), skipped };
}

async function runChunked(
    input: AnalysisInput,
    configs: readonly string[],
    progress: { done: number; total: number },
): Promise<TidyOutcome[]> {
    const size = input.batchSize ?? 4;
    const out: TidyOutcome[] = [];
    for (let i = 0; i < configs.length; i += size) {
        throwIfAborted(input.signal);
        const slice = configs.slice(i, i + size);
        out.push(...(await input.port.runBatch(input.code, input.filename, input.compileArgs, slice)));
        progress.done += slice.length;
        input.onProgress?.(progress.done, progress.total);
    }
    return out;
}

/**
 * Partitions checks into rounds so that no two checks in a round fired within a
 * line of each other — a cheap stand-in for "their fixes could overlap", since
 * the fixes themselves were dropped. Greedy colouring; small in practice.
 */
function conflictFreeRounds(checks: readonly string[], byCheck: ReadonlyMap<string, TidyDiagnostic[]>): string[][] {
    const lines = (check: string): Set<number> => {
        const set = new Set<number>();
        for (const d of byCheck.get(check) ?? []) {
            if (d.span) for (const l of [d.span.line - 1, d.span.line, d.span.line + 1]) set.add(l);
        }
        return set;
    };
    const rounds: Array<{ checks: string[]; lines: Set<number> }> = [];
    for (const check of checks) {
        const mine = lines(check);
        let round = rounds.find((r) => ![...mine].some((l) => r.lines.has(l)));
        if (!round) {
            round = { checks: [], lines: new Set() };
            rounds.push(round);
        }
        round.checks.push(check);
        for (const l of mine) round.lines.add(l);
    }
    return rounds.map((r) => r.checks);
}

export async function survey(input: AnalysisInput): Promise<Survey> {
    const { catalog, doc, code } = input;
    const started = performance.now();
    const aliases = catalog.checks.filter((c) => c.aliasOf);
    const primaries = catalog.checks.filter((c) => !c.aliasOf);
    const progress = { done: 0, total: 1 };

    const everything = `*,${aliases.map((c) => `-${c.name}`).join(',')}`;
    const [first] = await runChunked(input, [analysisConfig(everything, doc.options)], progress);
    const outcome = first!;
    const baseline = groupByCheck(outcome.diagnostics);
    const byCheck = new Map([...baseline].map(([k, v]) => [k, [...v]]));

    // Recover fixes clang-tidy dropped because they collided with another check's.
    const offersFixes = new Set(catalog.checks.filter((c) => c.offersFixes).map((c) => c.name));
    const lostFixes = [...byCheck]
        .filter(([check, ds]) => offersFixes.has(check) && ds.some((d) => d.notes.some((n) => n.message === OVERLAP_NOTE)))
        .map(([check]) => check);
    const rounds = conflictFreeRounds(lostFixes, byCheck);
    progress.total += rounds.length;
    if (rounds.length > 0) {
        const outcomes = await runChunked(
            input,
            rounds.map((round) => analysisConfig(`-*,${round.join(',')}`, doc.options)),
            progress,
        );
        rounds.forEach((round, i) => {
            const regrouped = groupByCheck(outcomes[i]!.diagnostics);
            for (const check of round) byCheck.set(check, regrouped.get(check) ?? byCheck.get(check) ?? []);
        });
    }

    const findings = new Map<string, CheckFindings>();
    for (const [check, diagnostics] of byCheck) {
        findings.set(check, { check, diagnostics, witness: witnessFor(code, diagnostics), via: null });
    }
    for (const alias of aliases) {
        const target = findings.get(alias.aliasOf!);
        if (target) findings.set(alias.name, { ...target, check: alias.name, via: alias.aliasOf });
    }

    return {
        findings,
        covered: new Set([...primaries, ...aliases].map((c) => c.name)),
        compileErrors: outcome.diagnostics.filter((d) => d.level === 'error'),
        stubbedIncludes: outcome.stubbedIncludes,
        baseline,
        runs: 1 + rounds.length,
        millis: performance.now() - started,
    };
}

// ---------------------------------------------------------------------------
// Option sweep
// ---------------------------------------------------------------------------

export type OptionVerdict =
    /** Some candidate value changed what the check reports or how it would fix it. */
    | 'live'
    /** Every candidate left the check's findings and fixes unchanged. */
    | 'inert'
    /** Free text (a regex, a list of names): there is nothing sensible to enumerate. */
    | 'unknown'
    /** Deliberately not probed; see `skipReason`. */
    | 'skipped';

export interface OptionImpact {
    /** `check-name.Option`. */
    key: string;
    verdict: OptionVerdict;
    /** Findings added plus findings removed; or, when only the fixes differ, lines the fixes change. */
    magnitude: number;
    witness?: {
        value: string;
        added: TidyDiagnostic[];
        removed: TidyDiagnostic[];
        /** Before/after of the fixes, when the option changes what the fix does. */
        hunk: Hunk | null;
    };
    candidatesTried: number;
    skipReason?: 'too-many' | 'alias';
}

export type OptionImpactMap = Map<string, OptionImpact>;

/** Candidates beyond this, per check, are not probed; see `candidatePlan`. */
export const MAX_CANDIDATES_PER_CHECK = 12;

function effectiveValue(doc: TidyDocument, key: string, option: TidyOptionDescriptor): string | null {
    return doc.options.get(key) ?? option.default;
}

/**
 * Plausible alternatives to an option's current value. Type-aware, and never a
 * value the binary would refuse — which for the one fragile option is a real
 * crash, not a warning.
 */
export function candidatesFor(option: TidyOptionDescriptor, current: string | null): string[] {
    switch (option.kind) {
        case 'bool':
            return [parseTidyBool(current ?? 'false') ? 'false' : 'true'];
        case 'enum':
            return option.values.filter((v) => v !== current);
        case 'integer': {
            const n = Number(current ?? '0');
            const pool = n > 1 ? [0, 1, Math.floor(n / 2), n * 2] : [0, 1, 5, 100];
            return [...new Set(pool)].filter((v) => v !== n).map(String);
        }
        case 'number': {
            const n = Number(current ?? '0');
            return ['0', '0.5', '1'].filter((v) => Number(v) !== n);
        }
        default:
            return [];
    }
}

interface Probe {
    key: string;
    value: string;
}

/**
 * Chooses what to probe for one check within the per-check budget. Options with
 * a real default go first — they are the ones a project would actually tune —
 * and the cheapest kinds before the widest. Whatever does not fit is reported as
 * skipped rather than passed off as inert. In practice only
 * `readability-identifier-naming`, with its hundreds of per-kind settings, runs
 * out of budget; its per-kind options are set by intent, not discovered.
 */
function candidatePlan(
    check: TidyCheckDescriptor,
    doc: TidyDocument,
): { probes: Probe[]; tried: Map<string, number>; unknown: string[]; skipped: string[] } {
    const rank = (o: TidyOptionDescriptor): number =>
        (o.default === null ? 10 : 0) + ({ bool: 0, integer: 1, number: 1, enum: 2 } as Record<string, number>)[o.kind]!;
    const enumerable = check.options.filter((o) => ['bool', 'integer', 'number', 'enum'].includes(o.kind));
    const unknown = check.options.filter((o) => !enumerable.includes(o)).map((o) => `${check.name}.${o.name}`);
    const probes: Probe[] = [];
    const tried = new Map<string, number>();
    const skipped: string[] = [];
    for (const option of [...enumerable].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))) {
        const key = `${check.name}.${option.name}`;
        const values = candidatesFor(option, effectiveValue(doc, key, option));
        if (probes.length + values.length > MAX_CANDIDATES_PER_CHECK) {
            skipped.push(key);
            continue;
        }
        for (const value of values) probes.push({ key, value });
        tried.set(key, values.length);
    }
    return { probes, tried, unknown, skipped };
}

const identity = (d: TidyDiagnostic): string => `${d.span?.line ?? 0}:${d.span?.column ?? 0}:${d.message}`;
const lostFix = (d: TidyDiagnostic): boolean => d.notes.some((n) => n.message === OVERLAP_NOTE);

/**
 * How a check's fixes differ between two runs, looking only at findings present
 * in both whose fixes survived in both. Whether clang-tidy drops a fix for
 * overlapping depends on which *other* checks ran, and a sweep round runs a
 * different set than the baseline did — comparing those would credit the option
 * with a difference the check set caused.
 */
function fixDifference(
    code: string,
    before: readonly TidyDiagnostic[],
    after: readonly TidyDiagnostic[],
): { changedLines: number; hunk: Hunk | null } {
    const afterById = new Map(after.map((d) => [identity(d), d]));
    const left: TidyDiagnostic[] = [];
    const right: TidyDiagnostic[] = [];
    for (const d of before) {
        const other = afterById.get(identity(d));
        if (!other || lostFix(d) || lostFix(other)) continue;
        left.push(d);
        right.push(other);
    }
    const beforeText = applyReplacements(code, left.flatMap((d) => d.replacements)).text;
    const afterText = applyReplacements(code, right.flatMap((d) => d.replacements)).text;
    if (beforeText === afterText) return { changedLines: 0, hunk: null };
    return { changedLines: changedLineCount(beforeText, afterText), hunk: firstHunk(beforeText, afterText) };
}

export async function sweepOptions(input: AnalysisInput & { survey: Survey }): Promise<OptionImpactMap> {
    const { catalog, doc, code, survey: base } = input;
    const results: OptionImpactMap = new Map();
    const plans = new Map<string, Probe[]>();

    for (const check of catalog.checks) {
        if (check.aliasOf) {
            // Same code as its target, reading the same options under another name.
            for (const o of check.options) {
                results.set(`${check.name}.${o.name}`, {
                    key: `${check.name}.${o.name}`,
                    verdict: 'skipped',
                    magnitude: 0,
                    candidatesTried: 0,
                    skipReason: 'alias',
                });
            }
            continue;
        }
        const plan = candidatePlan(check, doc);
        for (const key of plan.unknown) results.set(key, { key, verdict: 'unknown', magnitude: 0, candidatesTried: 0 });
        for (const key of plan.skipped) {
            results.set(key, { key, verdict: 'skipped', magnitude: 0, candidatesTried: 0, skipReason: 'too-many' });
        }
        for (const [key, count] of plan.tried) results.set(key, { key, verdict: 'inert', magnitude: 0, candidatesTried: count });
        if (plan.probes.length > 0) plans.set(check.name, plan.probes);
    }

    // Round k: every check with a k-th probe runs it, all at once.
    const roundCount = Math.max(0, ...[...plans.values()].map((p) => p.length));
    const rounds: Array<Map<string, Probe>> = [];
    for (let k = 0; k < roundCount; k++) {
        const round = new Map<string, Probe>();
        for (const [check, probes] of plans) if (probes[k]) round.set(check, probes[k]!);
        rounds.push(round);
    }
    const configs = rounds.map((round) => {
        const options = new Map(doc.options);
        for (const probe of round.values()) options.set(probe.key, probe.value);
        return analysisConfig(`-*,${[...round.keys()].join(',')}`, options);
    });
    const outcomes = await runChunked(input, configs, { done: 0, total: configs.length });

    rounds.forEach((round, i) => {
        const found = groupByCheck(outcomes[i]!.diagnostics);
        for (const [check, probe] of round) {
            const before = base.baseline.get(check) ?? [];
            const after = found.get(check) ?? [];
            const beforeIds = new Set(before.map(identity));
            const afterIds = new Set(after.map(identity));
            const added = after.filter((d) => !beforeIds.has(identity(d)));
            const removed = before.filter((d) => !afterIds.has(identity(d)));

            const fixes = fixDifference(code, before, after);
            // Same findings, different fix: the option changes *how* it fixes.
            const magnitude = added.length + removed.length || fixes.changedLines;
            const hunk = fixes.hunk;
            if (magnitude === 0) continue;
            const existing = results.get(probe.key)!;
            if (existing.verdict !== 'live' || magnitude > existing.magnitude) {
                results.set(probe.key, {
                    ...existing,
                    verdict: 'live',
                    magnitude,
                    witness: { value: probe.value, added: added.slice(0, 5), removed: removed.slice(0, 5), hunk },
                });
            }
        }
    });
    return results;
}

/** Convenience summary for the toolbar. */
export function summariseSurvey(survey: Survey): { firing: number; silent: number; findings: number } {
    let findings = 0;
    let firing = 0;
    for (const f of survey.findings.values()) {
        if (!survey.covered.has(f.check)) continue; // compiler warnings are not checks
        firing++;
        if (!f.via) findings += f.diagnostics.length;
    }
    return { firing, silent: survey.covered.size - firing, findings };
}
