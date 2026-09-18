import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import catalogJson from '../../../src/core/catalog/generated/tidy.23.1.1.json' with { type: 'json' };
import { sameOptionValue, type TidyCatalog } from '../../../src/core/tidy/catalog.ts';
import { formatChecks, parseChecks } from '../../../src/core/tidy/checks.ts';
import {
    fromTidyFileText,
    resolveTidyEffective,
    setOption,
    setSetting,
    toConfigJson,
    toTidyFileText,
    type TidyDocument,
} from '../../../src/core/tidy/config.ts';
import { sharedTidyRuntime } from '../../support/tidyRuntime.ts';

const catalog = catalogJson as unknown as TidyCatalog;

function sampleDoc(): TidyDocument {
    let doc: TidyDocument = {
        checks: parseChecks('-*,bugprone-*,-bugprone-easily-swappable-parameters,modernize-*,readability-identifier-naming'),
        options: new Map(),
        settings: new Map(),
    };
    doc = setOption(doc, 'readability-identifier-naming.ClassCase', 'CamelCase');
    doc = setOption(doc, 'modernize-use-nullptr.NullMacros', 'NULL;MY_NULL');
    doc = setOption(doc, 'bugprone-argument-comment.StrictMode', 'true');
    doc = setSetting(doc, 'WarningsAsErrors', 'bugprone-*');
    return doc;
}

describe('.clang-tidy text', () => {
    it('writes a long Checks list one glob per line, and only what was changed', () => {
        const text = toTidyFileText(sampleDoc());
        expect(text).toBe(
            [
                'Checks: >-',
                '  -*,',
                '  bugprone-*,',
                '  -bugprone-easily-swappable-parameters,',
                '  modernize-*,',
                '  readability-identifier-naming',
                "WarningsAsErrors: bugprone-*",
                'CheckOptions:',
                "  bugprone-argument-comment.StrictMode: 'true'",
                '  modernize-use-nullptr.NullMacros: NULL;MY_NULL',
                '  readability-identifier-naming.ClassCase: CamelCase',
                '',
            ].join('\n'),
        );
    });

    it('reads its own output back unchanged', () => {
        const doc = sampleDoc();
        const parsed = fromTidyFileText(toTidyFileText(doc), catalog);
        expect(formatChecks(parsed.doc.checks)).toBe(formatChecks(doc.checks));
        expect(parsed.doc.options).toEqual(doc.options);
        expect(parsed.doc.settings).toEqual(doc.settings);
        expect(parsed.unknownKeys).toEqual([]);
        expect(parsed.unknownOptions).toEqual([]);
    });

    it('accepts the older spellings and reports what it does not know', () => {
        const parsed = fromTidyFileText(
            [
                'Checks:',
                '  - "-*"',
                '  - "performance-*"',
                'CheckOptions:',
                '  - key: performance-unnecessary-value-param.AllowedTypes',
                '    value: "Foo;Bar"',
                '  - key: performance-no-such-check.Bogus',
                '    value: 1',
                'NotARealKey: true',
                '',
            ].join('\n'),
            catalog,
        );
        expect(formatChecks(parsed.doc.checks)).toBe('-*,performance-*');
        expect(parsed.doc.options.get('performance-unnecessary-value-param.AllowedTypes')).toBe('Foo;Bar');
        expect(parsed.unknownKeys).toEqual(['NotARealKey']);
        expect(parsed.unknownOptions).toEqual(['performance-no-such-check.Bogus']);
    });
});

describe('structured settings', () => {
    it('keeps CustomChecks verbatim through import and export', () => {
        const text = [
            "Checks: '-*,custom-*'",
            'CustomChecks:',
            '  - Name: avoid-printf',
            '    Query: |',
            '      match callExpr(callee(functionDecl(hasName("printf"))))',
            '    Diagnostic:',
            '      - BindName: root',
            '        Message: use std::print instead',
            '',
        ].join('\n');
        const parsed = fromTidyFileText(text, catalog);
        const again = fromTidyFileText(toTidyFileText(parsed.doc), catalog);
        expect(again.doc.settings.get('CustomChecks')).toEqual(parsed.doc.settings.get('CustomChecks'));
        expect(toTidyFileText(parsed.doc)).toContain('Message: use std::print instead');
        expect(JSON.parse(toConfigJson(parsed.doc)).CustomChecks[0].Name).toBe('avoid-printf');
    });
});

describe('.clang-tidy text, against the binary', () => {
    it('means to clang-tidy exactly what the model says', async () => {
        const runtime = await sharedTidyRuntime();
        const doc = sampleDoc();
        // Hand clang-tidy the exported *file text*, folded block and all.
        const dump = yaml.load(await runtime.dumpConfig(toTidyFileText(doc), 'a.cpp')) as {
            Checks: string;
            WarningsAsErrors: string;
            CheckOptions: Record<string, string>;
        };
        expect(parseChecks(dump.Checks)).toEqual(parseChecks(`${catalog.defaultChecks},${formatChecks(doc.checks)}`));
        expect(dump.WarningsAsErrors).toBe('bugprone-*');
        const kindOf = (key: string) =>
            catalog.checks.find((c) => key.startsWith(`${c.name}.`))!.options.find((o) => key.endsWith(`.${o.name}`))!.kind;
        for (const [key, value] of doc.options) {
            // Compared as clang-tidy reads them: this bool comes back as '1'.
            expect(sameOptionValue(kindOf(key), String(dump.CheckOptions[key]), value), key).toBe(true);
        }
        expect(dump.CheckOptions['bugprone-argument-comment.StrictMode']).toBe('1');
    });

    it('marks an option whose check is off as inactive', async () => {
        const runtime = await sharedTidyRuntime();
        let doc = sampleDoc();
        doc = setOption(doc, 'performance-for-range-copy.WarnOnAllAutoCopies', 'true'); // performance-* is off
        const effective = resolveTidyEffective(doc, await runtime.dumpConfig(toConfigJson(doc), 'a.cpp'));
        expect(effective.provenance.get('performance-for-range-copy.WarnOnAllAutoCopies')).toBe('inactive');
        expect(effective.provenance.get('readability-identifier-naming.ClassCase')).toBe('override');
        expect(effective.provenance.get('modernize-use-nullptr.IgnoredTypes')).toBe('default');
    });
});
