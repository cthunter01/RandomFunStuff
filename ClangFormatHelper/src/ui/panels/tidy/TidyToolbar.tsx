/**
 * Tidy's contributions to the toolbar, and the gate that stands in for its
 * panels while clang-tidy loads.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { summariseSurvey } from '../../../core/tidy/analysis.ts';
import { createTidyDocument, TIDY_PRESETS } from '../../../core/tidy/config.ts';
import { getLanguage } from '../../../core/languages/registry.ts';
import { useStore } from '../../state/store.tsx';
import { currentPresetId, useTidyStore } from '../../state/tidyStore.tsx';

/** Starting point and compiler flags: the two things that shape every run. */
export function TidyToolbarControls(): React.JSX.Element {
    const { state: shell } = useStore();
    const { state, dispatch, applyPreset } = useTidyStore();
    const language = getLanguage(shell.doc.languageId);
    const flags = state.flags[language.id] ?? '';
    const [draft, setDraft] = useState(flags);
    useEffect(() => setDraft(flags), [flags]);
    const commit = (): void => {
        if (draft !== flags) dispatch({ type: 'setFlags', languageId: language.id, flags: draft });
    };
    const presetId = currentPresetId(state.doc);
    return (
        <>
            <label title={TIDY_PRESETS.find((p) => p.id === presetId)?.blurb}>
                Start from
                <select aria-label="Starting point" value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                    {presetId === '' && (
                        <option value="" disabled>
                            (your own)
                        </option>
                    )}
                    {TIDY_PRESETS.map((p) => (
                        <option key={p.id} value={p.id} title={p.blurb}>
                            {p.label}
                        </option>
                    ))}
                </select>
            </label>
            <label title="How the code is compiled for analysis. Not part of .clang-tidy — in a project these come from compile_commands.json.">
                Flags
                <input
                    type="text"
                    className="mono flags"
                    aria-label="Compiler flags"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => e.key === 'Enter' && commit()}
                    disabled={!language.tidy}
                />
            </label>
        </>
    );
}

/** Progress of a running analysis, or a summary of the last one. */
export function AnalysisProgress(): React.JSX.Element | null {
    const { state, cancelAnalysis } = useTidyStore();
    if (state.analysis) {
        const { phase, done, total } = state.analysis;
        return (
            <span className="progress">
                {phase === 'survey' ? 'running every check' : 'trying option values'} {done}/{total}{' '}
                <button className="linklike" onClick={cancelAnalysis}>
                    cancel
                </button>
            </span>
        );
    }
    if (state.analysisError) return <span className="progress stale">analysis failed: {state.analysisError}</span>;
    if (!state.survey) return null;
    const summary = summariseSurvey(state.survey);
    return (
        <span className={`progress ${state.analysisStale ? 'stale' : ''}`}>
            {summary.firing}/{summary.firing + summary.silent} checks fire here
            {state.analysisStale && ' · out of date'}
        </span>
    );
}

export function TidyToolbarStatus(): React.JSX.Element {
    const { state, dispatch, runAnalysis, supported } = useTidyStore();
    const changes = state.doc.options.size + state.doc.settings.size;
    const pristine = changes === 0 && currentPresetId(state.doc) === currentPresetId(createTidyDocument());
    return (
        <>
            <AnalysisProgress />
            <button onClick={runAnalysis} disabled={state.status !== 'ready' || !!state.analysis || !supported}>
                {state.survey ? 'Re-analyse' : 'Analyse my code'}
            </button>
            <button
                onClick={() => dispatch({ type: 'replaceDoc', doc: createTidyDocument(), notice: null })}
                disabled={pristine}
                title="Back to the default starting point, with no options set"
            >
                Reset {changes > 0 ? `(${changes})` : ''}
            </button>
        </>
    );
}

/** Stands in for the Tidy panels until clang-tidy is running, and explains why when it cannot. */
export function TidyGate({ children }: { children: ReactNode }): React.JSX.Element {
    const { state: shell } = useStore();
    const { state, supported } = useTidyStore();
    const language = getLanguage(shell.doc.languageId);
    if (!supported) {
        return (
            <div className="boot">
                clang-tidy analyses C-family code only; {language.label} is not one. Switch the language, or use
                clang-format.
            </div>
        );
    }
    if (state.status === 'error') return <div className="boot error">Could not start clang-tidy: {state.error}</div>;
    if (state.status !== 'ready' || !state.catalog) {
        return (
            <div className="boot">
                <p>Loading clang-tidy — a one-time download of about 9 MB, cached afterwards.</p>
                <p className="muted">
                    It is the real clang-tidy {'23.1.1'} compiled to WebAssembly, with the C and C++ standard headers it
                    needs. Your code still never leaves the browser.
                </p>
            </div>
        );
    }
    return <>{children}</>;
}
