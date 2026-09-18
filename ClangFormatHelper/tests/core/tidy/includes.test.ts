import { describe, expect, it } from 'vitest';
import { scanIncludes } from '../../../src/core/tidy/includes.ts';
import { cpp, c } from '../../../src/core/languages/defs/cpp.ts';
import { sharedTidyRuntime } from '../../support/tidyRuntime.ts';

describe('scanIncludes', () => {
    it('finds both spellings, once each, and nothing that escapes the sandbox', () => {
        const code = '#include <vector>\n  #  include "a/b.h"\n#include "a/b.h"\n#include "../up.h"\n#include </abs.h>\n';
        expect(scanIncludes(code)).toEqual([
            { path: 'vector', angled: true },
            { path: 'a/b.h', angled: false },
        ]);
    });
});

describe('header stand-ins, against the binary', () => {
    // The shipped samples include their own project's headers, as real code does.
    // Without stand-ins that is a fatal error that hides everything after it.
    for (const [language, sample, args] of [
        [cpp, 'kitchen-sink', ['-std=c++23']],
        [c, 'c-basics', ['-std=c17']],
    ] as const) {
        it(`lets the ${sample} sample compile cleanly`, async () => {
            const runtime = await sharedTidyRuntime();
            const code = language.samples.find((s) => s.id === sample)!.code;
            const outcome = await runtime.run({
                code,
                filename: language.id === 'c' ? 'sample.c' : 'sample.cpp',
                config: JSON.stringify({ Checks: 'clang-diagnostic-*' }),
                compileArgs: [...args],
            });
            expect(outcome.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
            expect(outcome.stubbedIncludes.length).toBeGreaterThan(0);
            // Standard headers resolve for real and are never stubbed.
            expect(outcome.stubbedIncludes.some((p) => /^(vector|string|stdio\.h|stdlib\.h)$/.test(p))).toBe(false);
        });
    }
});
