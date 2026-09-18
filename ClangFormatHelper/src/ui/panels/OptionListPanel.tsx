/**
 * The option rail: search, filter, and every option grouped by concern.
 *
 * Rows render collapsed by default and only pull in their documentation and
 * nested fields when expanded, which is what keeps 343 settable paths scrolling
 * smoothly without a virtualiser.
 */

import { useStore } from '../state/store.tsx';
import { useOptionRows } from '../hooks/useOptionRows.ts';
import { OptionControl, type Density } from '../controls/OptionControl.tsx';
import { OptionFilterBar } from './OptionFilterBar.tsx';
import type { ConfigValue } from '../../core/config/model.ts';

export function OptionListPanel({ density = 'compact' }: { density?: Density }): React.JSX.Element {
    const { state, dispatch } = useStore();
    const { groups, total, shown } = useOptionRows();

    const set = (path: string, value: ConfigValue) => dispatch({ type: 'setOverride', path, value });
    const reset = (path: string) => dispatch({ type: 'clearOverride', path });

    return (
        <div className="panel option-list">
            <OptionFilterBar shown={shown} total={total} />

            <div className="option-scroll">
                {groups.map(({ group, rows }) => (
                    <section key={group} className="option-group">
                        <h3>{group}</h3>
                        {rows.map((row) => {
                            const expanded = state.expanded === row.path;
                            return (
                                <div key={row.path} className="option-wrap">
                                    <button
                                        className="disclosure"
                                        onClick={() =>
                                            dispatch({ type: 'expand', path: expanded ? null : row.path })
                                        }
                                        aria-expanded={expanded}
                                    >
                                        {expanded ? '▾' : '▸'}
                                    </button>
                                    <OptionControl
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
                                        density={density}
                                        language={state.doc.languageId}
                                        onChange={set}
                                        onReset={reset}
                                    />
                                    {expanded && (
                                        <div className="option-detail">
                                            <p className="doc">{row.option.doc}</p>
                                            <p className="meta">
                                                since clang-format {row.option.since} · {row.option.declaredType}
                                                {row.option.languageHints.length > 0 &&
                                                    ` · specific to ${row.option.languageHints.join(', ')}`}
                                            </p>
                                            {row.option.fields.length > 0 && (
                                                <div className="nested-fields">
                                                    {row.option.fields
                                                        .filter((f) => !f.deprecated)
                                                        .map((field) => {
                                                            const path = `${row.path}.${field.name}`;
                                                            return (
                                                                <OptionControl
                                                                    key={path}
                                                                    path={path}
                                                                    label={field.name}
                                                                    kind={field.kind}
                                                                    values={field.values.map((v) => ({
                                                                        value: v.value,
                                                                        doc: v.doc,
                                                                        needsPrerequisite: v.needsPrerequisite,
                                                                    }))}
                                                                    shorthandValues={[]}
                                                                    value={state.effective?.values.get(path)}
                                                                    provenance={state.effective?.provenance.get(path)}
                                                                    overridden={state.doc.overrides.has(path)}
                                                                    impact={state.impact?.get(path)}
                                                                    verdicts={state.verdicts.get(path)}
                                                                    density="compact"
                                                                    language={state.doc.languageId}
                                                                    onChange={set}
                                                                    onReset={reset}
                                                                />
                                                            );
                                                        })}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </section>
                ))}
                {shown === 0 && <p className="empty">Nothing matches that filter.</p>}
            </div>
        </div>
    );
}
