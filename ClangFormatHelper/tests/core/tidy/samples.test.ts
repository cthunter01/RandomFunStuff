import { describe, expect, it } from 'vitest';
import catalogJson from '../../../src/core/catalog/generated/tidy.23.1.1.json' with { type: 'json' };
import { moduleOf, type TidyCatalog } from '../../../src/core/tidy/catalog.ts';
import { survey } from '../../../src/core/tidy/analysis.ts';
import { createTidyDocument } from '../../../src/core/tidy/config.ts';
import { cpp } from '../../../src/core/languages/defs/cpp.ts';
import { sharedTidyRuntime } from '../../support/tidyRuntime.ts';

/**
 * The Tidy sample is teaching material in the same sense as the format samples:
 * a check the sample never trips can only say "nothing here". So its breadth is
 * asserted by running clang-tidy, not by grepping for constructs — trimming the
 * sample without noticing what it cost fails here.
 */

const catalog = catalogJson as unknown as TidyCatalog;

describe('the clang-tidy sample', () => {
    it('trips checks across the modules people actually enable', async () => {
        const port = await sharedTidyRuntime();
        const code = cpp.samples.find((s) => s.id === 'tidy-findings')!.code;
        const result = await survey({ catalog, doc: createTidyDocument(), code, filename: 'a.cpp', compileArgs: ['-std=c++23'], port });

        expect(result.compileErrors).toEqual([]);
        const firing = [...result.findings.keys()].filter((k) => result.covered.has(k) && !result.findings.get(k)!.via);
        // 58 primary checks when written, aliases not counted; the 286-line kitchen sink manages 41.
        expect(firing.length).toBeGreaterThanOrEqual(55);

        const modules = new Set(firing.map(moduleOf));
        for (const module of ['bugprone', 'clang-analyzer', 'performance', 'modernize', 'readability', 'cppcoreguidelines', 'misc']) {
            expect(modules, module).toContain(module);
        }
        // One signature finding per module, each deliberately planted.
        for (const check of [
            'bugprone-use-after-move',
            'bugprone-dangling-handle',
            'clang-analyzer-core.DivideZero',
            'performance-unnecessary-value-param',
            'performance-for-range-copy',
            'modernize-use-override',
            'modernize-loop-convert',
            'modernize-use-nullptr',
            'readability-else-after-return',
            'readability-implicit-bool-conversion',
            'cppcoreguidelines-special-member-functions',
            'misc-const-correctness',
        ]) {
            expect(firing, check).toContain(check);
        }
    });
});
