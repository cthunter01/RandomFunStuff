import { describe, expect, it } from 'vitest';
import { applyReplacements, parseExportedFixes, SourceMap } from '../../../src/core/tidy/diagnostics.ts';
import { sharedTidyRuntime } from '../../support/tidyRuntime.ts';

describe('SourceMap', () => {
    it('is the identity for ASCII', () => {
        const map = new SourceMap('int a;\nint b;\n');
        expect(map.indexOf(8)).toBe(8);
        expect(map.position(11)).toEqual({ line: 2, column: 5 });
    });

    it('converts UTF-8 byte offsets to string indices', () => {
        // é is 2 bytes, 語 is 3, and 🚀 is 4 bytes spread over two UTF-16 units.
        const text = 'é語🚀x';
        const map = new SourceMap(text);
        expect(map.indexOf(0)).toBe(0);
        expect(map.indexOf(2)).toBe(1);
        expect(map.indexOf(5)).toBe(2);
        expect(map.indexOf(9)).toBe(4);
        expect(text[map.indexOf(9)]).toBe('x');
    });
});

describe('applyReplacements', () => {
    it('applies edits in offset order regardless of input order', () => {
        const out = applyReplacements('aaa bbb ccc', [
            { offset: 8, length: 3, text: 'C' },
            { offset: 0, length: 3, text: 'A' },
        ]);
        expect(out).toEqual({ text: 'A bbb C', skipped: 0 });
    });

    it('skips an overlapping edit rather than corrupting the text', () => {
        const out = applyReplacements('abcdef', [
            { offset: 1, length: 3, text: 'X' },
            { offset: 2, length: 3, text: 'Y' },
        ]);
        expect(out).toEqual({ text: 'aXef', skipped: 1 });
    });

    it('applies a duplicated edit once', () => {
        const edit = { offset: 3, length: 0, text: 'override ' };
        expect(applyReplacements('abcdef', [edit, edit]).text).toBe('abcoverride def');
    });
});

describe('parseExportedFixes', () => {
    it('keeps only positions in the analysed file', () => {
        const yaml = `
Diagnostics:
  - DiagnosticName: modernize-use-nullptr
    DiagnosticMessage:
      Message: use nullptr
      FilePath: /work/a.cpp
      FileOffset: 9
      Replacements:
        - { FilePath: /work/a.cpp, Offset: 9, Length: 1, ReplacementText: nullptr }
        - { FilePath: /sysroot/usr/include/x.h, Offset: 0, Length: 1, ReplacementText: nope }
    Notes:
      - { Message: declared here, FilePath: /sysroot/usr/include/x.h, FileOffset: 3 }
    Level: Warning
`;
        const [d] = parseExportedFixes(yaml, 'int *p = 0;\n', '/work/a.cpp');
        expect(d).toMatchObject({
            check: 'modernize-use-nullptr',
            level: 'warning',
            span: { line: 1, column: 10, offset: 9 },
            replacements: [{ offset: 9, length: 1, text: 'nullptr' }],
            notes: [{ message: 'declared here', span: null }],
        });
    });
});

describe('fixes, against the binary', () => {
    // clang-tidy's own `--fix` is the oracle: applying the exported replacements
    // ourselves must produce byte-for-byte what it writes. Non-ASCII text before
    // the edits is what makes this test worth having — every offset is in UTF-8
    // bytes, and a mistake there shifts every fix after it.
    const code = [
        '// Größe, naïve café, 語, 🚀',
        '#include <cstddef>',
        'int *p = 0;',
        'void f(int *q = NULL);',
        'struct S { S() {} ~S() {} };',
        'int main() { int *r = 0; return r == 0; }',
        '',
    ].join('\n');
    const config = JSON.stringify({ Checks: '-*,modernize-use-nullptr,modernize-use-equals-default' });

    it('matches --fix exactly', async () => {
        const runtime = await sharedTidyRuntime();
        const outcome = await runtime.run({ code, filename: 'a.cpp', config, compileArgs: ['-std=c++23'] });
        expect(outcome.diagnostics.length).toBeGreaterThanOrEqual(5);
        const ours = applyReplacements(code, outcome.diagnostics.flatMap((d) => d.replacements));
        expect(ours.skipped).toBe(0);

        const fixed = await runtime.exec(
            ['/work/a.cpp', `--config=${config}`, '--fix', '--quiet', '--', '--target=x86_64-unknown-linux-musl',
                '--sysroot=/sysroot', '-resource-dir=/sysroot/lib/clang/23', '-stdlib=libc++', '-std=c++23'],
            { 'a.cpp': code },
        );
        expect(fixed.files['a.cpp']).not.toBe(code);
        expect(ours.text).toBe(fixed.files['a.cpp']);
    });

    it('reports positions as the editor sees them', async () => {
        const runtime = await sharedTidyRuntime();
        const outcome = await runtime.run({ code, filename: 'a.cpp', config, compileArgs: ['-std=c++23'] });
        const first = outcome.diagnostics.find((d) => d.check === 'modernize-use-nullptr')!;
        // Line 3, `int *p = 0;` — the literal is the 10th character.
        expect(first.span).toMatchObject({ line: 3, column: 10 });
        expect(code.slice(first.span!.offset, first.span!.offset + 1)).toBe('0');
    });
});
