/**
 * Generates the check catalog for the pinned clang-tidy build.
 *
 *   npm run tidy-catalog:generate                    # fetch docs, probe the binary, write JSON
 *   npm run tidy-catalog:generate -- --docs <dir>    # read docs from a local checkout instead
 *   npm run tidy-catalog:check                       # offline: committed JSON still matches the binary
 *
 * Two sources, with a strict division of labour:
 *
 *  - The **documentation** at the pinned tag says what each check and option is
 *    *for*: summaries, prose, examples, which checks are aliases of which.
 *  - The **binary** says what *exists* and how it behaves: the full check list,
 *    every option's default, and — by feeding it deliberately invalid values —
 *    every option's type. clang-tidy answers "expected a bool", "expected an
 *    integer", or rejects the value as a bad enumerator, and silence means the
 *    option takes free text. Candidate enum values from the docs are kept only
 *    when the binary accepts them.
 *
 * Where they disagree the binary wins, and the disagreement is recorded rather
 * than hidden: a check the binary has but the docs do not list still gets an
 * entry, because the failure that matters is the UI hiding something real.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { enumCandidates, parseCheckDoc, parseCheckList, parseModuleTable, type ParsedCheckDoc } from './tidy-rst-parser.ts';
import { loadTidyRuntime, release } from './tidy-binary.ts';
import {
    moduleOf,
    type TidyCatalog,
    type TidyCheckDescriptor,
    type TidyOptionDescriptor,
    type TidyOptionKind,
    type TidyTopLevelKey,
} from '../src/core/tidy/catalog.ts';
import type { TidyRuntime } from '../src/worker/tidy/runtime.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 'src/core/catalog/generated');
const catalogPath = (version: string): string => path.join(OUT_DIR, `tidy.${version}.json`);

/** A value no option accepts, so the binary's complaint reveals the option's type. */
const PROBE = '__probe__';

// ---------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------

interface Docs {
    index: string;
    list: string;
    pages: Map<string, string>;
    sha256: string;
}

async function loadDocs(version: string, localDir: string | null): Promise<Docs> {
    const base = `https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-${version}/clang-tools-extra/docs/clang-tidy`;
    const read = async (relative: string): Promise<string> => {
        if (localDir) return readFile(path.join(localDir, relative), 'utf8');
        const response = await fetch(`${base}/${relative}`);
        if (!response.ok) throw new Error(`fetching ${relative}: ${response.status} ${response.statusText}`);
        return response.text();
    };
    process.stdout.write(localDir ? `reading docs from ${localDir}\n` : `fetching docs from ${base}\n`);
    const index = await read('index.rst');
    const list = await read('checks/list.rst');
    const paths = [...new Set(parseCheckList(list).map((c) => c.docPath))].sort();

    const pages = new Map<string, string>();
    // Bounded concurrency: hundreds of small files, and raw.githubusercontent.com
    // is happier with a steady trickle than a burst.
    const queue = [...paths];
    await Promise.all(
        Array.from({ length: 16 }, async () => {
            for (let next = queue.shift(); next; next = queue.shift()) pages.set(next, await read(`checks/${next}.rst`));
        }),
    );
    const hash = createHash('sha256').update(index).update(list);
    for (const p of paths) hash.update(p).update(pages.get(p)!);
    process.stdout.write(`read ${pages.size} check pages\n`);
    return { index, list, pages, sha256: hash.digest('hex') };
}

// ---------------------------------------------------------------------------
// The binary
// ---------------------------------------------------------------------------

interface BinaryFacts {
    version: string;
    checks: string[];
    defaultChecks: string;
    /** `check.Option` → default, exactly as dumped. */
    defaults: Map<string, string>;
    topLevelKeys: TidyTopLevelKey[];
}

async function binaryFacts(runtime: TidyRuntime): Promise<BinaryFacts> {
    const version = await runtime.version();
    const checks = (await runtime.listChecks(JSON.stringify({ Checks: '*' }))).sort();
    const baseline = yaml.load(await runtime.dumpConfig('{}', 'probe.cpp')) as Record<string, unknown> & {
        Checks?: string;
    };
    const everything = yaml.load(await runtime.dumpConfig(JSON.stringify({ Checks: '*' }), 'probe.cpp')) as {
        CheckOptions?: Record<string, unknown>;
    };
    const defaults = new Map(Object.entries(everything.CheckOptions ?? {}).map(([k, v]) => [k, String(v)]));
    return {
        version,
        checks,
        defaultChecks: baseline.Checks ?? '',
        defaults,
        topLevelKeys: parseHelpKeys((await runtime.exec(['--help'])).output).map((key) => typeKey(key, baseline)),
    };
}

