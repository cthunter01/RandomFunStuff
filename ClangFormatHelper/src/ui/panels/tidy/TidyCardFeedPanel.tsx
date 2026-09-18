/**
 * The Tidy card feed: every check that found something in your code, as a card
 * with the findings and a before/after of its fix — built from *your* code.
 *
 * Like the format feed, the previews cost nothing extra: they are the witness
 * the survey already recorded. Checks that found nothing are counted but not
 * carded; a wall of 550 empty cards would bury the 40 that matter.
 */

import { useCheckRows } from '../../hooks/useCheckRows.ts';
import { useStore } from '../../state/store.tsx';
import { useTidyStore } from '../../state/tidyStore.tsx';
import { Code } from '../../components/Code.tsx';
import { FindingList } from './TidyCheckListPanel.tsx';
import { AnalysisProgress } from './TidyToolbar.tsx';

export function TidyCardFeedPanel(): React.JSX.Element {
    const { state: shell } = useStore();
    const { state, dispatch, runAnalysis } = useTidyStore();
    const { modules } = useCheckRows();
    const firing = modules
        .map((m) => ({ ...m, rows: m.rows.filter((r) => r.findings) }))
        .filter((m) => m.rows.length > 0);
    const silent = modules.reduce((n, m) => n + m.rows.filter((r) => r.silent).length, 0);

    return (
        <div className="panel card-feed">
            <div className="panel-toolbar">
                <input
                    className="search"
                    type="search"
                    placeholder="Search checks…"
                    value={state.search}
                    onChange={(e) => dispatch({ type: 'search', value: e.target.value })}
                />
                <label className="check">
                    <input
                        type="checkbox"
                        checked={state.onlyEnabled}
                        onChange={(e) => dispatch({ type: 'onlyEnabled', value: e.target.checked })}
                    />
                    Only enabled
                </label>
                <AnalysisProgress />
            </div>
            {!state.survey && (
                <div className="feed-cta">
                    <p>
                        Cards show what each check finds in your code, and what its fix would change. The analysis
                        runs every check once — a few seconds for a large C++ file — then tries each option&apos;s
                        alternatives to find the ones that matter here.
                    </p>
                    <button className="primary" onClick={runAnalysis} disabled={state.status !== 'ready' || !!state.analysis}>
                        Analyse my code
                    </button>
                </div>
            )}
            <div className="feed-scroll">
                {firing.map((group) => (
                    <section key={group.module} className="option-group">
                        <h3 title={group.description}>{group.module}</h3>
                        <div className="cards">
                            {group.rows.map(({ check, enabled, findings }) => (
                                <div
                                    key={check.name}
                                    className={`option inline tidy-card ${enabled ? 'overridden' : ''} ${state.analysisStale ? 'stale' : ''}`}
                                >
                                    <div className="option-head">
                                        <label className="check-name">
                                            <input
                                                type="checkbox"
                                                checked={enabled}
                                                onChange={(e) =>
                                                    dispatch({ type: 'setCheck', check: check.name, enable: e.target.checked })
                                                }
                                            />
                                            {check.name}
                                        </label>
                                        <span className="option-badges">
                                            <span className="badge live">{findings!.diagnostics.length}</span>
                                            {findings!.via && <span className="badge dim">via {findings!.via}</span>}
                                        </span>
                                    </div>
                                    <p className="card-summary">{check.summary}</p>
                                    <FindingList findings={findings!} limit={3} />
                                    {findings!.witness?.hunk ? (
                                        <div className="micro-preview">
                                            <Code
                                                code={findings!.witness.hunk.before.join('\n')}
                                                language={shell.doc.languageId}
                                                className="before"
                                            />
                                            <Code
                                                code={findings!.witness.hunk.after.join('\n')}
                                                language={shell.doc.languageId}
                                                className="after"
                                            />
                                        </div>
                                    ) : (
                                        <p className="muted">
                                            {check.offersFixes ? 'Offers fixes, but none for these findings.' : 'Reports only; no automatic fix.'}
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    </section>
                ))}
                {state.survey && (
                    <p className="empty">
                        {silent} check{silent === 1 ? '' : 's'} found nothing in this code
                        {state.survey.compileErrors.length > 0 && ' — and it has compile errors, which can hide findings'}.
                    </p>
                )}
            </div>
        </div>
    );
}
