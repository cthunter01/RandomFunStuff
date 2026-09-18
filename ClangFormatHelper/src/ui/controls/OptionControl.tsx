/**
 * Renders one settable option, at whichever density the layout asked for.
 *
 * There is a single control component per value shape rather than a component
 * per layout: an option row in the workbench and an option card in the feed are
 * the same control at `compact` and `inline` density. That is what stops the
 * three layouts from drifting into three separate implementations of the same
 * 343 settings.
 */

import { memo } from 'react';
import type { NestedFieldDescriptor, OptionDescriptor } from '../../core/catalog/types.ts';
import type { ConfigValue } from '../../core/config/model.ts';
import type { Provenance } from '../../core/config/effective.ts';
import type { ImpactResult } from '../../core/analysis/impact.ts';
import type { Verdict } from '../../core/config/constraints.ts';
import { Code } from '../components/Code.tsx';

export type Density = 'comfortable' | 'compact' | 'inline';

export interface ControlProps {
    path: string;
    /** True when the impact figures predate the current config. */
    impactStale?: boolean;
    label: string;
    kind: OptionDescriptor['kind'];
    values: { value: string; doc: string; needsPrerequisite: boolean }[];
    shorthandValues: string[];
    value: ConfigValue | undefined;
    provenance: Provenance | undefined;
    overridden: boolean;
    impact?: ImpactResult;
    verdicts?: Verdict[];
    density: Density;
    /** Grammar for the micro-preview. Passed rather than read from context so the
     *  memoised control does not re-render on every unrelated store change. */
    language: string;
    onChange: (path: string, value: ConfigValue) => void;
    onReset: (path: string) => void;
}

function Editor({ path, kind, values, shorthandValues, value, onChange }: ControlProps): React.JSX.Element {
    switch (kind) {
        case 'bool':
            return (
                <label className="switch">
                    <input
                        type="checkbox"
                        checked={value === true}
                        onChange={(e) => onChange(path, e.target.checked)}
                    />
                    <span>{value === true ? 'true' : 'false'}</span>
                </label>
            );
        case 'enum':
        case 'nested': {
            const choices = kind === 'enum' ? values.map((v) => v.value) : shorthandValues;
            if (choices.length === 0) return <span className="muted">expand to edit fields</span>;
            return (
                <select
                    value={typeof value === 'string' ? value : ''}
                    onChange={(e) => onChange(path, e.target.value)}
                >
                    <option value="" disabled>
                        {typeof value === 'object' ? '(custom)' : 'choose…'}
                    </option>
                    {values
                        .filter((v) => !v.needsPrerequisite)
                        .map((v) => (
                            <option key={v.value} value={v.value}>
                                {v.value}
                            </option>
                        ))}
                    {kind === 'nested' &&
                        shorthandValues.map((v) => (
                            <option key={v} value={v}>
                                {v}
                            </option>
                        ))}
                </select>
            );
        }
        case 'unsigned':
        case 'integer':
            return (
                <input
                    type="number"
                    value={typeof value === 'number' ? value : 0}
                    min={kind === 'unsigned' ? 0 : undefined}
                    onChange={(e) => onChange(path, Number(e.target.value))}
                />
            );
        case 'string':
            return (
                <input
                    type="text"
                    value={typeof value === 'string' ? value : ''}
                    onChange={(e) => onChange(path, e.target.value)}
                />
            );
        case 'stringList':
            return (
                <input
                    type="text"
                    placeholder="comma separated"
                    value={Array.isArray(value) ? (value as string[]).join(', ') : ''}
                    onChange={(e) =>
                        onChange(
                            path,
                            e.target.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean),
                        )
                    }
                />
            );
        default:
            // IncludeCategories and RawStringFormats are lists of structs; editing
            // them as text is honest until a dedicated editor exists.
            return (
                <textarea
                    rows={3}
                    value={value === undefined ? '' : JSON.stringify(value, null, 1)}
                    onChange={(e) => {
                        try {
                            onChange(path, JSON.parse(e.target.value) as ConfigValue);
                        } catch {
                            /* keep the last valid value while the user is mid-edit */
                        }
                    }}
                />
            );
    }
}

export const OptionControl = memo(function OptionControl(props: ControlProps): React.JSX.Element {
    const { path, label, provenance, overridden, impact, verdicts, density, onReset } = props;
    const stale = props.impactStale === true;
    const inert = impact?.verdict === 'inert';
    const blocked = verdicts?.find((v) => v.kind !== 'ok');

    return (
        <div
            className={`option ${density} ${inert && !stale ? 'inert' : ''} ${overridden ? 'overridden' : ''} ${
                stale ? 'stale' : ''
            }`}
        >
            <div className="option-head">
                <span className="option-name" title={path}>
                    {label}
                </span>
                <span className="option-badges">
                    {impact?.verdict === 'live' && (
                        <span
                            className="badge live"
                            title={
                                impact.assumes?.length
                                    ? `Measured with ${impact.assumes.map((a) => `${a.path}: ${String(a.value)}`).join(', ')}`
                                    : undefined
                            }
                        >
                            {impact.magnitude} lines
                        </span>
                    )}
                    {inert && <span className="badge dim">no effect here</span>}
                    {impact?.verdict === 'unknown' && <span className="badge dim">?</span>}
                    {provenance === 'derived' && <span className="badge derived">derived</span>}
                    {provenance === 'ignored' && <span className="badge warn">ignored</span>}
                    {overridden && (
                        <button className="reset" onClick={() => onReset(path)} title="Reset to base style">
                            ↺
                        </button>
                    )}
                </span>
            </div>
            <div className="option-editor">
                <Editor {...props} />
            </div>
            {blocked && (
                <div className={`verdict ${blocked.kind}`}>
                    {blocked.message}
                    {blocked.fix && (
                        <button onClick={() => props.onChange(blocked.fix!.path, blocked.fix!.value)}>
                            {blocked.fix.label}
                        </button>
                    )}
                </div>
            )}
            {impact?.verdict === 'live' && impact.assumes && impact.assumes.length > 0 && (
                // Saying "N lines" without this would imply the option does that on its
                // own, when in fact a parent feature had to be switched on first.
                <div className="assumes">
                    needs {impact.assumes.map((a) => `${a.path}: ${String(a.value)}`).join(', ')}
                </div>
            )}
            {density === 'inline' && impact?.witness?.hunk && (
                <div className="micro-preview">
                    <Code
                        code={impact.witness.hunk.before.join('\n')}
                        language={props.language}
                        className="before"
                    />
                    <Code
                        code={impact.witness.hunk.after.join('\n')}
                        language={props.language}
                        className="after"
                    />
                </div>
            )}
        </div>
    );
});

export type { NestedFieldDescriptor };
