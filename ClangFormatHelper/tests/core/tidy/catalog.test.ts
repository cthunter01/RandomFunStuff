import { describe, expect, it } from 'vitest';
import catalogJson from '../../../src/core/catalog/generated/tidy.23.1.1.json' with { type: 'json' };
import type { TidyCatalog, TidyCheckDescriptor } from '../../../src/core/tidy/catalog.ts';

/**
 * Drift alarms for the generated check catalog, measured against clang-tidy
 * 23.1.1 and its docs at llvmorg-23.1.1. If a version bump moves these, read the
 * diff rather than updating the numbers.
 */

const catalog = catalogJson as unknown as TidyCatalog;
const byName = new Map(catalog.checks.map((c) => [c.name, c]));
const get = (name: string): TidyCheckDescriptor => {
    const found = byName.get(name);
    if (!found) throw new Error(`missing check ${name}`);
    return found;
};

describe('tidy catalog', () => {
    it('is built from the pinned upstream tag', () => {
        expect(catalog.clangTidyVersion).toBe('23.1.1');
        expect(catalog.sourceTag).toBe('llvmorg-23.1.1');
        expect(catalog.docsSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('describes every check the binary has', () => {
        expect(catalog.checks).toHaveLength(602);
        expect(catalog.checks.filter((c) => c.module === 'clang-analyzer')).toHaveLength(131);
        // The analyzer's modelling checkers are real and enabled by `*`, but the
        // docs' check list omits them. They are kept, marked by a null docPath.
        expect(catalog.checks.filter((c) => c.docPath === null)).toHaveLength(34);
        expect(catalog.checks.filter((c) => c.docPath === null).every((c) => c.module === 'clang-analyzer')).toBe(true);
    });

    it('knows which checks are aliases, and gives them their target’s documentation', () => {
        expect(catalog.checks.filter((c) => c.aliasOf)).toHaveLength(65);
        const alias = get('cppcoreguidelines-avoid-magic-numbers');
        expect(alias.aliasOf).toBe('readability-magic-numbers');
        expect(alias.summary).toBe(get('readability-magic-numbers').summary);
        // An alias reads its options under its own name.
        expect(alias.options.map((o) => o.name)).toContain('IgnoredIntegerValues');
    });

    it('classifies every option from the binary’s own reaction', () => {
        const histogram: Record<string, number> = {};
        for (const c of catalog.checks) for (const o of c.options) histogram[o.kind] = (histogram[o.kind] ?? 0) + 1;
        expect(histogram).toEqual({ bool: 279, enum: 130, integer: 54, list: 59, number: 2, regex: 102, string: 174 });
    });

    it('confirms at least one value for every enum', () => {
        const empty = catalog.checks.flatMap((c) =>
            c.options.filter((o) => o.kind === 'enum' && o.values.length === 0).map((o) => `${c.name}.${o.name}`),
        );
        expect(empty).toEqual([]);
        const casing = get('readability-identifier-naming').options.find((o) => o.name === 'ClassCase')!;
        expect(casing.values).toEqual(
            expect.arrayContaining(['lower_case', 'UPPER_CASE', 'camelBack', 'CamelCase', 'Leading_upper_snake_case']),
        );
        const includeStyle = get('modernize-make-unique').options.find((o) => o.name === 'IncludeStyle')!;
        expect(includeStyle.values.sort()).toEqual(['google', 'llvm']);
    });

    it('flags the option that crashes clang-tidy on a bad value', () => {
        const ratio = get('bugprone-suspicious-missing-comma').options.find((o) => o.name === 'RatioThreshold')!;
        expect(ratio).toMatchObject({ kind: 'number', fragile: true });
        const fragile = catalog.checks.flatMap((c) => c.options.filter((o) => o.fragile));
        expect(fragile).toHaveLength(1);
    });

    it('reads the top-level keys from the binary’s help, resolving "Same as" references', () => {
        const keys = catalog.topLevelKeys.map((k) => k.name);
        expect(keys).toEqual(expect.arrayContaining(['Checks', 'CheckOptions', 'WarningsAsErrors', 'HeaderFilterRegex']));
        const header = catalog.topLevelKeys.find((k) => k.name === 'HeaderFilterRegex')!;
        expect(header.doc).toMatch(/^Regular expression/);
    });

    it('has a description for every module but the analyzer’s modelling checkers', () => {
        const described = new Set(catalog.modules.map((m) => m.name));
        const modules = new Set(catalog.checks.map((c) => c.module));
        expect([...modules].filter((m) => !described.has(m))).toEqual([]);
    });
});
