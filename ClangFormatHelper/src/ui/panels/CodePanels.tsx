/**
 * The code-side panels: the editable sample, the formatted result, the diff, and
 * the option's official documentation example.
 */

import { useMemo } from 'react';
import { useStore } from '../state/store.tsx';
import { getLanguage } from '../../core/languages/registry.ts';
import { diffLines } from '../../core/diff/lineDiff.ts';
import { catalog } from '../state/store.tsx';

export function SamplePanel(): React.JSX.Element {
    const { state, dispatch, sample } = useStore();
    const language = getLanguage(state.doc.languageId);
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <select
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
                <span className="hint">Paste your own code — nothing leaves your browser.</span>
            </div>
            <textarea
                className="editor"
                spellCheck={false}
                value={sample}
                onChange={(e) => dispatch({ type: 'setSample', languageId: language.id, code: e.target.value })}
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
            <pre className="output">{state.formatted}</pre>
        </div>
    );
}

export function DiffPanel(): React.JSX.Element {
    const { state } = useStore();
    const rows = useMemo(
        () => diffLines(state.baseFormatted, state.formatted),
        [state.baseFormatted, state.formatted],
    );
    const changed = rows.filter((r) => r.kind !== 'same').length;
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <strong>{state.doc.baseStyle} baseline</strong>
                <span className="hint">vs. your config — {changed} line(s) differ</span>
            </div>
            <div className="diff">
                {rows.map((row, i) => (
                    <div key={i} className={`diff-row ${row.kind}`}>
                        <span className="gutter">{row.beforeLine ?? ''}</span>
                        <pre className="side before">{row.before ?? ''}</pre>
                        <span className="gutter">{row.afterLine ?? ''}</span>
                        <pre className="side after">{row.after ?? ''}</pre>
                    </div>
                ))}
            </div>
        </div>
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
                    <pre key={i} className="output">
                        {ex.code}
                    </pre>
                ))}
                {option && examples.length === 0 && <p className="muted">This option ships no example.</p>}
            </div>
        </div>
    );
}

export function YamlPanel(): React.JSX.Element {
    const { state, fileText, importFile } = useStore();
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <strong>.clang-format</strong>
                <button onClick={() => void navigator.clipboard.writeText(fileText)}>Copy</button>
                <button
                    onClick={() => {
                        const blob = new Blob([fileText], { type: 'text/yaml' });
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = '.clang-format';
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
                        accept=".clang-format,.yaml,.yml,text/*"
                        onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (file) await importFile(await file.text());
                            e.target.value = '';
                        }}
                    />
                </label>
            </div>
            {state.importNotice && <p className="notice">{state.importNotice}</p>}
            <pre className="output yaml">{fileText}</pre>
        </div>
    );
}