/**
 * Types a top-level key by the value the binary dumps for it. Keys it does not
 * dump (they have no default) are typed from their documentation instead.
 */
function typeKey(key: Omit<TidyTopLevelKey, 'kind' | 'default'>, dumped: Record<string, unknown>): TidyTopLevelKey {
    const value = dumped[key.name];
    if (typeof value === 'boolean') return { ...key, kind: 'bool', default: value };
    if (Array.isArray(value)) return { ...key, kind: 'list', default: value.map(String) };
    if (value !== undefined && typeof value !== 'object') return { ...key, kind: 'string', default: String(value) };
    const kind: TidyTopLevelKey['kind'] =
        key.name === 'CheckOptions' || key.name === 'CustomChecks'
            ? 'complex'
            : /\bIf this option is true\b|\bUse colors\b|Display the errors/i.test(key.doc)
              ? 'bool'
              : /\bargument/i.test(key.doc) && /Args(Before)?$/.test(key.name)
                ? 'list'
                : 'string';
    return { ...key, kind, default: null };
}

/**
 * Reads the "Configuration files" section of `--help`. Keys documented as "Same
 * as '--flag'" are resolved to that flag's own description from the same text,
 * so the UI can say what `HeaderFilterRegex` does rather than point at a flag.
 */
export function parseHelpKeys(help: string): Array<Omit<TidyTopLevelKey, 'kind' | 'default'>> {
    const lines = help.split('\n');
    const flagDocs = new Map<string, string>();
    for (let i = 0; i < lines.length; i++) {
        const flag = /^\s{2}--([\w-]+)(?:=<[^>]+>)?\s+-\s+(.*)$/.exec(lines[i]!);
        if (!flag) continue;
        const text = [flag[2]!];
        for (let j = i + 1; j < lines.length && /^\s{20,}\S/.test(lines[j]!); j++) text.push(lines[j]!.trim());
        flagDocs.set(flag[1]!, text.join(' ').replace(/\s+/g, ' '));
    }
    const start = lines.findIndex((l) => /following configuration options may be used/.test(l));
    const keys: Array<Omit<TidyTopLevelKey, 'kind' | 'default'>> = [];
    for (let i = start + 1; start >= 0 && i < lines.length; i++) {
        const line = lines[i]!;
        const key = /^\s{2,4}([A-Z]\w+)\s+-\s+(.*)$/.exec(line);
        if (key) keys.push({ name: key[1]!, doc: key[2]!.trim() });
        else if (keys.length > 0 && /^\s{20,}\S/.test(line)) keys[keys.length - 1]!.doc += ` ${line.trim()}`;
        else if (line.trim() !== '' && keys.length > 0) break;
    }
    if (keys.length === 0) throw new Error('--help: no configuration keys found; has the help text changed shape?');
    for (const key of keys) {
        const same = /^Same as '--([\w-]+)'\.?(.*)$/.exec(key.doc);
        if (same && flagDocs.has(same[1]!)) key.doc = `${flagDocs.get(same[1]!)}${same[2] ? ` ${same[2].trim()}` : ''}`;
    }
    return keys;
}

/**
 * Runs once over an empty file and returns the binary's complaint per option key,
 * or null if the run crashed outright (see `TidyOptionDescriptor.fragile`).
 */
