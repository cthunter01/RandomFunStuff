import { describe, expect, it } from 'vitest';
import { changedLineCount, diffLines, firstHunk } from '../../../src/core/diff/lineDiff.ts';

describe('line diff', () => {
    it('reports nothing for identical text', () => {
        expect(changedLineCount('a\nb\n', 'a\nb\n')).toBe(0);
        expect(firstHunk('a\nb\n', 'a\nb\n')).toBeNull();
        expect(diffLines('a\nb\n', 'a\nb\n').every((r) => r.kind === 'same')).toBe(true);
    });

    it('counts only the region that actually differs', () => {
        expect(changedLineCount('a\nb\nc\n', 'a\nB\nc\n')).toBe(1);
        expect(changedLineCount('a\nb\nc\n', 'a\nX\nY\nc\n')).toBe(2);
    });

    it('pairs a removal with its replacement on one row', () => {
        // Side by side, an edited line should read as one row, not as a removal
        // followed by an unrelated-looking addition further down.
        const rows = diffLines('a\nb\nc\n', 'a\nB\nc\n').filter((r) => r.kind !== 'same');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'changed', before: 'b', after: 'B' });
    });

    it('still represents pure insertions and deletions', () => {
        const inserted = diffLines('a\nc\n', 'a\nb\nc\n').filter((r) => r.kind !== 'same');
        expect(inserted).toEqual([expect.objectContaining({ kind: 'added', after: 'b' })]);

        const deleted = diffLines('a\nb\nc\n', 'a\nc\n').filter((r) => r.kind !== 'same');
        expect(deleted).toEqual([expect.objectContaining({ kind: 'removed', before: 'b' })]);
    });

    it('pairs what it can and leaves the remainder unpaired', () => {
        const rows = diffLines('a\nb\nc\n', 'a\nX\nY\nc\n').filter((r) => r.kind !== 'same');
        expect(rows.map((r) => [r.kind, r.before, r.after])).toEqual([
            ['changed', 'b', 'X'],
            ['added', null, 'Y'],
        ]);
    });

    it('gives a small hunk for an option preview', () => {
        const hunk = firstHunk('int *a;\nint b;\n', 'int* a;\nint b;\n');
        expect(hunk?.before.join('\n')).toContain('int *a;');
        expect(hunk?.after.join('\n')).toContain('int* a;');
    });
});
