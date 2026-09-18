import { describe, expect, it } from 'vitest';
import catalogJson from '../../../src/core/catalog/generated/tidy.23.1.1.json' with { type: 'json' };
import type { TidyCatalog } from '../../../src/core/tidy/catalog.ts';
import { OVERLAP_NOTE, candidatesFor, summariseSurvey, survey, sweepOptions } from '../../../src/core/tidy/analysis.ts';
import { createTidyDocument } from '../../../src/core/tidy/config.ts';
import { cpp } from '../../../src/core/languages/defs/cpp.ts';
import { sharedTidyRuntime } from '../../support/tidyRuntime.ts';

const catalog = catalogJson as unknown as TidyCatalog;

// No includes, so each run is quick: the parse is the expensive part of a run.
const snippet = String.raw`
int *global = 0;
int _Reserved = 1;

int area(int width, int height) {
    if (width > 10) return width * height * 42;
    return width * height;
}

struct Shape {
    Shape() {}
    virtual ~Shape() {}
    virtual int sides() { return 0; }
};

struct Square : Shape {
    virtual int sides() { return 4; }
};
`;

async function surveyed() {
    const port = await sharedTidyRuntime();
    const input = { catalog, doc: createTidyDocument(), code: snippet, filename: 'a.cpp', compileArgs: ['-std=c++23'], port };
    return { input, result: await survey(input) };
}

describe('survey, against the binary', () => {
    it('finds what each check would report, with a preview of its fix', async () => {
        const { result } = await surveyed();
        const nullptr = result.findings.get('modernize-use-nullptr');
        expect(nullptr?.diagnostics.length).toBe(1);
        expect(nullptr?.witness?.hunk?.after.join('\n')).toContain('nullptr');
        const override = result.findings.get('modernize-use-override');
        expect(override?.witness?.hunk?.after.join('\n')).toMatch(/override/);
        expect(result.compileErrors).toEqual([]);
    });

    it('credits an alias with its target’s findings, which clang-tidy would otherwise swallow', async () => {
        const { result } = await surveyed();
        const target = result.findings.get('readability-magic-numbers');
        const alias = result.findings.get('cppcoreguidelines-avoid-magic-numbers');
        expect(target?.diagnostics.length).toBeGreaterThan(0);
        expect(alias?.via).toBe('readability-magic-numbers');
        expect(alias?.diagnostics).toEqual(target?.diagnostics);
    });

    it('distinguishes silent checks from ones it never ran', async () => {
        const { result } = await surveyed();
        expect(result.covered.has('performance-for-range-copy')).toBe(true);
        expect(result.findings.has('performance-for-range-copy')).toBe(false);
        const summary = summariseSurvey(result);
        expect(summary.firing + summary.silent).toBe(catalog.checks.length);
    });

    it('recovers fixes that clang-tidy dropped for overlapping another check’s', async () => {
        // The kitchen sink is large enough that, with every check on, several
        // checks' fixes collide — which is exactly the case being tested.
        const port = await sharedTidyRuntime();
        const code = cpp.samples.find((s) => s.id === 'kitchen-sink')!.code;
        const result = await survey({ catalog, doc: createTidyDocument(), code, filename: 'a.cpp', compileArgs: ['-std=c++23'], port });
        const offersFixes = new Set(catalog.checks.filter((c) => c.offersFixes).map((c) => c.name));
        const collided = [...result.baseline]
            .filter(([check, ds]) => offersFixes.has(check) && ds.some((d) => d.notes.some((n) => n.message === OVERLAP_NOTE)))
            .map(([check]) => check);
        expect(collided.length).toBeGreaterThan(0);
        expect(result.runs).toBeGreaterThan(1);
        for (const check of collided) {
            expect(result.findings.get(check)?.witness, `${check} should have its fix back`).not.toBeNull();
        }
    });
});

describe('option sweep, against the binary', () => {
    it('finds the options that change this code, and says why for the rest', async () => {
        const { input, result } = await surveyed();
        const impact = await sweepOptions({ ...input, survey: result });

        // `Invert` turns the reserved-identifier check inside out: every ordinary
        // name becomes a finding, and `_Reserved` stops being one.
        const invert = impact.get('bugprone-reserved-identifier.Invert')!;
        expect(invert.verdict).toBe('live');
        expect(invert.witness?.value).toBe('true');

        // A check that finds nothing here keeps finding nothing whatever its options.
        expect(impact.get('performance-for-range-copy.WarnOnAllAutoCopies')?.verdict).toBe('inert');
        // Free text has nothing to enumerate…
        expect(impact.get('modernize-use-nullptr.NullMacros')?.verdict).toBe('unknown');
        // …an alias reads the same options as its target, so it is not probed twice…
        expect(impact.get('cppcoreguidelines-avoid-magic-numbers.IgnoredIntegerValues')?.skipReason).toBe('alias');
        // …and identifier-naming's hundreds of per-kind settings do not fit the budget.
        expect(impact.get('readability-identifier-naming.ClassCase')?.skipReason).toBe('too-many');
    });

    it('never proposes a value clang-tidy cannot parse', () => {
        const ratio = catalog.checks
            .find((c) => c.name === 'bugprone-suspicious-missing-comma')!
            .options.find((o) => o.name === 'RatioThreshold')!;
        for (const value of candidatesFor(ratio, ratio.default)) expect(Number.isFinite(Number(value))).toBe(true);
        const bool = { ...ratio, kind: 'bool' as const, fragile: false };
        // clang-tidy stores some bools as ints; `0` must read as false, so the flip is `true`.
        expect(candidatesFor(bool, '0')).toEqual(['true']);
    });
});
