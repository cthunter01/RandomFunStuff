/**
 * Renders highlighted code as plain markup.
 *
 * One component for every read-only code surface in the app — the formatted
 * output, the diff, the documentation examples and the per-option previews — so
 * they cannot drift apart visually.
 */

import { memo } from 'react';
import { highlightLines, type HighlightedLine } from '../highlight/highlight.ts';
import { useGrammar } from '../highlight/useGrammar.ts';

export const CodeLine = memo(function CodeLine({ line }: { line: HighlightedLine | undefined }): React.JSX.Element {
    if (!line || line.length === 0) return <>{' '}</>;
    return (
        <>
            {line.map((token, i) =>
                token.cls ? (
                    <span key={i} className={token.cls}>
                        {token.text}
                    </span>
                ) : (
                    <span key={i}>{token.text}</span>
                ),
            )}
        </>
    );
});

/** Per-line decoration: 0-based line index → a class added to that line, e.g. `mark-warning`. */
export type LineMarks = ReadonlyMap<number, string>;

export const Code = memo(function Code({
    code,
    language,
    className = '',
    marks,
}: {
    code: string;
    language: string;
    className?: string;
    /** Must be memoised by the caller, or every render repaints every line. */
    marks?: LineMarks;
}): React.JSX.Element {
    // Repaints once the grammar lands; until then the same code renders unstyled.
    useGrammar(language);
    const lines = highlightLines(code, language);
    return (
        <pre className={`code ${className}`}>
            {lines.map((line, i) => (
                <div key={i} className={marks?.has(i) ? `code-line ${marks.get(i)}` : 'code-line'}>
                    <CodeLine line={line} />
                </div>
            ))}
        </pre>
    );
});