async function complaints(
    runtime: TidyRuntime,
    options: ReadonlyMap<string, string>,
): Promise<Map<string, string> | null> {
    const config = JSON.stringify({ Checks: '*', CheckOptions: Object.fromEntries(options) });
    const { exitCode, output } = await runtime.exec(
        ['/work/probe.cpp', `--config=${config}`, '--quiet', '--', `--target=${release.analysisTriple}`],
        { 'probe.cpp': '' },
    );
    if (exitCode < 0) return null;
    const found = new Map<string, string>();
    for (const match of output.matchAll(/invalid configuration value '[^']*' for option '([^']+)'(;[^[]*)?\s*\[/g)) {
        found.set(match[1]!, (match[2] ?? '').trim());
    }
    return found;
}

/**
 * Finds the keys whose probe value crashes the binary, by bisection: one crashing
 * option takes down the whole run, so a failed batch is split until the culprits
 * are isolated. Costs a handful of extra runs, and only when something crashes.
 */
async function findCrashers(runtime: TidyRuntime, keys: readonly string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    if ((await complaints(runtime, new Map(keys.map((k) => [k, PROBE])))) !== null) return [];
    if (keys.length === 1) return [...keys];
    const middle = Math.ceil(keys.length / 2);
    return [
        ...(await findCrashers(runtime, keys.slice(0, middle))),
        ...(await findCrashers(runtime, keys.slice(middle))),
    ];
}

interface ProbedKinds {
    kinds: Map<string, TidyOptionKind>;
    fragile: Set<string>;
}

/** Classifies every option key by the binary's reaction to a value nothing accepts. */
async function probeKinds(runtime: TidyRuntime, keys: readonly string[]): Promise<ProbedKinds> {
    const fragile = new Set(await findCrashers(runtime, keys));
    const safe = keys.filter((k) => !fragile.has(k));
    const reactions = await complaints(runtime, new Map(safe.map((k) => [k, PROBE])));
    if (!reactions) throw new Error('the option probe crashed even after removing the options that crash it');
    const kinds = new Map<string, TidyOptionKind>();
    for (const key of safe) {
        const reaction = reactions.get(key);
        if (reaction === undefined) continue; // accepted: free text, refined later
        kinds.set(key, /bool/.test(reaction) ? 'bool' : /integer/.test(reaction) ? 'integer' : 'enum');
    }
    return { kinds, fragile };
}

/**
 * Keeps the candidate values the binary accepts. Batched across options: run `k`
 * tries every enum option's `k`-th candidate at once, since each option's
 * complaint names the option. That is ~a dozen runs instead of ~a thousand.
 */
async function probeEnumValues(
    runtime: TidyRuntime,
    candidates: ReadonlyMap<string, string[]>,
): Promise<Map<string, string[]>> {
    const accepted = new Map<string, string[]>([...candidates.keys()].map((k) => [k, []]));
    const rounds = Math.max(0, ...[...candidates.values()].map((c) => c.length));
    for (let round = 0; round < rounds; round++) {
        const trial = new Map<string, string>();
        for (const [key, values] of candidates) if (values[round] !== undefined) trial.set(key, values[round]!);
        const rejected = await complaints(runtime, trial);
        if (!rejected) throw new Error(`enum probe round ${round} crashed the binary`);
        for (const [key, value] of trial) if (!rejected.has(key)) accepted.get(key)!.push(value);
    }
    return accepted;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function refineFreeText(name: string, doc: string, dumped: string | null): TidyOptionKind {
    if (/^-?\d*\.\d+$/.test(dumped ?? '')) return 'number';
    if (/(Regex|RegExp|Regexp|RegularExpression)$/.test(name) || /regular expression/i.test(doc)) return 'regex';
    if ((dumped ?? '').includes(';') || /semicolon[- ]separated|separated by semicolons/i.test(doc)) return 'list';
    return 'string';
}

function tidyExamples(examples: ParsedCheckDoc['examples']): ParsedCheckDoc['examples'] {
    return examples.map((e) => ({ language: e.language, code: e.code.replace(/^\n+/, '') }));
}

/** Option text minus the orphaned "Before:" / "After:" labels left behind by extracted examples. */
function tidyOptionDoc(doc: string): string {
    return doc
        .split('\n')
        .filter((line) => !/^(Before|After)\s*:?$/i.test(line.trim()))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function generate(version: string, docsDir: string | null): Promise<void> {
    const docs = await loadDocs(version, docsDir);
    const listed = parseCheckList(docs.list);
    const listedByName = new Map(listed.map((c) => [c.name, c]));
    const parsedPages = new Map([...docs.pages].map(([p, text]) => [p, parseCheckDoc(text)]));

    const runtime = await loadTidyRuntime({ verify: true });
    const facts = await binaryFacts(runtime);
    if (facts.version !== version) {
        throw new Error(`Binary/catalog mismatch: asked for ${version}, the vendored clang-tidy is ${facts.version}.`);
    }
    process.stdout.write(`binary: ${facts.checks.length} checks, ${facts.defaults.size} dumped options\n`);

    const pageFor = (check: string): ParsedCheckDoc | null => {
        const entry = listedByName.get(check);
        return entry ? (parsedPages.get(entry.docPath) ?? null) : null;
    };
    const aliasTarget = (check: string): string | null =>
        listedByName.get(check)?.aliasOf ?? pageFor(check)?.aliasOf ?? null;

    // Every option key worth describing: what the docs name, plus what the binary
    // dumps. An alias documents nothing of its own; it takes its target's options
    // under its own name, which is how clang-tidy reads them.
    const optionDocs = new Map<string, { doc: string; examples: ParsedCheckDoc['examples'] }>();
    for (const check of facts.checks) {
        const target = aliasTarget(check);
        const page = pageFor(target ?? check) ?? pageFor(check);
        for (const option of page?.options ?? []) {
            optionDocs.set(`${check}.${option.name}`, { doc: option.doc, examples: option.examples });
        }
    }
    const allKeys = [...new Set([...optionDocs.keys(), ...facts.defaults.keys()])].sort();

    process.stdout.write(`probing ${allKeys.length} option keys...\n`);
    const { kinds, fragile } = await probeKinds(runtime, allKeys);
    const enumKeys = allKeys.filter((k) => kinds.get(k) === 'enum');
    // Candidates come from wherever the docs might mention a value: the option's
    // own text, the rest of its check's page (identifier-naming lists its casing
    // styles once, in the introduction), and the text of every same-named option
    // in other checks (not every `IncludeStyle` page mentions `google`). Being
    // generous here is free of risk — the binary rejects anything that is not a
    // real value — and costs only probe rounds.
    const optionNameOf = (key: string): string => key.slice(key.lastIndexOf('.') + 1);
    const checkOf = (key: string): string => key.slice(0, key.lastIndexOf('.'));
    const pageWords = (check: string): string[] => {
        const page = pageFor(aliasTarget(check) ?? check) ?? pageFor(check);
        return page ? enumCandidates([page.summary, page.doc, ...page.options.map((o) => o.doc)].join('\n')) : [];
    };
    const sameNamedWords = new Map<string, Set<string>>();
    for (const key of enumKeys) {
        const words = sameNamedWords.get(optionNameOf(key)) ?? new Set<string>();
        for (const w of enumCandidates(optionDocs.get(key)?.doc ?? '')) words.add(w);
        sameNamedWords.set(optionNameOf(key), words);
    }
    const candidates = new Map(
        enumKeys.map((k) => {
            const dumped = facts.defaults.get(k);
            const pool = [
                ...(dumped !== undefined ? [dumped] : []),
                ...enumCandidates(optionDocs.get(k)?.doc ?? ''),
                ...(sameNamedWords.get(optionNameOf(k)) ?? []),
                ...pageWords(checkOf(k)),
            ];
            return [k, [...new Set(pool)]];
        }),
    );
    process.stdout.write(`confirming values for ${enumKeys.length} enum options...\n`);
    const enumValues = await probeEnumValues(runtime, candidates);

    const binaryChecks = new Set(facts.checks);
    const checks: TidyCheckDescriptor[] = facts.checks.map((name) => {
        const entry = listedByName.get(name);
        const aliasOf = aliasTarget(name);
        const own = pageFor(name);
        const target = aliasOf ? pageFor(aliasOf) : null;
        // An alias page is a one-line redirect; its target's page is the useful one.
        const page = aliasOf && target ? target : own;

        const keys = allKeys.filter((k) => k.startsWith(`${name}.`) && !k.slice(name.length + 1).includes('.'));
        const options: TidyOptionDescriptor[] = keys.map((key) => {
            const optionName = key.slice(name.length + 1);
            const documented = optionDocs.get(key);
            const dumped = facts.defaults.get(key) ?? null;
            const doc = tidyOptionDoc(documented?.doc ?? '');
            const probed = kinds.get(key);
            const kind: TidyOptionKind = probed ?? refineFreeText(optionName, doc, dumped);
            const values = kind === 'enum' ? (enumValues.get(key) ?? []) : [];
            return {
                name: optionName,
                kind,
                default: dumped,
                values,
                doc,
                examples: tidyExamples(documented?.examples ?? []),
                ...(fragile.has(key) ? { fragile: true } : {}),
            };
        });

        return {
            name,
            module: moduleOf(name),
            summary: (aliasOf && target ? target.summary : own?.summary) ?? '',
            doc: page?.doc ?? '',
            examples: tidyExamples(page?.examples ?? []),
            offersFixes: entry?.offersFixes ?? (aliasOf ? (listedByName.get(aliasOf)?.offersFixes ?? false) : false),
            aliasOf: aliasOf && binaryChecks.has(aliasOf) ? aliasOf : null,
            options,
            docPath: entry?.docPath ?? null,
        };
    });

    const undocumented = checks.filter((c) => !c.docPath).map((c) => c.name);
    const missingFromBinary = listed.map((c) => c.name).filter((n) => !binaryChecks.has(n));
    const enumsWithoutValues = enumKeys.filter((k) => (enumValues.get(k) ?? []).length === 0);

    const catalog: TidyCatalog = {
        clangTidyVersion: version,
        sourceTag: `llvmorg-${version}`,
        docsSha256: docs.sha256,
        generatedAt: new Date().toISOString(),
        defaultChecks: facts.defaultChecks,
        topLevelKeys: facts.topLevelKeys,
        modules: parseModuleTable(docs.index),
        checks,
    };
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(catalogPath(version), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

    const histogram: Record<string, number> = {};
    for (const c of checks) for (const o of c.options) histogram[o.kind] = (histogram[o.kind] ?? 0) + 1;
    const stats = {
        checks: checks.length,
        aliases: checks.filter((c) => c.aliasOf).length,
        offersFixes: checks.filter((c) => c.offersFixes).length,
        options: checks.reduce((n, c) => n + c.options.length, 0),
        optionKinds: histogram,
        undocumentedChecks: undocumented.length,
        documentedButNotInBinary: missingFromBinary,
        enumsWithoutConfirmedValues: enumsWithoutValues,
        crashOnInvalidValue: [...fragile],
    };
    process.stdout.write(`wrote ${path.relative(ROOT, catalogPath(version))}\n${JSON.stringify(stats, null, 2)}\n`);
}

/**
 * Offline: the committed catalog must describe the vendored binary. Checks and
 * option defaults are compared exactly, because either drifting means the UI
 * would show a check that does not exist or a default that is not the default.
 */
async function check(version: string): Promise<void> {
    const file = catalogPath(version);
    if (!existsSync(file)) throw new Error(`No committed tidy catalog at ${file}. Run: npm run tidy-catalog:generate`);
    const catalog = JSON.parse(await readFile(file, 'utf8')) as TidyCatalog;
    const runtime = await loadTidyRuntime({ verify: true });
    const facts = await binaryFacts(runtime);

    const problems: string[] = [];
    if (facts.version !== catalog.clangTidyVersion) {
        problems.push(`catalog is for ${catalog.clangTidyVersion}, the vendored binary is ${facts.version}`);
    }
    const listedNow = facts.checks.join('|');
    const listedThen = catalog.checks.map((c) => c.name).join('|');
    if (listedNow !== listedThen) problems.push('the set of checks differs from the binary');
    const dumpedThen = new Map<string, string>(
        catalog.checks.flatMap((c) =>
            c.options.filter((o) => o.default !== null).map((o): [string, string] => [`${c.name}.${o.name}`, o.default!]),
        ),
    );
    for (const [key, value] of facts.defaults) {
        if (dumpedThen.get(key) !== value) problems.push(`option ${key}: binary default '${value}', catalog '${dumpedThen.get(key)}'`);
    }
    if (facts.defaultChecks !== catalog.defaultChecks) problems.push(`default checks changed to '${facts.defaultChecks}'`);
    if (problems.length > 0) {
        throw new Error(`Tidy catalog is out of date. Run: npm run tidy-catalog:generate\n  ${problems.slice(0, 20).join('\n  ')}`);
    }
    process.stdout.write(`tidy catalog ok: ${catalog.checks.length} checks for clang-tidy ${catalog.clangTidyVersion}\n`);
}

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
    const at = args.indexOf(name);
    return at >= 0 ? (args[at + 1] ?? null) : null;
};
const version = flag('--version') ?? release.llvmVersion;
const run = args.includes('--check') ? check(version) : generate(version, flag('--docs'));
run.catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
