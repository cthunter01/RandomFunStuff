/**
 * The card feed: every option as a card carrying its own before/after preview,
 * generated from the user's actual code.
 *
 * The previews cost nothing extra — they are the witness the impact sweep
 * already recorded for the candidate that changed the most. Without a sweep
 * there is nothing to preview, so the panel says so rather than showing empty
 * cards.
 */

import { useStore } from '../state/store.tsx';
import { useOptionRows } from '../hooks/useOptionRows.ts';
import { OptionControl } from '../controls/OptionControl.tsx';
import { OptionFilterBar } from './OptionFilterBar.tsx';
import type { ConfigValue } from '../../core/config/model.ts';

export function OptionCardFeedPanel(): React.JSX.Element {
    const { state, dispatch, runImpact } = useStore();
    const { groups, total, shown } = useOptionRows();
    const set = (path: string, value: ConfigValue) => dispatch({ type: 'setOverride', path, value });
    const reset = (path: string) => dispatch({ type: 'clearOverride', path });

    return (
        <div className="panel card-feed">
            <OptionFilterBar shown={shown} total={total} />
            {!state.impact && (
                <div className="feed-cta">
                    <p>
                        Cards show a live before/after built from your own code. Run the analysis to fill them in
                        and to sink the options that do nothing here.
                    </p>
                    <button className="primary" onClick={runImpact}>
                        Analyse my code
                    </button>
                </div>
            )}
            <div className="feed-scroll">
                {groups.map(({ group, rows }) => (
                    <section key={group} className="option-group">
                        <h3>{group}</h3>
                        <div className="cards">
                            {rows.map((row) => (
                                <OptionControl
                                    key={row.path}
                                    path={row.path}
                                    label={row.option.name}
                                    kind={row.option.kind}
                                    values={row.option.values.map((v) => ({
                                        value: v.value,
                                        doc: v.doc,
                                        needsPrerequisite: v.needsPrerequisite,
                                    }))}
                                    shorthandValues={row.option.shorthandValues}
                                    value={row.value}
                                    provenance={state.effective?.provenance.get(row.path)}
                                    overridden={row.overridden}
                                    impact={state.impact?.get(row.path)}
                                    verdicts={state.verdicts.get(row.path)}
                                    density="inline"
                                    onChange={set}
                                    onReset={reset}
                                />
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}
