/**
 * An editable code area with syntax highlighting.
 *
 * A transparent `<textarea>` sits on top of a highlighted `<pre>` that renders
 * the same text. Keeping the real textarea means native editing survives intact —
 * selection, native undo, IME, spellcheck settings, accessibility — and it avoids
 * pulling a full editor in, which matters because the highlighter here is also
 * used for 200+ previews in the card feed.
 *
 * The two layers must agree on metrics exactly or the caret drifts from the text,
 * so font, size, line height, padding and tab size are set once in CSS and shared.
 */

import { useCallback, useEffect, useRef } from 'react';
import { Code, type LineMarks } from './Code.tsx';

/** Pixel height of one line; must match `.editor-layer`'s font-size × line-height. */
const LINE_HEIGHT = 12.5 * 1.55;

export function CodeEditor({
    value,
    language,
    onChange,
    marks,
    revealLine,
}: {
    value: string;
    language: string;
    onChange: (next: string) => void;
    /** Line decorations drawn on the highlighted layer, e.g. where findings are. */
    marks?: LineMarks;
    /** A 1-based line to scroll into view, e.g. a finding the user picked. */
    revealLine?: number | null;
}): React.JSX.Element {
    const area = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        const node = area.current;
        if (!node || !revealLine) return;
        node.scrollTop = Math.max(0, (revealLine - 1) * LINE_HEIGHT - node.clientHeight / 3);
    }, [revealLine]);
    const backdrop = useRef<HTMLDivElement>(null);

    // The highlighted layer has no scrollbar of its own; it follows the textarea.
    const syncScroll = useCallback((event: React.UIEvent<HTMLTextAreaElement>) => {
        const node = backdrop.current;
        if (!node) return;
        node.scrollTop = event.currentTarget.scrollTop;
        node.scrollLeft = event.currentTarget.scrollLeft;
    }, []);

    return (
        <div className="editor-wrap">
            <div className="editor-backdrop" ref={backdrop} aria-hidden="true">
                <Code code={value} language={language} className="editor-layer" marks={marks} />
            </div>
            <textarea
                ref={area}
                className="editor editor-layer"
                spellCheck={false}
                wrap="off"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onScroll={syncScroll}
            />
        </div>
    );
}
