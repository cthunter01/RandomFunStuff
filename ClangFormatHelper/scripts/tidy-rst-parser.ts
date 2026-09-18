/**
 * Parses clang-tidy's documentation into the pieces the check catalog needs.
 *
 * Unlike clang-format's single generated options file, clang-tidy's docs are ~570
 * hand-written pages, one per check. They are regular enough to parse — a title,
 * prose, then one `.. option::` block per option — but only mostly, so this
 * parser extracts what the docs *say*, and the generator leaves every question of
 * what *exists* to the binary.
 *
 * Pure: no network, no filesystem.
 */

import type { CodeExample } from '../src/core/catalog/types.ts';
import type { TidyModuleDescriptor } from '../src/core/tidy/catalog.ts';
import { dedent, extractCodeBlocks } from './rst-parser.ts';

export interface ListedCheck {
    name: string;
    /** Page path relative to `docs/clang-tidy/checks/`, without `.rst`. */
    docPath: string;
    offersFixes: boolean;
    /** Set for rows of the alias table that redirect to another check. */
    aliasOf: string | null;
}

/** `:doc:`label <path>`` — the label is the check name, the path its page. */
const DOC_ROLE = /:doc:`([^`<]+?)\s*<([^>]+)>`/g;

/**
 * Reads both tables in `checks/list.rst`: the checks, and the aliases. Alias rows
 * for the static analyzer redirect to an external page rather than to another
 * check, so they come back with `aliasOf: null`.
 */
export function parseCheckList(rst: string): ListedCheck[] {
    const out: ListedCheck[] = [];
    for (const line of rst.split('\n')) {
        if (!/^\s+:doc:`/.test(line)) continue;
        const docs = [...line.matchAll(DOC_ROLE)];
        const first = docs[0];
        if (!first) continue;
        out.push({
            name: first[1]!.trim(),
            docPath: first[2]!.trim(),
            offersFixes: /"Yes"\s*$/.test(line),
            aliasOf: docs[1] ? docs[1][1]!.trim() : null,
        });
    }
    return out;
}

/** Reads the "Name prefix / Description" table from `index.rst`. */
export function parseModuleTable(rst: string): TidyModuleDescriptor[] {
    const lines = rst.split('\n');
    const header = lines.findIndex((l) => /^Name prefix\s+Description/.test(l));
    if (header < 0) throw new Error('index.rst: module table not found');
    const modules: TidyModuleDescriptor[] = [];
    for (let i = header + 2; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^=+\s+=+/.test(line)) break;
        const row = /^``([\w-]+)-``\s+(.*)$/.exec(line);
        if (row) modules.push({ name: row[1]!, description: row[2]!.trim() });
        else if (line.trim() && modules.length > 0) modules[modules.length - 1]!.description += ` ${line.trim()}`;
    }
    return modules;
}

/**
 * Strips reStructuredText inline markup down to readable text. Code stays in
 * single backticks, which the UI renders as code; links keep their label.
 */
