/**
 * clang-format's contributions to the toolbar, and its loading gate.
 */

import type { ReactNode } from 'react';
import { BASE_STYLES } from '../../core/catalog/types.ts';
import { summarise } from '../../core/analysis/impact.ts';
import { useStore } from '../state/store.tsx';

export function FormatToolbarControls(): React.JSX.Element {
    const { state, dispatch } = useStore();
    return (
        <label>
            Base style
            <select
                aria-label="Base style"
                value={state.doc.baseStyle}
                onChange={(e) => dispatch({ type: 'setBaseStyle', value: e.target.value as never })}
            >
                {BASE_STYLES.map((s) => (
                    <option key={s} value={s}>
                        {s}
                    </option>
                ))}
            </select>
        </label>
    );
}

export function FormatToolbarStatus(): React.JSX.Element {
    const { state, dispatch, runImpact } = useStore();
    const impactSummary = state.impact ? summarise(state.impact) : null;
    return (
        <>
            {state.impactProgress && (
                <span className="progress">
                    analysing {state.impactProgress.done}/{state.impactProgress.total}
                </span>
            )}
            {impactSummary && !state.impactProgress && (
                <span className={`progress ${state.impactStale ? 'stale' : ''}`}>
                    {impactSummary.live} of {impactSummary.live + impactSummary.inert} options affect this sample
                    {state.impactStale && ' · out of date'}
                </span>
            )}
            <button onClick={runImpact} disabled={state.status !== 'ready'}>
                {state.impact ? 'Re-analyse' : 'Analyse my code'}
            </button>
            <button onClick={() => dispatch({ type: 'resetAll' })} disabled={state.doc.overrides.size === 0}>
                Reset {state.doc.overrides.size > 0 ? `(${state.doc.overrides.size})` : ''}
            </button>
        </>
    );
}

export function FormatGate({ children }: { children: ReactNode }): React.JSX.Element {
    const { state } = useStore();
    if (state.status === 'booting') {
        return (
            <div className="boot">
                <p>Loading clang-format (a one-time ~860 KB download)…</p>
            </div>
        );
    }
    if (state.status === 'error') return <div className="boot error">Could not start clang-format: {state.error}</div>;
    return <>{children}</>;
}
