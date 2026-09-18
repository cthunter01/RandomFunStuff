import { beforeAll, describe, expect, it } from 'vitest';
import catalogJson from '../../../src/core/catalog/generated/options.23.1.1.json' with { type: 'json' };
import type { OptionCatalog } from '../../../src/core/catalog/types.ts';
import { analyseImpact, summarise, type ImpactMap } from '../../../src/core/analysis/impact.ts';
import { createDocument } from '../../../src/core/config/model.ts';
import { getLanguage, listLanguages } from '../../../src/core/languages/registry.ts';
import { sharedRuntime } from '../../support/nodeRuntime.ts';
import type { Runtime } from '../../../src/worker/runtime.ts';

/**
 * The samples are the app's teaching material. An option the sample never
 * exercises shows up as "no effect on your code", which is true but useless — so
 * how much of clang-format a sample can demonstrate is a property worth testing,
 * not a matter of taste.
 *
 * These thresholds are deliberately below what the samples currently reach, so
 * they fail on a real regression rather than on noise from a clang-format bump.
 */

const catalog = catalogJson as unknown as OptionCatalog;
let runtime: Runtime;
const sweeps = new Map<string, ImpactMap>();

const sweep = async (languageId: string, sampleId: string): Promise<ImpactMap> => {
    const key = `${languageId}/${sampleId}`;
    const cached = sweeps.get(key);
    if (cached) return cached;
    const language = getLanguage(languageId);
    const sample = language.samples.find((s) => s.id === sampleId)!;
    const map = await analyseImpact({
        catalog,
        doc: createDocument(languageId, 'LLVM'),
        code: sample.code,
        filename: language.probeFilename,
        port: runtime,
    });
    sweeps.set(key, map);
    return map;
};

beforeAll(async () => {
    runtime = await sharedRuntime();
});

describe('code samples', () => {
    it('gives every language a default that exists', () => {
        for (const language of listLanguages()) {
            expect(language.samples.length).toBeGreaterThan(0);
            expect(language.samples.map((s) => s.id)).toContain(language.defaultSampleId);
            for (const sample of language.samples) {
                expect(sample.code.split('\n').length, `${language.id}/${sample.id}`).toBeGreaterThan(15);
                expect(sample.exercises.length, `${language.id}/${sample.id}`).toBeGreaterThan(0);
            }
        }
    });

    it('exercises a wide slice of clang-format from the default C++ sample alone', async () => {
        const { live } = summarise(await sweep('cpp', 'kitchen-sink'));
        expect(live).toBeGreaterThan(100);
    });

    describe('the default C++ sample contains the constructs it claims', () => {
        // Each option below is only live if the corresponding construct is present,
        // which makes this an assertion about the *code*, checked by clang-format
        // rather than by grepping for keywords.
        const constructs: Array<[string, string]> = [
            ['a struct', 'BraceWrapping.AfterStruct'],
            ['a union', 'BraceWrapping.AfterUnion'],
            ['an enum', 'BraceWrapping.AfterEnum'],
            ['an else branch', 'BraceWrapping.BeforeElse'],
            ['a do-while loop', 'BraceWrapping.BeforeWhile'],
            ['a try/catch', 'BraceWrapping.BeforeCatch'],
            ['a switch with case labels', 'BraceWrapping.AfterCaseLabel'],
            ['an extern "C" block', 'IndentExternBlock'],
            ['a goto label', 'IndentGotoLabels'],
            ['bitfields', 'BitFieldColonSpacing'],
            ['an enum that can fit on one line', 'AllowShortEnumsOnASingleLine'],
            ['a base-class list', 'BreakInheritanceList'],
            ['preprocessor conditionals', 'IndentPPDirectives'],
            ['multi-line macros', 'AlignEscapedNewlines'],
            ['adjacent string literals', 'BreakAdjacentStringLiterals'],
            ['long string literals', 'BreakStringLiterals'],
            ['hex and suffixed numeric literals', 'NumericLiteralCase.HexDigit'],
            ['a template declaration', 'BreakTemplateDeclarations'],
            ['operator overloads', 'SpaceAfterOperatorKeyword'],
            ['a range-based for loop', 'SpaceBeforeRangeBasedForLoopColon'],
            ['consecutive assignments worth aligning', 'AlignConsecutiveAssignments'],
            ['consecutive #defines worth aligning', 'AlignConsecutiveMacros'],
            ['bitfields worth aligning', 'AlignConsecutiveBitFields'],
        ];

        for (const [construct, option] of constructs) {
            it(`has ${construct} (so ${option} does something)`, async () => {
                expect((await sweep('cpp', 'kitchen-sink')).get(option)?.verdict).toBe('live');
            });
        }
    });

    it('covers C++20 concepts in a sample of its own', async () => {
        const map = await sweep('cpp', 'templates-and-concepts');
        for (const option of ['BreakBeforeConceptDeclarations', 'IndentRequiresClause', 'RequiresClausePosition']) {
            expect(map.get(option)?.verdict, option).toBe('live');
        }
    });

    it('covers structs, unions, else and goto in C too', async () => {
        const map = await sweep('c', 'c-basics');
        for (const option of [
            'BraceWrapping.AfterStruct',
            'BraceWrapping.AfterUnion',
            'BraceWrapping.BeforeElse',
            'IndentGotoLabels',
            'BitFieldColonSpacing',
        ]) {
            expect(map.get(option)?.verdict, option).toBe('live');
        }
    });

    it('reports what a measurement had to assume rather than pretending', async () => {
        // `BraceWrapping.*` does nothing unless BreakBeforeBraces is Custom. Calling
        // it "no effect on your code" would be a lie, so the sweep turns the
        // prerequisite on and records that it did.
        const result = (await sweep('cpp', 'kitchen-sink')).get('BraceWrapping.AfterStruct');
        expect(result?.assumes).toEqual([{ path: 'BreakBeforeBraces', value: 'Custom' }]);
    });
});
