import { describe, expect, it } from 'vitest';
import { compareChecks, compareModules, MODULE_ORDER } from '../../src/ui/hooks/tidyOrdering.ts';
import type { Survey } from '../../src/core/tidy/analysis.ts';

/** Just enough of a survey for ordering: findings per check. */
function surveyWith(counts: Record<string, number>): Survey {
    return {
        findings: new Map(
            Object.entries(counts).map(([check, n]) => [
                check,
                { check, diagnostics: Array.from({ length: n }, () => ({}) as never), witness: null, via: null },
            ]),
        ),
        covered: new Set(Object.keys(counts)),
        compileErrors: [],
        stubbedIncludes: [],
        baseline: new Map(),
        runs: 1,
        millis: 0,
    };
}

describe('check ordering', () => {
    it('puts the broadly useful modules first, the rest alphabetically after', () => {
        const modules = ['zircon', 'readability', 'abseil', 'bugprone', 'clang-analyzer', 'android'];
        expect(modules.sort(compareModules)).toEqual(['bugprone', 'clang-analyzer', 'readability', 'abseil', 'android', 'zircon']);
        expect(MODULE_ORDER[0]).toBe('bugprone');
    });

    it('is purely alphabetical in static mode, whatever the findings', () => {
        const names = ['b-check', 'a-check', 'c-check'];
        const survey = surveyWith({ 'c-check': 9, 'a-check': 0, 'b-check': 3 });
        expect([...names].sort((a, b) => compareChecks(a, b, 'static', survey))).toEqual(['a-check', 'b-check', 'c-check']);
    });

    it('ranks by findings only when asked, breaking ties by name', () => {
        const names = ['b-check', 'a-check', 'c-check', 'd-check'];
        const survey = surveyWith({ 'c-check': 9, 'a-check': 3, 'b-check': 3 });
        expect([...names].sort((a, b) => compareChecks(a, b, 'findings', survey))).toEqual([
            'c-check',
            'a-check',
            'b-check',
            'd-check',
        ]);
    });
});
