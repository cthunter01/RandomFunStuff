/**
 * The app-level controls: what you are configuring, and how you want to look at it.
 *
 * The layout switcher lives here because a layout is a view over one shared
 * store — switching it keeps every bit of state, which is the point.
 */

import { catalog, useStore, type LayoutId, type ThemeChoice } from '../state/store.tsx';
import { listLanguages } from '../../core/languages/registry.ts';
import { BASE_STYLES } from '../../core/catalog/types.ts';
import { layouts } from '../layouts/registry.tsx';
import { summarise } from '../../core/analysis/impact.ts';

export function Toolbar(): React.JSX.Element {
    const { state, dispatch, runImpact } = useStore();
    const impactSummary = state.impact ? summarise(state.impact) : null;

    return (
        <header className="toolbar">
            <div className="brand">
                <strong>clang-format Helper</strong>
                <span className="version">clang-format {catalog.clangFormatVersion}</span>
            </div>

            <label>
                Language
                <select
                    aria-label="Language"
                    value={state.doc.languageId}
                    onChange={(e) => dispatch({ type: 'setLanguage', value: e.target.value })}
                >
                    {listLanguages().map((l) => (
                        <option key={l.id} value={l.id}>
                            {l.label}
                        </option>
                    ))}
                </select>
            </label>

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

            <label>
                Layout
                <select
                    aria-label="Layout"
                    value={state.layoutId}
                    onChange={(e) => dispatch({ type: 'setLayout', value: e.target.value as LayoutId })}
                >
                    {layouts.map((l) => (
                        <option key={l.id} value={l.id} title={l.blurb}>
                            {l.label}
                        </option>
                    ))}
                </select>
            </label>

            <label>
                Theme
                <select
                    aria-label="Theme"
                    value={state.theme}
                    onChange={(e) => dispatch({ type: 'setTheme', value: e.target.value as ThemeChoice })}
                >
                    <option value="system">Match system</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                </select>
            </label>

            <div className="spacer" />

            {state.impactProgress && (
                <span className="progress">
                    analysing {state.impactProgress.done}/{state.impactProgress.total}
                </span>
            )}
            {impactSummary && !state.impactProgress && (
                <span className="progress">
                    {impactSummary.live} of {impactSummary.live + impactSummary.inert} options affect this sample
                </span>
            )}
            <button onClick={runImpact} disabled={state.status !== 'ready'}>
                {state.impact ? 'Re-analyse' : 'Analyse my code'}
            </button>
            <button onClick={() => dispatch({ type: 'resetAll' })} disabled={state.doc.overrides.size === 0}>
                Reset {state.doc.overrides.size > 0 ? `(${state.doc.overrides.size})` : ''}
            </button>
        </header>
    );
}
