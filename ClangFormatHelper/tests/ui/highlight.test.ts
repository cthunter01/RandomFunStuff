import { beforeAll, describe, expect, it } from 'vitest';
import { ensureGrammar, highlightLines } from '../../src/ui/highlight/highlight.ts';

/**
 * The highlighter rewrites source into spans, so the one invariant that must never
 * break is that it does not lose or reorder a single character. Everything else is
 * cosmetic; this is not.
 */
const SAMPLE = `#include <vector>

/* a block comment
   spanning three
   lines */
namespace demo {
class Widget : public Base {
public:
    Widget(int w) : w_(w) {}   ///< trailing doc
    const char *name() const { return "a \\"quoted\\" string"; }
private:
    int w_ = 0;
};
}  // namespace demo
`;

const joined = (lines: ReturnType<typeof highlightLines>): string[] =>
    lines.map((line) => line.map((t) => t.text).join(''));

describe('syntax highlighting', () => {
    it('falls back to plain text before a grammar has loaded', () => {
        // Nothing has been loaded for this id and nothing ever will be.
        const lines = highlightLines('int x = 1;\nint y = 2;\n', 'not-a-language');
        expect(joined(lines)).toEqual(['int x = 1;', 'int y = 2;', '']);
        expect(lines.flat().every((t) => t.cls === null)).toBe(true);
    });

    describe('once the C++ grammar is available', () => {
        beforeAll(async () => {
            ensureGrammar('cpp');
            // ensureGrammar is fire-and-forget; poll rather than reach into its internals.
            for (let i = 0; i < 100; i++) {
                if (highlightLines('int x;', 'cpp').flat().some((t) => t.cls)) return;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error('C++ grammar never loaded');
        });

        it('preserves every character, line for line', () => {
            expect(joined(highlightLines(SAMPLE, 'cpp'))).toEqual(SAMPLE.split('\n'));
        });

        it('produces one entry per line', () => {
            expect(highlightLines(SAMPLE, 'cpp')).toHaveLength(SAMPLE.split('\n').length);
        });

        it('classifies the obvious things', () => {
            const lines = highlightLines(SAMPLE, 'cpp');
            const tokens = lines.flat();
            const classFor = (text: string) => tokens.find((t) => t.text === text)?.cls;
            expect(classFor('namespace')).toContain('tok-keyword');
            expect(classFor('class')).toContain('tok-keyword');
            expect(classFor('#include')).toContain('tok-meta');
            expect(classFor('0')).toContain('tok-number');
        });

        it('splits a multi-line comment across its lines rather than onto one', () => {
            const lines = highlightLines(SAMPLE, 'cpp');
            // Lines 3-5 (1-based) are the block comment; each must carry its own
            // piece, with no line swallowing the others.
            for (const index of [2, 3, 4]) {
                const line = lines[index]!;
                expect(line.length).toBeGreaterThan(0);
                expect(line.every((t) => t.cls?.includes('tok-comment'))).toBe(true);
                expect(line.map((t) => t.text).join('')).not.toContain('\n');
            }
        });

        it('never emits a newline inside a token', () => {
            expect(highlightLines(SAMPLE, 'cpp').flat().some((t) => t.text.includes('\n'))).toBe(false);
        });

        it('shares one grammar between C and C++', () => {
            // `c` maps to the same grammar, so it is highlighted without a second load.
            expect(highlightLines('int main(void) { return 0; }', 'c').flat().some((t) => t.cls)).toBe(true);
        });

        it('returns a stable result for repeated calls (the render-path cache)', () => {
            expect(highlightLines(SAMPLE, 'cpp')).toBe(highlightLines(SAMPLE, 'cpp'));
        });
    });
});
