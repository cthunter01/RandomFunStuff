import { describe, expect, it } from 'vitest';
import catalogJson from '../../../src/core/catalog/generated/options.23.1.1.json' with { type: 'json' };
import type { OptionCatalog, OptionDescriptor } from '../../../src/core/catalog/types.ts';

/**
 * Drift alarms for the generated catalog.
 *
 * These numbers were measured against clang-format 23.1.1 and its docs at tag
 * llvmorg-23.1.1. They are not arbitrary: each one caught a real bug while the
 * generator was being written, and if a version bump moves them the diff should
 * be looked at rather than waved through.
 */

const catalog = catalogJson as unknown as OptionCatalog;
const byName = new Map(catalog.options.map((o) => [o.name, o]));
const get = (name: string): OptionDescriptor => {
    const found = byName.get(name);
    if (!found) throw new Error(`missing option ${name}`);
    return found;
};

describe('option catalog', () => {
    it('is built from the pinned upstream tag', () => {
        expect(catalog.clangFormatVersion).toBe('23.1.1');
        expect(catalog.sourceTag).toBe('llvmorg-23.1.1');
        expect(catalog.rstSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('describes the whole option surface', () => {
        // 211 headings in the docs, minus Language and BasedOnStyle, which are not
        // tweakable options: one selects the document, the other the base style.
        expect(catalog.options).toHaveLength(209);
        expect(byName.has('Language')).toBe(false);
        expect(byName.has('BasedOnStyle')).toBe(false);
    });

    it('classifies every option into a known shape', () => {
        const histogram: Record<string, number> = {};
        for (const o of catalog.options) histogram[o.kind] = (histogram[o.kind] ?? 0) + 1;
        expect(histogram).toEqual({
            bool: 81,
            enum: 56,
            nested: 21,
            unsigned: 21,
            stringList: 17,
            string: 6,
            integer: 3,
            deprecated: 2,
            includeCategories: 1,
            rawStringFormats: 1,
        });
        expect(catalog.options.every((o) => o.kind !== 'unknown')).toBe(true);
    });

    it('reads nested structs exactly as the binary emits them', () => {
        // Every one of these was wrong at some point: an enum-typed field carries its
        // own "Possible values:" marker, which used to make the parser skip every
        // field declared above it.
        const expected: Record<string, number> = {
            BraceWrapping: 18,
            SpaceBeforeParensOptions: 11,
            IntegerLiteralSeparator: 12,
            AlignConsecutiveAssignments: 8,
            SpacesInParensOptions: 5,
            NumericLiteralCase: 4,
            AlignTrailingComments: 3,
            SortIncludes: 3,
            KeepEmptyLines: 3,
            PackArguments: 2,
            PackParameters: 2,
        };
        for (const [name, count] of Object.entries(expected)) {
            expect(get(name).fields, `${name} field count`).toHaveLength(count);
        }
        expect(catalog.options.reduce((n, o) => n + o.fields.length, 0)).toBe(134);
    });

    it('keeps the deprecated IntegerLiteralSeparator aliases the binary still accepts', () => {
        const fields = get('IntegerLiteralSeparator').fields;
        const alias = fields.find((f) => f.name === 'BinaryMinDigits');
        expect(alias?.deprecated).toBe(true);
        expect(alias?.replacedBy).toBe('BinaryMinDigitsInsert');
    });

    it('captures enum values and their documentation', () => {
        expect(get('PointerAlignment').values.map((v) => v.value)).toEqual(['Left', 'Right', 'Middle']);
        expect(get('PointerAlignment').values[0]?.symbol).toBe('PAS_Left');
        expect(catalog.options.reduce((n, o) => n + o.values.length, 0)).toBe(207);
    });

    it('records the hybrid options that accept either a scalar or a struct', () => {
        // AlignConsecutive* and friends can be written as a shorthand word or as a map.
        const hybrids = catalog.options.filter((o) => o.fields.length > 0 && o.shorthandValues.length > 0);
        expect(hybrids).toHaveLength(8);
        expect(get('AlignConsecutiveAssignments').shorthandValues).toEqual([
            'None',
            'Consecutive',
            'AcrossEmptyLines',
            'AcrossComments',
            'AcrossEmptyLinesAndComments',
        ]);
    });

    it('keeps the official before/after examples', () => {
        const withExample = catalog.options.filter(
            (o) =>
                o.examples.length > 0 ||
                o.values.some((v) => v.examples.length > 0) ||
                o.fields.some((f) => f.examples.length > 0),
        );
        expect(withExample).toHaveLength(156);
    });

    it('flags values that cannot be set on their own', () => {
        // Both are rejected outright unless a prerequisite option is set first.
        expect(get('QualifierAlignment').values.find((v) => v.value === 'Custom')?.needsPrerequisite).toBe(true);
        expect(get('InsertTrailingCommas').values.find((v) => v.value === 'Wrapped')?.needsPrerequisite).toBe(true);
    });

    it('records the inter-option dependencies that produce unloadable configs', () => {
        expect(get('BraceWrapping').requires).toEqual([
            expect.objectContaining({ option: 'BreakBeforeBraces', value: 'Custom' }),
        ]);
    });

    it('carries a version badge for effectively every option', () => {
        const unbadged = catalog.options.filter((o) => o.since === null).map((o) => o.name);
        expect(unbadged).toEqual([]);
    });
});
