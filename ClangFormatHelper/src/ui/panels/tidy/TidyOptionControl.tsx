/**
 * Edits one check option. The control follows the kind the *binary* reported for
 * the option (see the catalog generator), not a guess from its name.
 */

import { memo, useEffect, useState } from 'react';
import { parseTidyBool, type TidyOptionDescriptor } from '../../../core/tidy/catalog.ts';
import type { TidyProvenance } from '../../../core/tidy/config.ts';
import type { OptionImpact } from '../../../core/tidy/analysis.ts';

export interface TidyOptionControlProps {
    optionKey: string;
    option: TidyOptionDescriptor;
    /** What clang-tidy will use: the override, or else the dumped/effective default. */
    value: string | null;
    overridden: boolean;
    provenance: TidyProvenance | undefined;
    impact: OptionImpact | undefined;
    impactStale: boolean;
    onChange: (key: string, value: string) => void;
    onReset: (key: string) => void;
}

/**
 * A text field that commits on Enter or blur rather than per keystroke. Every
 * commit costs a clang-tidy run, and a half-typed regex is not worth one.
 */
function CommitText({
    value,
    onCommit,
    placeholder,
    mono,
}: {
    value: string;
    onCommit: (next: string) => void;
    placeholder?: string;
    mono?: boolean;
}): React.JSX.Element {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const commit = (): void => {
        if (draft !== value) onCommit(draft);
    };
    return (
        <input
            type="text"
            className={mono ? 'mono' : undefined}
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setDraft(value);
            }}
        />
    );
}

function Editor({ optionKey, option, value, onChange }: TidyOptionControlProps): React.JSX.Element {
    const set = (next: string): void => onChange(optionKey, next);
    switch (option.kind) {
        case 'bool':
            return (
                <label className="switch">
                    <input
                        type="checkbox"
                        checked={parseTidyBool(value ?? 'false') ?? false}
                        onChange={(e) => set(e.target.checked ? 'true' : 'false')}
                    />
                    <span>{parseTidyBool(value ?? 'false') ? 'true' : 'false'}</span>
                </label>
            );
        case 'enum': {
            const choices = value !== null && !option.values.includes(value) ? [value, ...option.values] : option.values;
            return (
                <select value={value ?? ''} onChange={(e) => set(e.target.value)}>
                    {value === null && (
                        <option value="" disabled>
                            (not set)
                        </option>
                    )}
                    {choices.map((v) => (
                        <option key={v} value={v}>
                            {v}
                        </option>
                    ))}
                </select>
            );
        }
        case 'integer':
        case 'number':
            return (
                <input
                    type="number"
                    step={option.kind === 'integer' ? 1 : 'any'}
                    value={value ?? ''}
                    onChange={(e) => {
                        // A value clang-tidy cannot parse is at best ignored and, for a
                        // fragile option, crashes the run — so only numbers get through.
                        if (e.target.value !== '' && Number.isFinite(Number(e.target.value))) set(e.target.value);
                    }}
                />
            );
        case 'list':
            return <CommitText value={value ?? ''} onCommit={set} placeholder="a;b;c" mono />;
        case 'regex':
            return <CommitText value={value ?? ''} onCommit={set} placeholder="regular expression" mono />;
        default:
            return <CommitText value={value ?? ''} onCommit={set} />;
    }
}

export const TidyOptionControl = memo(function TidyOptionControl(props: TidyOptionControlProps): React.JSX.Element {
    const { optionKey, option, overridden, provenance, impact, impactStale, onReset } = props;
    const inert = impact?.verdict === 'inert' && !impactStale;
    return (
        <div className={`option compact ${inert ? 'inert' : ''} ${overridden ? 'overridden' : ''} ${impactStale ? 'stale' : ''}`}>
            <div className="option-head">
                <span className="option-name" title={`${optionKey}\n\n${option.doc}`}>
                    {option.name}
                </span>
                <span className="option-badges">
                    {impact?.verdict === 'live' && (
                        <span
                            className="badge live"
                            title={
                                impact.witness
                                    ? `Setting it to ${impact.witness.value}: ${impact.witness.added.length ? `+${impact.witness.added.length} ` : ''}${impact.witness.removed.length ? `−${impact.witness.removed.length} ` : ''}findings${impact.witness.hunk ? ', and a different fix' : ''}`
                                    : undefined
                            }
                        >
                            ±{impact.magnitude}
                        </span>
                    )}
                    {inert && <span className="badge dim">no effect here</span>}
                    {impact?.verdict === 'unknown' && (
                        <span className="badge dim" title="Free text — there is nothing to try automatically">
                            ?
                        </span>
                    )}
                    {provenance === 'rejected' && (
                        <span className="badge warn" title="clang-tidy refused this value and used its default">
                            rejected
                        </span>
                    )}
                    {provenance === 'inactive' && (
                        <span className="badge dim" title="This check is off, so the setting does nothing">
                            check off
                        </span>
                    )}
                    {overridden && (
                        <button className="reset" onClick={() => onReset(optionKey)} title="Back to clang-tidy's default">
                            ↺
                        </button>
                    )}
                </span>
            </div>
            <div className="option-editor">
                <Editor {...props} />
            </div>
            {option.default !== null && overridden && (
                <div className="assumes">default: {option.default === '' ? "''" : option.default}</div>
            )}
        </div>
    );
});
