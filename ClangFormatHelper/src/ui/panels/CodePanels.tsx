/**
 * The code-side panels: the editable sample, the formatted result, the diff, and
 * the option's official documentation example.
 */

import { useMemo, useState } from 'react';
import { useStore } from '../state/store.tsx';
import { getLanguage } from '../../core/languages/registry.ts';
import { diffLines } from '../../core/diff/lineDiff.ts';
import { catalog } from '../state/store.tsx';
import { Code, CodeLine } from '../components/Code.tsx';
import { CodeEditor } from '../components/CodeEditor.tsx';
import { copyText } from '../components/clipboard.ts';
import { highlightLines } from '../highlight/highlight.ts';
import { useGrammar } from '../highlight/useGrammar.ts';

/** Maps a doc example's `.. code-block::` language onto a grammar we have. */
function grammarForExample(language: string): string {
    if (/^(c\+\+|cpp|c|objc)$/i.test(language)) return 'cpp';
    if (/^ya?ml$/i.test(language)) return 'yaml';
    return 'plain';
}

/**
 * Chooses a library sample. The sample is shared by both tools, so this is too;
 * picking one replaces the code in whichever tool is showing.
 */
export function SamplePicker(): React.JSX.Element {
    const { state, dispatch, sample } = useStore();
    const language = getLanguage(state.doc.languageId);
    return (
        <select
            aria-label="Sample"
            value={sample === '' ? '' : (language.samples.find((s) => s.code === sample)?.id ?? 'custom')}
            onChange={(e) => {
                const chosen = language.samples.find((s) => s.id === e.target.value);
                if (chosen) dispatch({ type: 'setSample', languageId: language.id, code: chosen.code });
            }}
        >
            {language.samples.map((s) => (
                <option key={s.id} value={s.id}>
                    {s.title}
                </option>
            ))}
            <option value="custom">Custom…</option>
        </select>
    );
}

export function SamplePanel(): React.JSX.Element {
    const { state, dispatch, sample } = useStore();
    const language = getLanguage(state.doc.languageId);
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <SamplePicker />
                <span className="hint">Paste your own code — nothing leaves your browser.</span>
            </div>
            <CodeEditor
                value={sample}
                language={language.id}
                onChange={(code) => dispatch({ type: 'setSample', languageId: language.id, code })}
            />
        </div>
    );
}

export function FormattedPanel(): React.JSX.Element {
    const { state } = useStore();
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <strong>Formatted</strong>
            </div>
            <Code code={state.formatted} language={state.doc.languageId} className="output" />
        </div>
    );
}

/**
 * A side-by-side line diff with both sides highlighted. Shared by both tools:
 * the format side compares against the base style, the tidy side against the
 * code with its fixes applied.
 */
export function DiffView({
    before,
    after,
    language,
    title,
    hint,
}: {
    before: string;
    after: string;
    language: string;
    title: string;
    hint: (changed: number) => string;
}): React.JSX.Element {
    const rows = useMemo(() => diffLines(before, after), [before, after]);
    // Each side is parsed once as a whole document rather than line by line, so
    // constructs that span lines (block comments, raw strings) stay correct.
    const grammar = useGrammar(language);
    const beforeLines = useMemo(() => highlightLines(before, language), [before, language, grammar]);
    const afterLines = useMemo(() => highlightLines(after, language), [after, language, grammar]);
    const changed = rows.filter((r) => r.kind !== 'same').length;
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <strong>{title}</strong>
                <span className="hint">{hint(changed)}</span>
            </div>
            <div className="diff">
                {rows.map((row, i) => (
                    <div key={i} className={`diff-row ${row.kind}`}>
                        <span className="gutter">{row.beforeLine ?? ''}</span>
                        <pre className="side before">
                            {row.beforeLine === null ? '' : <CodeLine line={beforeLines[row.beforeLine - 1]} />}
                        </pre>
                        <span className="gutter">{row.afterLine ?? ''}</span>
                        <pre className="side after">
                            {row.afterLine === null ? '' : <CodeLine line={afterLines[row.afterLine - 1]} />}
                        </pre>
                    </div>
                ))}
            </div>
        </div>
    );
}

export function DiffPanel(): React.JSX.Element {
    const { state } = useStore();
    return (
        <DiffView
            before={state.baseFormatted}
            after={state.formatted}
            language={state.doc.languageId}
            title={`${state.doc.baseStyle} baseline`}
            hint={(changed) => `vs. your config — ${changed} line(s) differ`}
        />
    );
}

export function DocExamplePanel(): React.JSX.Element {
    const { state } = useStore();
    const option = catalog.options.find((o) => o.name === (state.expanded ?? '').split('.')[0]);
    const examples = option
        ? [...option.examples, ...option.values.flatMap((v) => v.examples), ...option.fields.flatMap((f) => f.examples)]
        : [];
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <strong>{option ? option.name : 'Documentation'}</strong>
                <span className="hint">
                    {option ? "clang-format's own example" : 'Expand an option to see its official example'}
                </span>
            </div>
            <div className="doc-body">
                {option && <p className="doc">{option.doc}</p>}
                {examples.slice(0, 6).map((ex, i) => (
                    <Code key={i} code={ex.code} language={grammarForExample(ex.language)} className="output" />
                ))}
                {option && examples.length === 0 && <p className="muted">This option ships no example.</p>}
            </div>
        </div>
    );
}

/**
 * The generated config file, with copy, download and import. Shared by both
 * tools; only the file name and the text differ.
 */
export function ConfigFilePanel({
    fileName,
    text,
    notice,
    onImport,
    accept,
}: {
    fileName: string;
    text: string;
    notice: string | null;
    onImport: (text: string) => void | Promise<void>;
    accept: string;
}): React.JSX.Element {
    const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <strong>{fileName}</strong>
                <button
                    onClick={async () => {
                        setCopyState((await copyText(text)) ? 'copied' : 'failed');
                        setTimeout(() => setCopyState('idle'), 1500);
                    }}
                    title={copyState === 'failed' ? 'Your browser blocked the copy — select the text instead' : undefined}
                >
                    {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
                </button>
                <button
                    onClick={() => {
                        const blob = new Blob([text], { type: 'text/yaml' });
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = fileName;
                        a.click();
                        URL.revokeObjectURL(a.href);
                    }}
                >
                    Download
                </button>
                <label className="import">
                    Import
                    <input
                        type="file"
                        accept={accept}
                        onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (file) await onImport(await file.text());
                            e.target.value = '';
                        }}
                    />
                </label>
            </div>
            {notice && <p className="notice">{notice}</p>}
            <Code code={text} language="yaml" className="output yaml" />
        </div>
    );
}

export function YamlPanel(): React.JSX.Element {
    const { state, fileText, importFile } = useStore();
    return (
        <ConfigFilePanel
            fileName=".clang-format"
            text={fileText}
            notice={state.importNotice}
            onImport={importFile}
            accept=".clang-format,.yaml,.yml,text/*"
        />
    );
}
