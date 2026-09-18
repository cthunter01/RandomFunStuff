import { describe, expect, it } from 'vitest';
import catalogJson from '../../../src/core/catalog/generated/tidy.23.1.1.json' with { type: 'json' };
import type { TidyCatalog } from '../../../src/core/tidy/catalog.ts';
import {
    decidingGlob,
    formatChecks,
    isCheckEnabled,
    parseChecks,
    setCheck,
    setFamily,
} from '../../../src/core/tidy/checks.ts';
import { sharedTidyRuntime } from '../../support/tidyRuntime.ts';

const catalog = catalogJson as unknown as TidyCatalog;
const builtin = parseChecks(catalog.defaultChecks);

describe('Checks glob list', () => {
    it('parses the way people actually write it', () => {
        const globs = parseChecks(' -* ,\n  bugprone-*,\n  -bugprone-easily-swappable-parameters, ');
        expect(globs).toEqual([
            { pattern: '*', enable: false },
            { pattern: 'bugprone-*', enable: true },
            { pattern: 'bugprone-easily-swappable-parameters', enable: false },
        ]);
        expect(formatChecks(globs)).toBe('-*,bugprone-*,-bugprone-easily-swappable-parameters');
    });

    it('lets the last matching glob win', () => {
        const globs = parseChecks('-*,bugprone-*,-bugprone-easily-*');
        expect(isCheckEnabled(globs, 'bugprone-use-after-move')).toBe(true);
        expect(isCheckEnabled(globs, 'bugprone-easily-swappable-parameters')).toBe(false);
        expect(isCheckEnabled(globs, 'modernize-use-nullptr')).toBe(false);
    });

    it("applies clang-tidy's default before the file's own globs", () => {
        // The default is compiler diagnostics; a file that never says `-*` keeps them.
        expect(catalog.defaultChecks).toBe('clang-diagnostic-*');
        expect(isCheckEnabled(parseChecks('bugprone-*'), 'clang-diagnostic-unused-variable', builtin)).toBe(true);
        expect(isCheckEnabled(parseChecks('-*,bugprone-*'), 'clang-diagnostic-unused-variable', builtin)).toBe(false);
        expect(decidingGlob(parseChecks('bugprone-*'), 'clang-diagnostic-unused-variable', builtin)?.builtin).toBe(true);
    });

    it('toggles a check with the smallest edit, and toggling back undoes it', () => {
        const start = parseChecks('-*,bugprone-*');
        const off = setCheck(start, 'bugprone-use-after-move', false, builtin);
        expect(formatChecks(off)).toBe('-*,bugprone-*,-bugprone-use-after-move');
        expect(formatChecks(setCheck(off, 'bugprone-use-after-move', true, builtin))).toBe('-*,bugprone-*');
        // Already on: nothing to add.
        expect(formatChecks(setCheck(start, 'bugprone-branch-clone', true, builtin))).toBe('-*,bugprone-*');
    });

    it('turns a whole module on without leaving shadowed entries behind', () => {
        const start = parseChecks('-*,modernize-use-nullptr,-modernize-use-auto');
        expect(formatChecks(setFamily(start, 'modernize-*', true))).toBe('-*,modernize-*');
    });

    it('treats glob metacharacters other than * literally', () => {
        expect(isCheckEnabled(parseChecks('clang-analyzer-core.*'), 'clang-analyzer-core.DivideZero')).toBe(true);
        // `.` is not "any character".
        expect(isCheckEnabled(parseChecks('clang-analyzer-coreXDivideZero'), 'clang-analyzer-core.DivideZero')).toBe(false);
    });
});

describe('Checks glob list, against the binary', () => {
    // Whatever the model says is enabled must be exactly what `--list-checks`
    // reports, or every toggle in the UI is a guess.
    const configs = [
        '-*,bugprone-*',
        'bugprone-*,-bugprone-easily-*',
        '*,-clang-analyzer-*',
        '-*,modernize-use-*,-modernize-use-trailing-return-type',
        ' -* , readability-identifier-naming ,\n performance-* ',
        '-*,cert-*',
        '-*,*-magic-numbers,clang-analyzer-core.*',
    ];
    for (const checks of configs) {
        it(`agrees on ${JSON.stringify(checks)}`, async () => {
            const runtime = await sharedTidyRuntime();
            const fromBinary = (await runtime.listChecks(JSON.stringify({ Checks: checks }))).sort();
            const globs = parseChecks(checks);
            const fromModel = catalog.checks
                .map((c) => c.name)
                .filter((name) => isCheckEnabled(globs, name, builtin))
                .sort();
            expect(fromModel).toEqual(fromBinary);
        });
    }
});