export function cleanInline(text: string): string {
    return text
        .replace(/:doc:`([^`<]+?)\s*<[^>]+>`/g, '$1')
        .replace(/:doc:`([^`]+)`/g, '$1')
        .replace(/:ref:`([^`<]+?)\s*<[^>]+>`/g, '$1')
        .replace(/:(?:option|program|envvar|ref|code|file|samp|abbr|term):`([^`]+)`/g, '`$1`')
        .replace(/`([^`<]+?)\s*<[^>]+>`__?/g, '$1')
        .replace(/``([^`]+)``/g, '`$1`')
        // Emphasis: **strong** and *em*. The `*` must hug a word on both sides, so
        // globs like `bugprone-*` and a lone `*` in prose are left alone.
        .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
        .replace(/(^|[\s("'])\*([A-Za-z][^*\n]*?[A-Za-z.])\*(?=[\s.,;:!?)"']|$)/gm, '$1$2');
}

/**
 * Joins hard-wrapped paragraph lines, keeping paragraph breaks and list items on
 * their own lines. The UI shows docs with `pre-wrap`, so wrapped source lines
 * would otherwise render as a ragged column.
 */
function reflow(lines: string[]): string {
    const out: string[] = [];
    let paragraph = '';
    const flush = (): void => {
        if (paragraph) out.push(paragraph);
        paragraph = '';
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (line.trim() === '') {
            flush();
            if (out.length > 0 && out[out.length - 1] !== '') out.push('');
            continue;
        }
        const trimmed = line.trim();
        if (/^([-*+]|\d+\.|#\.)\s/.test(trimmed)) {
            flush();
            paragraph = trimmed;
        } else {
            paragraph = paragraph ? `${paragraph} ${trimmed}` : trimmed;
        }
    }
    flush();
    while (out[out.length - 1] === '') out.pop();
    return cleanInline(out.join('\n'));
}

export interface ParsedOptionDoc {
    name: string;
    doc: string;
    examples: CodeExample[];
}

export interface ParsedCheckDoc {
    summary: string;
    doc: string;
    examples: CodeExample[];
    options: ParsedOptionDoc[];
    /** The check an alias page redirects to, from its "is an alias" sentence. */
    aliasOf: string | null;
}

const HEADING_UNDERLINE = /^([=\-~^"'`#*+])\1{2,}\s*$/;

/** Drops a directive and its indented body (`.. title::`, `.. meta::`). */
function dropDirective(lines: string[], name: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.startsWith(`.. ${name}::`)) {
            while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) i++;
            continue;
        }
        out.push(lines[i]!);
    }
    return out;
}

/**
 * Parses one check's page.
 *
 * Structure: a title heading, prose and examples, then usually an "Options"
 * section of `.. option:: Name` blocks. An option owns its indented body *and*
 * any unindented material that follows it up to the next option or heading —
 * the docs routinely put an option's before/after examples there.
 */
export function parseCheckDoc(rst: string): ParsedCheckDoc {
    let lines = rst.replace(/\r\n/g, '\n').split('\n');
    lines = dropDirective(dropDirective(lines, 'title'), 'meta');

    // Skip past the title heading: the first line underlined with `=`.
    const titleAt = lines.findIndex((l, i) => i > 0 && /^=+\s*$/.test(l) && lines[i - 1]!.trim() !== '');
    let body = titleAt >= 0 ? lines.slice(titleAt + 1) : lines;
    // An overlined title repeats the underline after the text.
    if (body[0] !== undefined && /^=+\s*$/.test(body[0])) body = body.slice(1);

    const prose: string[] = [];
    const options: Array<{ name: string; lines: string[] }> = [];
    let current: { name: string; lines: string[] } | null = null;
    let inOptionsSection = false;

    for (let i = 0; i < body.length; i++) {
        const line = body[i]!;
        const next = body[i + 1] ?? '';
        if (line.trim() !== '' && HEADING_UNDERLINE.test(next) && next.trim().length >= line.trim().length - 1) {
            // A heading ends whatever option was collecting trailing material.
            inOptionsSection = /^options?$/i.test(line.trim()) || /options$/i.test(line.trim());
            current = null;
            if (!inOptionsSection) prose.push('', line.trim(), '');
            i++;
            continue;
        }
        const option = /^\.\. option::\s*(.+?)\s*$/.exec(line);
        if (option) {
            current = { name: option[1]!, lines: [] };
            options.push(current);
            continue;
        }
        if (current) current.lines.push(line);
        else prose.push(line);
    }

    const { examples, prose: text } = extractCodeBlocks(prose);
    const paragraphs = reflow(text);
    const [summary = '', ...rest] = paragraphs.split(/\n\n/);
    const aliasMatch = /is an alias,? please see\s+:doc:`([^`<]+?)\s*</.exec(rst.replace(/\s+/g, ' '));

    return {
        summary: summary.trim(),
        doc: rest.join('\n\n').trim(),
        examples,
        options: options.flatMap((o) => {
            const parsed = extractCodeBlocks(o.lines);
            const doc = reflow(dedent(parsed.prose).split('\n'));
            // `.. option:: A, B` documents two options with one text.
            return o.name.split(/\s*,\s*/).map((name) => ({ name, doc, examples: parsed.examples }));
        }),
        aliasOf: aliasMatch ? aliasMatch[1]!.trim() : null,
    };
}

/**
 * Candidate values for an enum-like option, as the docs mention them: every
 * backticked word in its text. Deliberately over-inclusive — the generator keeps
 * only the ones the binary accepts, so a false candidate costs one probe and
 * never reaches the catalog.
 */
export function enumCandidates(doc: string): string[] {
    const found = new Set<string>();
    for (const match of doc.matchAll(/`([A-Za-z_][\w.:+-]*)`/g)) found.add(match[1]!);
    return [...found];
}
