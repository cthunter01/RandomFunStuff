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

import { useCallback, useRef } from 'react';
import { Code } from './Code.tsx';

export function CodeEditor({
    value,
    language,
    onChange,
}: {
    value: string;
    language: string;
    onChange: (next: string) => void;
}): React.JSX.Element {
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
                <Code code={value} language={language} className="editor-layer" />
            </div>
            <textarea
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
