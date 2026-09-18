/**
 * Reads clang-tidy's `--export-fixes` YAML into structured diagnostics.
 *
 * The export is used rather than the human-readable output because it is
 * structured by construction: every diagnostic carries its check name, level,
 * position and fix-it replacements, with no message text to pattern-match. It
 * includes diagnostics that have no fix, too — the name is misleading.
 *
 * clang expresses positions as UTF-8 byte offsets. Everything this module returns
 * is converted to JavaScript string indices, so a replacement can be applied to
 * the sample with a plain `slice` — which is what the fix previews do.
 */

import yaml from 'js-yaml';
import type { TidyDiagnostic, TidyLevel, TidyNote, TidyReplacement, TidySpan } from './port.ts';

interface RawReplacement {
    FilePath?: string;
    Offset?: number;
    Length?: number;
    ReplacementText?: string;
}

interface RawMessage {
    Message?: string;
    FilePath?: string;
    FileOffset?: number;
    Replacements?: RawReplacement[];
    Ranges?: Array<{ FilePath?: string; FileOffset?: number; Length?: number }>;
}

interface RawDiagnostic {
    DiagnosticName?: string;
    DiagnosticMessage?: RawMessage;
    Notes?: RawMessage[];
    Level?: string;
}

/** Maps UTF-8 byte offsets in `text` to string indices and line/column positions. */
export class SourceMap {
    /** `byteAt[i]` is the byte offset of string index `i`; absent when the text is ASCII. */
    private readonly byteAt: number[] | null;
    /** String index at which each line starts. */
    private readonly lineStarts: number[];

    constructor(private readonly text: string) {
        const ascii = /^[\x00-\x7f]*$/.test(text);
        if (ascii) {
            this.byteAt = null;
        } else {
            const byteAt: number[] = [];
            let bytes = 0;
            for (let i = 0; i < text.length; i++) {
                byteAt.push(bytes);
                const code = text.charCodeAt(i);
                if (code < 0x80) bytes += 1;
                else if (code < 0x800) bytes += 2;
                // A surrogate pair is one 4-byte code point spread over two indices.
                else if (code >= 0xd800 && code <= 0xdbff) bytes += 4;
                else if (code >= 0xdc00 && code <= 0xdfff) bytes += 0;
                else bytes += 3;
            }
            byteAt.push(bytes);
            this.byteAt = byteAt;
        }
        this.lineStarts = [0];
        for (let i = 0; i < text.length; i++) if (text[i] === '\n') this.lineStarts.push(i + 1);
    }

    /** String index for a byte offset, clamped to the text. */
    indexOf(byteOffset: number): number {
        if (!this.byteAt) return Math.min(Math.max(byteOffset, 0), this.text.length);
        let lo = 0;
        let hi = this.byteAt.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.byteAt[mid]! <= byteOffset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /** 1-based line and column of a string index. */
    position(index: number): { line: number; column: number } {
        let lo = 0;
        let hi = this.lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.lineStarts[mid]! <= index) lo = mid;
            else hi = mid - 1;
        }
        return { line: lo + 1, column: index - this.lineStarts[lo]! + 1 };
    }

    /** A span from a byte offset and byte length. */
    span(byteOffset: number, byteLength: number): TidySpan {
        const start = this.indexOf(byteOffset);
        const end = this.indexOf(byteOffset + byteLength);
        return { ...this.position(start), offset: start, length: end - start };
    }
}

function levelOf(raw: string | undefined): TidyLevel {
    const level = (raw ?? '').toLowerCase();
    return level === 'error' ? 'error' : level === 'remark' ? 'remark' : 'warning';
}

/**
 * Parses the export. `mainFile` is the path the analysed file was given, so
 * positions and replacements that point into headers can be told apart and
 * dropped — the UI has only the one file to show them in.
 */
export function parseExportedFixes(text: string, code: string, mainFile: string): TidyDiagnostic[] {
    const parsed = (yaml.load(text) ?? {}) as { Diagnostics?: RawDiagnostic[] };
    const map = new SourceMap(code);
    const inMain = (path: string | undefined): boolean => path === mainFile;

    const spanOf = (message: RawMessage): TidySpan | null => {
        if (!inMain(message.FilePath) || typeof message.FileOffset !== 'number') return null;
        // Prefer the highlighted range when there is one; a bare offset is a caret.
        const range = message.Ranges?.find((r) => inMain(r.FilePath) && r.FileOffset === message.FileOffset);
        return map.span(message.FileOffset, range?.Length ?? 0);
    };

    const replacementsOf = (message: RawMessage): TidyReplacement[] =>
        (message.Replacements ?? [])
            .filter((r) => inMain(r.FilePath) && typeof r.Offset === 'number')
            .map((r) => {
                const start = map.indexOf(r.Offset!);
                const end = map.indexOf(r.Offset! + (r.Length ?? 0));
                return { offset: start, length: end - start, text: r.ReplacementText ?? '' };
            });

    return (parsed.Diagnostics ?? []).map((raw): TidyDiagnostic => {
        const message = raw.DiagnosticMessage ?? {};
        const notes: TidyNote[] = (raw.Notes ?? []).map((note) => ({
            message: note.Message ?? '',
            span: spanOf(note),
        }));
        return {
            check: raw.DiagnosticName ?? 'unknown',
            level: levelOf(raw.Level),
            message: message.Message ?? '',
            span: spanOf(message),
            replacements: replacementsOf(message),
            notes,
        };
    });
}

/**
 * Applies replacements to `code`. Overlapping edits are skipped rather than
 * merged — clang-tidy's own `--fix` does the same and reports a conflict — and
 * the count of skipped ones is returned so a preview can say it is partial.
 */
export function applyReplacements(
    code: string,
    replacements: readonly TidyReplacement[],
): { text: string; skipped: number } {
    // The same edit can be reported more than once (a template instantiated twice,
    // an alias enabled alongside its target); apply it once.
    const unique = new Map(replacements.map((r) => [`${r.offset}:${r.length}:${r.text}`, r]));
    const ordered = [...unique.values()].sort((a, b) => a.offset - b.offset || a.length - b.length);
    let out = '';
    let cursor = 0;
    let skipped = 0;
    for (const r of ordered) {
        if (r.offset < cursor) {
            skipped++;
            continue;
        }
        out += code.slice(cursor, r.offset) + r.text;
        cursor = r.offset + r.length;
    }
    return { text: out + code.slice(cursor), skipped };
}
