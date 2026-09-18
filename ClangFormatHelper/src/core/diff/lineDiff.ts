/**
 * Line comparison for the impact sweep and the previews it feeds.
 *
 * Two functions with very different cost profiles, on purpose. `changedLineCount`
 * runs once per candidate value — several hundred times per sweep — so it is
 * linear and allocation-light. `firstHunk` runs once per option, only for the
 * candidate that actually won, so it can afford to be precise.
 */

export interface Hunk {
    /** 0-based line index in the original where the hunk starts. */
    start: number;
    before: string[];
    after: string[];
}

interface Trimmed {
    prefix: number;
    beforeRest: string[];
    afterRest: string[];
}

/** Strips the identical head and tail, which is nearly all of a typical diff. */
function trimCommon(before: readonly string[], after: readonly string[]): Trimmed {
    let prefix = 0;
    const limit = Math.min(before.length, after.length);
    while (prefix < limit && before[prefix] === after[prefix]) prefix++;

    let suffix = 0;
    while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
        suffix++;
    }
    return {
        prefix,
        beforeRest: before.slice(prefix, before.length - suffix),
        afterRest: after.slice(prefix, after.length - suffix),
    };
}

/**
 * How many lines differ. Not a true edit distance — it is the size of the region
 * that is not shared head or tail — which is all a magnitude badge needs and is
 * cheap enough to run for every candidate in a sweep.
 */
export function changedLineCount(before: string, after: string): number {
    if (before === after) return 0;
    const { beforeRest, afterRest } = trimCommon(before.split('\n'), after.split('\n'));
    return Math.max(beforeRest.length, afterRest.length);
}

/**
 * The first differing region, with a little context. This is what a per-option
 * micro-preview shows, so it is deliberately small.
 */
export function firstHunk(before: string, after: string, context = 1, maxLines = 8): Hunk | null {
    if (before === after) return null;
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    const { prefix, beforeRest, afterRest } = trimCommon(beforeLines, afterLines);

    const start = Math.max(0, prefix - context);
    const take = (lines: string[], rest: string[]): string[] =>
        [...lines.slice(start, prefix), ...rest].slice(0, maxLines);

    return { start, before: take(beforeLines, beforeRest), after: take(afterLines, afterRest) };
}

/** One row of a side-by-side diff. */
export interface DiffRow {
    kind: 'same' | 'added' | 'removed' | 'changed';
    beforeLine: number | null;
    afterLine: number | null;
    before: string | null;
    after: string | null;
}

/**
 * A full side-by-side diff, for the diff panel.
 *
 * Unlike `changedLineCount` this is a real longest-common-subsequence diff, so it
 * survives insertions and deletions rather than just reporting a region size. It
 * runs once per render rather than once per sweep candidate, so the quadratic
 * table is affordable — but the common head and tail are still trimmed first,
 * which keeps it linear for the usual "one option changed" case.
 */
export function diffLines(beforeText: string, afterText: string): DiffRow[] {
    const before = beforeText.split('\n');
    const after = afterText.split('\n');
    const { prefix, beforeRest, afterRest } = trimCommon(before, after);
    const suffixStart = { before: prefix + beforeRest.length, after: prefix + afterRest.length };

    const rows: DiffRow[] = [];
    for (let i = 0; i < prefix; i++) {
        rows.push({ kind: 'same', beforeLine: i + 1, afterLine: i + 1, before: before[i]!, after: after[i]! });
    }

    // Guard against the pathological case; a preview does not need to be exact.
    const MAX = 1200;
    if (beforeRest.length > MAX || afterRest.length > MAX) {
        const n = Math.max(beforeRest.length, afterRest.length);
        for (let i = 0; i < n; i++) {
            rows.push({
                kind: 'changed',
                beforeLine: i < beforeRest.length ? prefix + i + 1 : null,
                afterLine: i < afterRest.length ? prefix + i + 1 : null,
                before: beforeRest[i] ?? null,
                after: afterRest[i] ?? null,
            });
        }
    } else {
        for (const row of pairForSideBySide(lcsRows(beforeRest, afterRest, prefix))) rows.push(row);
    }

    for (let i = 0; i < before.length - suffixStart.before; i++) {
        const b = suffixStart.before + i;
        const a = suffixStart.after + i;
        rows.push({ kind: 'same', beforeLine: b + 1, afterLine: a + 1, before: before[b]!, after: after[a]! });
    }
    return rows;
}

/**
 * Pairs each run of removals with the following run of additions.
 *
 * An LCS diff naturally emits "these lines went" then "these lines came", which
 * is right for a patch but reads badly side by side: every changed line leaves a
 * blank gap opposite it and the two columns drift apart. Zipping the runs back
 * together puts the old and new version of a line on the same row, which is what
 * a side-by-side view is for.
 */
function pairForSideBySide(rows: DiffRow[]): DiffRow[] {
    const out: DiffRow[] = [];
    for (let i = 0; i < rows.length; ) {
        if (rows[i]!.kind !== 'removed') {
            out.push(rows[i]!);
            i++;
            continue;
        }
        let removedEnd = i;
        while (removedEnd < rows.length && rows[removedEnd]!.kind === 'removed') removedEnd++;
        let addedEnd = removedEnd;
        while (addedEnd < rows.length && rows[addedEnd]!.kind === 'added') addedEnd++;

        const removed = rows.slice(i, removedEnd);
        const added = rows.slice(removedEnd, addedEnd);
        for (let k = 0; k < Math.max(removed.length, added.length); k++) {
            const before = removed[k];
            const after = added[k];
            if (before && after) {
                out.push({
                    kind: 'changed',
                    beforeLine: before.beforeLine,
                    afterLine: after.afterLine,
                    before: before.before,
                    after: after.after,
                });
            } else if (before) out.push(before);
            else if (after) out.push(after);
        }
        i = addedEnd;
    }
    return out;
}

function lcsRows(before: string[], after: string[], offset: number): DiffRow[] {
    const n = before.length;
    const m = after.length;
    // table[i][j] = LCS length of before[i..] and after[j..]
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
        }
    }

    const rows: DiffRow[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (before[i] === after[j]) {
            rows.push({ kind: 'same', beforeLine: offset + i + 1, afterLine: offset + j + 1, before: before[i]!, after: after[j]! });
            i++;
            j++;
        } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
            rows.push({ kind: 'removed', beforeLine: offset + i + 1, afterLine: null, before: before[i]!, after: null });
            i++;
        } else {
            rows.push({ kind: 'added', beforeLine: null, afterLine: offset + j + 1, before: null, after: after[j]! });
            j++;
        }
    }
    while (i < n) {
        rows.push({ kind: 'removed', beforeLine: offset + i + 1, afterLine: null, before: before[i]!, after: null });
        i++;
    }
    while (j < m) {
        rows.push({ kind: 'added', beforeLine: null, afterLine: offset + j + 1, before: null, after: after[j]! });
        j++;
    }
    return rows;
}
