import { describe, expect, it } from 'vitest';
import { GROUP_ORDER, compareGroups, compareRows, groupRank, type Orderable } from '../../src/ui/hooks/ordering.ts';
import type { ImpactMap, ImpactResult } from '../../src/core/analysis/impact.ts';
import type { OptionDescriptor } from '../../src/core/catalog/types.ts';

const row = (name: string, group = 'Spaces'): Orderable => ({
    path: name,
    option: { name, group } as OptionDescriptor,
});

const impactOf = (entries: Record<string, Partial<ImpactResult>>): ImpactMap =>
    new Map(
        Object.entries(entries).map(([path, value]) => [
            path,
            { path, verdict: 'inert', magnitude: 0, candidatesTried: 1, ...value } as ImpactResult,
        ]),
    );

describe('option ordering', () => {
    it('places groups in a fixed reading order, not by content', () => {
        const shuffled = ['Other', 'Penalties', 'Indentation', 'Braces', 'Spaces'];
        expect([...shuffled].sort(compareGroups)).toEqual(['Indentation', 'Braces', 'Spaces', 'Penalties', 'Other']);
    });

    it('sorts an unrecognised group after the known ones', () => {
        expect(groupRank('Indentation')).toBeLessThan(groupRank('Something New'));
        expect(groupRank('Something New')).toBe(GROUP_ORDER.length);
    });

    describe('static mode', () => {
        const rows = [row('SpacesInAngles'), row('SpaceAfterCStyleCast'), row('SpaceBeforeParens')];

        it('is alphabetical within a group', () => {
            expect([...rows].sort((a, b) => compareRows(a, b, 'static', null)).map((r) => r.option.name)).toEqual([
                'SpaceAfterCStyleCast',
                'SpaceBeforeParens',
                'SpacesInAngles',
            ]);
        });

        it('ignores impact entirely, so a new analysis cannot move anything', () => {
            const impact = impactOf({
                SpacesInAngles: { verdict: 'live', magnitude: 900 },
                SpaceBeforeParens: { verdict: 'live', magnitude: 5 },
            });
            const withImpact = [...rows].sort((a, b) => compareRows(a, b, 'static', impact));
            const without = [...rows].sort((a, b) => compareRows(a, b, 'static', null));
            expect(withImpact).toEqual(without);
        });

        it('is a function of the catalog alone, so editing a value cannot reorder', () => {
            // This is the whole point: the comparator takes no notion of which
            // options are overridden, so there is nothing an edit could perturb.
            const before = [...rows].sort((a, b) => compareRows(a, b, 'static', null)).map((r) => r.path);
            const after = [...rows].reverse().sort((a, b) => compareRows(a, b, 'static', null)).map((r) => r.path);
            expect(after).toEqual(before);
        });
    });

    describe('impact mode', () => {
        const rows = [row('Alpha'), row('Beta'), row('Gamma'), row('Delta')];
        const impact = impactOf({
            Alpha: { verdict: 'inert' },
            Beta: { verdict: 'live', magnitude: 3 },
            Gamma: { verdict: 'live', magnitude: 40 },
            Delta: { verdict: 'unknown' },
        });

        it('puts the biggest effect first, then unknown, then inert', () => {
            expect([...rows].sort((a, b) => compareRows(a, b, 'impact', impact)).map((r) => r.option.name)).toEqual([
                'Gamma',
                'Beta',
                'Delta',
                'Alpha',
            ]);
        });

        it('falls back to alphabetical when nothing has been measured', () => {
            expect([...rows].sort((a, b) => compareRows(a, b, 'impact', null)).map((r) => r.option.name)).toEqual([
                'Alpha',
                'Beta',
                'Delta',
                'Gamma',
            ]);
        });

        it('is deterministic for equal ranks', () => {
            const tied = impactOf({
                Beta: { verdict: 'live', magnitude: 7 },
                Gamma: { verdict: 'live', magnitude: 7 },
            });
            const once = [...rows].sort((a, b) => compareRows(a, b, 'impact', tied)).map((r) => r.path);
            const twice = [...rows].reverse().sort((a, b) => compareRows(a, b, 'impact', tied)).map((r) => r.path);
            expect(twice).toEqual(once);
        });
    });
});
