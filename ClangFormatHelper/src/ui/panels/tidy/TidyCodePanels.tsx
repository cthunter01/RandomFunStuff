/**
 * The code-side panels for Tidy: your code with its findings marked, the code
 * with every fix applied, the diff between the two, the expanded check's
 * documentation, and the generated `.clang-tidy`.
 */

import { useMemo } from 'react';
import { applyReplacements } from '../../../core/tidy/diagnostics.ts';
import type { TidyDiagnostic } from '../../../core/tidy/port.ts';
import { getLanguage } from '../../../core/languages/registry.ts';
import { Code, type LineMarks } from '../../components/Code.tsx';
import { CodeEditor } from '../../components/CodeEditor.tsx';
import { useStore } from '../../state/store.tsx';
import { useTidyStore } from '../../state/tidyStore.tsx';
import { ConfigFilePanel, DiffView, SamplePicker } from '../CodePanels.tsx';
import { checkDocUrl } from './TidyCheckListPanel.tsx';

/** Maps a doc example's `.. code-block::` language onto a grammar we have. */
function grammarForExample(language: string): string {
    if (/^(c\+\+|cpp|c|objc)$/i.test(language)) return 'cpp';
    if (/^ya?ml$/i.test(language)) return 'yaml';
    return 'plain';
}

function useLiveFindings(): { findings: TidyDiagnostic[]; errors: TidyDiagnostic[] } {
    const { state } = useTidyStore();
    return useMemo(() => {
        const all = state.live?.diagnostics ?? [];
        return { findings: all.filter((d) => d.level !== 'error'), errors: all.filter((d) => d.level === 'error') };
    }, [state.live]);
}

/** The status line shared by the code panels: running, stale, or how many findings. */
function LiveStatus(): React.JSX.Element {
    const { state } = useTidyStore();
    const { findings, errors } = useLiveFindings();
    if (state.status !== 'ready') return <span className="hint">starting clang-tidy…</span>;
    if (!state.live) return <span className="hint">running clang-tidy…</span>;
    return (
        <span className={`hint ${state.liveStale || state.liveRunning ? 'stale' : ''}`}>
            {findings.length} finding{findings.length === 1 ? '' : 's'}
            {errors.length > 0 && `, ${errors.length} compile error${errors.length === 1 ? '' : 's'}`} ·{' '}
            {Math.round(state.live.millis)} ms{(state.liveStale || state.liveRunning) && ' · updating…'}
        </span>
    );
}

