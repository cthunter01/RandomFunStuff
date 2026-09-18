/**
 * Generates the option catalog for a pinned clang-format version.
 *
 *   npm run catalog:generate            # fetch docs, parse, probe, write JSON
 *   npm run catalog:check               # offline: assert committed JSON still matches the binary
 *
 * The generated JSON is committed. A fresh clone then builds with no network, CI
 * never depends on raw.githubusercontent.com, and bumping clang-format becomes a
 * reviewable diff where you can literally see which options appeared.
 *
 * `--check` runs in the build and is deliberately offline: it validates the
 * committed catalog against the real wasm binary, which is the drift that
 * actually matters.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { parseStyleOptionsRst } from './rst-parser.ts';
import { BASE_STYLES, NON_OPTION_KEYS, type OptionCatalog, type OptionDescriptor } from '../src/core/catalog/types.ts';
import { listLanguages } from '../src/core/languages/registry.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'src/core/catalog/generated');

/** The clang-format version to build a catalog for. Must match the installed wasm. */
const DEFAULT_VERSION = '23.1.1';

function rstUrlFor(version: string): string {
    return `https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-${version}/clang/docs/ClangFormatStyleOptions.rst`;
}

/** Loads the wasm binary through its Node entry point. */
async function loadBinary() {
    const mod = await import('@wasm-fmt/clang-format/clang-format-node.js');
    return mod.ClangFormat;
}

/**
 * Serializes a style as inline flow (`{Key: Value, ...}`).
 *
 * This is not a stylistic choice. `dump_config` rejects raw multi-line YAML with
 * "Invalid value for -style" — only a predefined name or inline flow works —
 * while `format()` accepts both. Verified against 23.1.1.
 */
function inlineStyle(entries: Record<string, unknown>): string {
    return yaml.dump(entries, { flowLevel: 0, lineWidth: -1 }).trim();
}

/**
 * Probes which enum values the binary rejects when set on their own.
 *
 * This started life as a language-applicability probe and that did not work:
 * clang-format accepts virtually every option key for every language and simply
 * ignores the irrelevant ones, so across all 209 options it found exactly zero
 * language restrictions. What it *did* find were two values rejected by every
 * language — `QualifierAlignment: Custom` and `InsertTrailingCommas: Wrapped` —
 * which are not language facts at all but unmet inter-option dependencies.
 *
 * So that is what it measures now, which is directly useful: the UI must not
 * offer a value as a bare choice when picking it would produce a config
 * clang-format refuses to load.
 */
function probePrerequisites(ClangFormat: any, options: OptionDescriptor[]): void {
    const snippet = 'int main() { return 0; }\n';
    for (const option of options) {
        if (option.kind !== 'enum') continue;
        for (const value of option.values) {
            const style = inlineStyle({ BasedOnStyle: 'LLVM', [option.name]: value.value });
            const formatter = new ClangFormat();
            try {
                formatter.with_style(style).format(snippet, 'main.cc');
            } catch {
                value.needsPrerequisite = true;
            } finally {
                formatter[Symbol.dispose]();
            }
        }
    }
}

interface ValidationReport {
    emittedButUndocumented: string[];
    documentedButUnemitted: string[];
    emitted: string[];
}

/**
 * Flattens a dumped config to dotted paths, so nested fields are validated too.
 * Checking only top-level keys once let a parser bug hide three real
 * `BraceWrapping` fields, which is exactly the drift this gate exists to catch.
 */
function emittedPaths(ClangFormat: any, style: string, filename: string): Set<string> {
    const parsed = yaml.load(ClangFormat.dump_config({ style, filename })) as Record<string, unknown>;
    const paths = new Set<string>();
    for (const [key, value] of Object.entries(parsed ?? {})) {
        paths.add(key);
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const field of Object.keys(value as object)) paths.add(`${key}.${field}`);
        }
    }
    return paths;
}

function validate(ClangFormat: any, options: OptionDescriptor[]): ValidationReport {
    const documented = new Set<string>();
    for (const o of options) {
        documented.add(o.name);
        for (const f of o.fields) documented.add(`${o.name}.${f.name}`);
    }
    const emitted = new Set<string>();
    for (const style of BASE_STYLES) {
        for (const language of listLanguages()) {
            for (const key of emittedPaths(ClangFormat, style, language.probeFilename)) emitted.add(key);
        }
    }
    const emittedButUndocumented = [...emitted].filter((k) => !documented.has(k) && !NON_OPTION_KEYS.has(k)).sort();
    const documentedButUnemitted = [...documented]
        .filter((name) => !emitted.has(name) && !NON_OPTION_KEYS.has(name))
        .sort();
    return { emittedButUndocumented, documentedButUnemitted, emitted: [...emitted].sort() };
}

function catalogPath(version: string): string {
    return path.join(OUT_DIR, `options.${version}.json`);
}

