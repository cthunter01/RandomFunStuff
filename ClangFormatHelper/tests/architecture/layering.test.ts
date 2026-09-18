import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The architecture guard.
 *
 * The layering rules below are the whole reason this project can grow another
 * language or another layout without turning into three bespoke screens, so they
 * are enforced by a failing test rather than by a paragraph in a README that
 * nobody re-reads. Same idea as the layering check in wxWidgets_Life.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');

interface LayerRule {
    /** Directory under src/, e.g. 'core'. */
    layer: string;
    /** Import specifiers this layer must never reach for. */
    forbidden: RegExp[];
    why: string;
}

const RULES: LayerRule[] = [
    {
        layer: 'core',
        forbidden: [
            /^react(-dom)?(\/|$)/,
            /^@codemirror\//,
            /^@wasm-fmt\//,
            /(^|\/)ui\//,
            /\.\.\/ui\//,
            /(^|\/)worker\/(?!protocol)/,
            /(^|\/)app\//,
        ],
        why: 'core is the framework-free engine: no React, no CodeMirror, no wasm, no UI. It reaches the formatter only through FormatterPort.',
    },
    {
        layer: 'worker',
        forbidden: [/^react(-dom)?(\/|$)/, /^@codemirror\//, /(^|\/)ui\//, /(^|\/)app\//],
        why: 'the worker hosts wasm off the main thread; it must not pull in the UI.',
    },
    {
        layer: 'ui',
        forbidden: [/^@wasm-fmt\//, /(^|\/)worker\/(?!protocol|client)/],
        why: 'importing @wasm-fmt on the main thread installs a second 2.5 MB module in that realm; the UI must go through the worker client.',
    },
];

/** Matches `import ... from 'x'`, `export ... from 'x'`, and `import('x')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
}

describe('layering', () => {
    for (const rule of RULES) {
        it(`src/${rule.layer} respects its boundaries — ${rule.why}`, () => {
            const violations: string[] = [];
            for (const file of sourceFiles(path.join(SRC, rule.layer))) {
                const text = readFileSync(file, 'utf8');
                for (const match of text.matchAll(SPECIFIER)) {
                    const specifier = match[1]!;
                    for (const forbidden of rule.forbidden) {
                        if (forbidden.test(specifier)) {
                            violations.push(`${path.relative(ROOT, file)} imports "${specifier}"`);
                        }
                    }
                }
            }
            expect(violations, `\n${violations.join('\n')}\n\n${rule.why}`).toEqual([]);
        });
    }

    it('every source file lives in a known layer', () => {
        const known = new Set(['core', 'worker', 'ui', 'app', 'types']);
        const strays = readdirSync(SRC, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !known.has(e.name))
            .map((e) => e.name);
        expect(strays, 'new top-level directories need a layering rule before they gain code').toEqual([]);
    });
});