/** What the analyser had to work around, said plainly rather than left to surprise. */
function Caveats(): React.JSX.Element | null {
    const { state } = useTidyStore();
    const { errors } = useLiveFindings();
    const stubbed = state.live?.stubbedIncludes ?? [];
    const configWarnings = (state.live?.output ?? '')
        .split('\n')
        .filter((l) => /\[clang-tidy-config\]|^Error|error: /.test(l) && !/\[clang-diagnostic-/.test(l));
    if (stubbed.length === 0 && errors.length === 0 && configWarnings.length === 0 && !state.liveError) return null;
    return (
        <div className="caveats">
            {state.liveError && <p className="notice error">clang-tidy failed: {state.liveError}</p>}
            {configWarnings.map((w, i) => (
                <p key={i} className="notice">
                    {w}
                </p>
            ))}
            {stubbed.length > 0 && (
                <p className="notice subtle" title="Replaced by empty files so the rest of the code can be analysed">
                    Headers not available here, treated as empty: {stubbed.join(', ')}
                </p>
            )}
            {errors.slice(0, 3).map((e, i) => (
                <p key={i} className="notice error">
                    {e.span ? `L${e.span.line}: ` : ''}
                    {e.message}
                    {i === 0 && stubbed.length > 0 && ' — probably something a stubbed header declares'}
                </p>
            ))}
        </div>
    );
}

export function TidySamplePanel(): React.JSX.Element {
    const { state: shell, dispatch: shellDispatch, sample } = useStore();
    const { state, dispatch } = useTidyStore();
    const language = getLanguage(shell.doc.languageId);
    const { findings, errors } = useLiveFindings();

    const marks = useMemo<LineMarks>(() => {
        const out = new Map<number, string>();
        for (const d of findings) if (d.span) out.set(d.span.line - 1, 'mark-warning');
        for (const d of errors) if (d.span) out.set(d.span.line - 1, 'mark-error');
        if (state.focusLine) out.set(state.focusLine - 1, `${out.get(state.focusLine - 1) ?? ''} mark-focus`);
        return out;
    }, [findings, errors, state.focusLine]);

    const sorted = useMemo(
        () => [...findings].sort((a, b) => (a.span?.line ?? 0) - (b.span?.line ?? 0) || a.check.localeCompare(b.check)),
        [findings],
    );

    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <SamplePicker />
                <LiveStatus />
            </div>
            <Caveats />
            <CodeEditor
                value={sample}
                language={language.id}
                marks={marks}
                revealLine={state.focusLine}
                onChange={(code) => shellDispatch({ type: 'setSample', languageId: language.id, code })}
            />
            <div className={`findings ${state.liveStale ? 'stale' : ''}`}>
                {sorted.length === 0 && state.live && (
                    <p className="muted">No findings from the enabled checks.</p>
                )}
                {sorted.map((d, i) => (
                    <button
                        key={i}
                        className={`finding ${state.focusLine === d.span?.line ? 'active' : ''}`}
                        onClick={() => {
                            dispatch({ type: 'focusLine', line: d.span?.line ?? null });
                            dispatch({ type: 'expand', check: d.check });
                        }}
                    >
                        <span className="where">{d.span ? `${d.span.line}:${d.span.column}` : '—'}</span>
                        <span className="what">{d.message}</span>
                        <span className="which">
                            {d.check}
                            {d.replacements.length > 0 && ' · fix'}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

/** The sample with every fix from the enabled checks applied — what `clang-tidy --fix` would write. */
function useFixed(): { text: string; applied: number; skipped: number; lost: number } {
    const { sample } = useStore();
    const { findings } = useLiveFindings();
    return useMemo(() => {
        const replacements = findings.flatMap((d) => d.replacements);
        const { text, skipped } = applyReplacements(sample, replacements);
        const lost = findings.filter((d) => d.notes.some((n) => /overlaps with another fix/.test(n.message))).length;
        return { text, applied: findings.filter((d) => d.replacements.length > 0).length, skipped, lost };
    }, [sample, findings]);
}

export function TidyFixedPanel(): React.JSX.Element {
    const { state: shell } = useStore();
    const fixed = useFixed();
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <strong>With fixes applied</strong>
                <span className="hint">
                    {fixed.applied} finding{fixed.applied === 1 ? '' : 's'} fixed
                    {fixed.lost > 0 && ` · ${fixed.lost} not fixed: their fixes overlap another check's, so clang-tidy drops both`}
                </span>
            </div>
            <Code code={fixed.text} language={shell.doc.languageId} className="output" />
        </div>
    );
}

export function TidyDiffPanel(): React.JSX.Element {
    const { state: shell, sample } = useStore();
    const fixed = useFixed();
    return (
        <DiffView
            before={sample}
            after={fixed.text}
            language={shell.doc.languageId}
            title="Your code"
            hint={(changed) => `vs. with fixes applied — ${changed} line(s) differ`}
        />
    );
}

export function TidyDocPanel(): React.JSX.Element {
    const { state } = useTidyStore();
    const check = state.catalog?.checks.find((c) => c.name === state.expanded);
    return (
        <div className="panel code-panel">
            <div className="panel-toolbar">
                <strong>{check ? check.name : 'Documentation'}</strong>
                <span className="hint">
                    {check ? (
                        <a href={checkDocUrl(check)} target="_blank" rel="noreferrer">
                            upstream docs ↗
                        </a>
                    ) : (
                        'Expand a check to read its documentation'
                    )}
                </span>
            </div>
            <div className="doc-body">
                {check && (
                    <>
                        <p className="doc">{check.summary}</p>
                        {check.doc && <p className="doc">{check.doc}</p>}
                        {check.examples.slice(0, 6).map((ex, i) => (
                            <Code key={i} code={ex.code} language={grammarForExample(ex.language)} className="output" />
                        ))}
                        {check.options.length > 0 && <h4>Options</h4>}
                        {check.options.map((o) => (
                            <div key={o.name} className="option-doc">
                                <code>{o.name}</code>
                                <span className="count">
                                    {' '}
                                    {o.kind}
                                    {o.default !== null && `, default ${o.default === '' ? "''" : o.default}`}
                                </span>
                                {o.doc && <p className="doc">{o.doc}</p>}
                            </div>
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

export function TidyFilePanel(): React.JSX.Element {
    const { state, fileText, importFile } = useTidyStore();
    return (
        <ConfigFilePanel
            fileName=".clang-tidy"
            text={fileText || '# No settings: clang-tidy would run only its default checks.\n'}
            notice={state.importNotice}
            onImport={importFile}
            accept=".clang-tidy,.yaml,.yml,text/*"
        />
    );
}
