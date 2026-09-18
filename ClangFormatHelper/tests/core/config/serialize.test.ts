import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import catalogJson from '../../../src/core/catalog/generated/options.23.1.1.json' with { type: 'json' };
import type { OptionCatalog } from '../../../src/core/catalog/types.ts';
import { createDocument, setOverride, toNestedObject } from '../../../src/core/config/model.ts';
import { fromFileText, toFileText, toInlineStyle } from '../../../src/core/config/serialize.ts';
import { sharedRuntime } from '../../support/nodeRuntime.ts';
import type { Runtime } from '../../../src/worker/runtime.ts';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');
const catalog = catalogJson as unknown as OptionCatalog;

/** Every settable dotted path this clang-format version understands. */
const knownPaths = new Set<string>(
    catalog.options.flatMap((o) => [o.name, ...o.fields.map((f) => `${o.name}.${f.name}`)]),
);

let runtime: Runtime;
beforeAll(async () => {
    runtime = await sharedRuntime();
});

describe('config serialization', () => {
    it('emits inline flow for dumpConfig and block YAML for the file', () => {
        let doc = createDocument('cpp', 'LLVM');
        doc = setOverride(doc, 'IndentWidth', 4);
        doc = setOverride(doc, 'BraceWrapping.AfterFunction', true);

        expect(toInlineStyle(doc)).toBe('{BasedOnStyle: LLVM, BraceWrapping: {AfterFunction: true}, IndentWidth: 4}');
        expect(toFileText(doc)).toBe(
            'BasedOnStyle: LLVM\nBraceWrapping:\n  AfterFunction: true\nIndentWidth: 4\n',
        );
    });

    it('rejects multi-line YAML at the dumpConfig boundary', async () => {
        // The binary answers "Invalid value for -style" here, which is a terrible
        // error to debug from the UI. Fail early and say what to use instead.
        await expect(runtime.dumpConfig('BasedOnStyle: LLVM\nIndentWidth: 8\n', 'main.cc')).rejects.toThrow(
            /inline flow/,
        );
    });

    it('accepts inline flow at the dumpConfig boundary', async () => {
        const dumped = await runtime.dumpConfig('{BasedOnStyle: LLVM, IndentWidth: 8}', 'main.cc');
        expect(yaml.load(dumped)).toMatchObject({ IndentWidth: 8, Language: 'Cpp' });
    });

    describe("the project's own .clang-format", () => {
        let original: string;
        let baseDump: string;

        beforeAll(async () => {
            original = await readFile(path.join(FIXTURES, 'wxwidgets-life.clang-format'), 'utf8');
            baseDump = await runtime.dumpConfig('LLVM', 'main.cc');
        });

        it('round-trips through the sparse model without losing anything', async () => {
            const parsed = fromFileText(original, baseDump, knownPaths);
            expect(parsed.baseStyle).toBe('LLVM');
            expect(parsed.unknownKeys).toEqual([]);

            // The interesting shapes: a partial nested struct and a list of structs.
            expect(parsed.overrides.get('BraceWrapping.AfterFunction')).toBe(true);
            expect(parsed.overrides.get('IncludeCategories')).toHaveLength(3);
            expect(parsed.overrides.get('ColumnLimit')).toBe(110);
            expect(parsed.overrides.get('PointerAlignment')).toBe('Left');

            // Re-exporting and re-importing must be a fixed point.
            const doc = { languageId: 'cpp', baseStyle: 'LLVM' as const, overrides: parsed.overrides };
            const reparsed = fromFileText(toFileText(doc), baseDump, knownPaths);
            expect([...reparsed.overrides.entries()].sort()).toEqual([...parsed.overrides.entries()].sort());
        });

        it('formats identically whether fed the original file or our regenerated one', async () => {
            // A real header from the project this fixture config belongs to, so the
            // comparison is against code the config was actually written for.
            const sample = await readFile(path.join(FIXTURES, 'Rule.hpp'), 'utf8');
            const parsed = fromFileText(original, baseDump, knownPaths);
            const doc = { languageId: 'cpp', baseStyle: 'LLVM' as const, overrides: parsed.overrides };

            const viaOriginal = await runtime.format({ code: sample, filename: 'main.hpp', style: original });
            const viaRegenerated = await runtime.format({ code: sample, filename: 'main.hpp', style: toFileText(doc) });
            const viaInline = await runtime.format({ code: sample, filename: 'main.hpp', style: toInlineStyle(doc) });

            expect(viaOriginal.status).not.toBe('error');
            expect(viaRegenerated.text ?? sample).toBe(viaOriginal.text ?? sample);
            expect(viaInline.text ?? sample).toBe(viaOriginal.text ?? sample);
        });
    });

    it('keeps a partial struct partial, so the base style fills the rest', () => {
        const doc = setOverride(createDocument('cpp', 'LLVM'), 'BraceWrapping.AfterFunction', true);
        expect(toNestedObject(doc.overrides)).toEqual({ BraceWrapping: { AfterFunction: true } });
    });
});