async function generate(version: string): Promise<void> {
    const url = rstUrlFor(version);
    process.stdout.write(`fetching ${url}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch option docs: ${response.status} ${response.statusText}`);
    const rst = await response.text();
    const sha256 = createHash('sha256').update(rst).digest('hex');

    const options = parseStyleOptionsRst(rst).filter((o) => !NON_OPTION_KEYS.has(o.name) && o.name !== 'BasedOnStyle');
    process.stdout.write(`parsed ${options.length} options from ${rst.split('\n').length} lines of docs\n`);

    const ClangFormat = await loadBinary();
    const reportedVersion = /version (\S+)/.exec(ClangFormat.version())?.[1];
    if (reportedVersion !== version) {
        throw new Error(
            `Binary/catalog mismatch: asked for ${version} but the installed wasm reports ${reportedVersion}. ` +
                `Pin @wasm-fmt/clang-format to ${version}.`,
        );
    }

    process.stdout.write('probing value prerequisites...\n');
    probePrerequisites(ClangFormat, options);

    const report = validate(ClangFormat, options);
    if (report.emittedButUndocumented.length > 0) {
        throw new Error(
            `The binary emits ${report.emittedButUndocumented.length} option(s)/field(s) the catalog does not ` +
                `describe, so the UI would hide them:\n  ` +
                report.emittedButUndocumented.join('\n  '),
        );
    }
    // The other direction is expected and harmless: deprecated aliases and
    // list-valued options that dump_config omits when empty. Record it rather
    // than allowlisting it by hand, so --check can detect a real change later.
    const emittedSet = new Set(report.emitted);
    for (const option of options) option.emittedByDumpConfig = emittedSet.has(option.name);

    const catalog: OptionCatalog = {
        clangFormatVersion: version,
        sourceTag: `llvmorg-${version}`,
        rstSha256: sha256,
        generatedAt: new Date().toISOString(),
        baseStyles: BASE_STYLES,
        options,
    };
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(catalogPath(version), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

    const stats = {
        options: options.length,
        enums: options.filter((o) => o.kind === 'enum').length,
        enumValues: options.reduce((n, o) => n + o.values.length, 0),
        nested: options.filter((o) => o.fields.length > 0).length,
        withExamples: options.filter((o) => o.examples.length > 0).length,
        languageTagged: options.filter((o) => o.languageHints.length > 0).length,
        valuesNeedingPrerequisite: options.reduce((n, o) => n + o.values.filter((v) => v.needsPrerequisite).length, 0),
        notEmitted: report.documentedButUnemitted.length,
    };
    process.stdout.write(`wrote ${catalogPath(version)}\n${JSON.stringify(stats, null, 2)}\n`);
}

async function check(version: string): Promise<void> {
    const file = catalogPath(version);
    if (!existsSync(file)) throw new Error(`No committed catalog at ${file}. Run: npm run catalog:generate`);
    const catalog = JSON.parse(await readFile(file, 'utf8')) as OptionCatalog;

    const ClangFormat = await loadBinary();
    const reportedVersion = /version (\S+)/.exec(ClangFormat.version())?.[1];
    if (reportedVersion !== catalog.clangFormatVersion) {
        throw new Error(
            `Catalog is for ${catalog.clangFormatVersion} but the installed wasm is ${reportedVersion}. ` +
                `These must move together.`,
        );
    }

    const report = validate(ClangFormat, catalog.options);
    const problems: string[] = [];
    if (report.emittedButUndocumented.length > 0) {
        problems.push(`Binary emits undocumented options: ${report.emittedButUndocumented.join(', ')}`);
    }
    const recordedEmitted = catalog.options.filter((o) => o.emittedByDumpConfig).map((o) => o.name).sort();
    const nowEmitted = catalog.options.filter((o) => report.emitted.includes(o.name)).map((o) => o.name).sort();
    if (recordedEmitted.join('|') !== nowEmitted.join('|')) {
        const added = nowEmitted.filter((n) => !recordedEmitted.includes(n));
        const removed = recordedEmitted.filter((n) => !nowEmitted.includes(n));
        problems.push(`dump_config drift — newly emitted: [${added.join(', ')}], no longer emitted: [${removed.join(', ')}]`);
    }
    if (problems.length > 0) {
        throw new Error(`Catalog is out of date. Run: npm run catalog:generate\n  ${problems.join('\n  ')}`);
    }
    process.stdout.write(
        `catalog ok: ${catalog.options.length} options for clang-format ${catalog.clangFormatVersion}\n`,
    );
}

const args = process.argv.slice(2);
const versionArg = args.indexOf('--version');
const version = versionArg >= 0 ? args[versionArg + 1]! : DEFAULT_VERSION;
const run = args.includes('--check') ? check(version) : generate(version);
run.catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
