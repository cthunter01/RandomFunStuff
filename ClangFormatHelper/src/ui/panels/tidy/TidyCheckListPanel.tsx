/**
 * The check rail: every clang-tidy check, grouped by module, with its switch,
 * what it found in your code, and its options.
 *
 * 602 checks is three times the format option count, so rows stay cheap: a
 * collapsed row is a checkbox, a name and a badge, and everything else renders
 * only when a row is expanded.
 */

import { memo, useEffect, useRef, useState } from 'react';
import type { CheckFindings } from '../../../core/tidy/analysis.ts';
import type { TidyCheckDescriptor, TidyTopLevelKey } from '../../../core/tidy/catalog.ts';
import { decidingGlob, formatChecks, parseChecks } from '../../../core/tidy/checks.ts';
import type { TidySettingValue } from '../../../core/tidy/config.ts';
import { useCheckRows, type CheckRow, type ModuleRows } from '../../hooks/useCheckRows.ts';
import { useTidyStore } from '../../state/tidyStore.tsx';
import { TidyOptionControl } from './TidyOptionControl.tsx';

/** Upstream documentation for a check. Unversioned: LLVM does not publish point-release docs. */
export function checkDocUrl(check: TidyCheckDescriptor): string {
    if (check.docPath) return `https://clang.llvm.org/extra/clang-tidy/checks/${check.docPath}.html`;
    return 'https://clang.llvm.org/docs/analyzer/checkers.html';
}

function TidyFilterBar({ shown, total }: { shown: number; total: number }): React.JSX.Element {
    const { state, dispatch } = useTidyStore();
    return (
        <div className="panel-toolbar">
            <input
                className="search"
                type="search"
                placeholder={`Search ${total} checks…`}
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
            <label className="check">
                <input
                    type="checkbox"
                    checked={state.hideSilent}
                    disabled={!state.survey}
                    title={state.survey ? undefined : 'Run the analysis first'}
                    onChange={(e) => dispatch({ type: 'hideSilent', value: e.target.checked })}
                />
                Hide silent
            </label>
            <label className="check">
                Order
                <select
                    aria-label="Check order"
                    value={state.sortMode}
                    onChange={(e) => dispatch({ type: 'sortMode', value: e.target.value as 'static' | 'findings' })}
                >
                    <option value="static">Grouped A–Z</option>
                    <option value="findings" disabled={!state.survey}>
                        By findings
                    </option>
                </select>
            </label>
            <span className="count">
                {shown} shown · {state.enabled?.size ?? '…'} enabled
            </span>
        </div>
    );
}

/** The raw `Checks:` line, editable for people who think in globs. */
function ChecksLine(): React.JSX.Element {
    const { state, dispatch } = useTidyStore();
    const current = formatChecks(state.doc.checks);
    const [draft, setDraft] = useState(current);
    useEffect(() => setDraft(current), [current]);
    const commit = (): void => {
        if (draft !== current) dispatch({ type: 'setChecks', checks: parseChecks(draft) });
    };
    const inheritsDefault = state.catalog && state.doc.checks[0]?.pattern !== '*';
    return (
        <div className="checks-line">
            <label>
                <span>Checks</span>
                <input
                    type="text"
                    className="mono"
                    aria-label="Checks globs"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commit();
                        if (e.key === 'Escape') setDraft(current);
                    }}
                />
            </label>
            {inheritsDefault && state.catalog && (
                <p className="hint">
                    clang-tidy puts <code>{state.catalog.defaultChecks}</code> in front of this, so compiler warnings
                    stay on unless the list starts with <code>-*</code>.
                </p>
            )}
        </div>
    );
}

function SettingEditor({ setting }: { setting: TidyTopLevelKey }): React.JSX.Element {
    const { state, dispatch } = useTidyStore();
    const value = state.doc.settings.get(setting.name);
    const set = (next: TidySettingValue | null): void => dispatch({ type: 'setSetting', key: setting.name, value: next });
    const fallback = setting.default === null ? '' : Array.isArray(setting.default) ? setting.default.join(', ') : String(setting.default);
    let editor: React.JSX.Element;
    if (setting.kind === 'bool') {
        editor = (
            <select
                value={value === undefined ? '' : String(value)}
                onChange={(e) => set(e.target.value === '' ? null : e.target.value === 'true')}
            >
                <option value="">default{setting.default !== null ? ` (${String(setting.default)})` : ''}</option>
                <option value="true">true</option>
                <option value="false">false</option>
            </select>
        );
    } else if (setting.kind === 'list') {
        editor = (
            <input
                type="text"
                className="mono"
                placeholder={fallback || 'comma separated'}
                value={Array.isArray(value) ? value.join(', ') : ''}
                onChange={(e) => {
                    const items = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                    set(items.length > 0 ? items : null);
                }}
            />
        );
    } else if (setting.kind === 'string') {
        editor = (
            <input
                type="text"
                className="mono"
                placeholder={fallback === '' ? "''" : fallback}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => set(e.target.value === '' ? null : e.target.value)}
            />
        );
    } else {
        editor = <span className="muted">edit in the file</span>;
    }
    return (
        <div className={`option compact ${value !== undefined ? 'overridden' : ''}`}>
            <div className="option-head">
                <span className="option-name" title={setting.doc}>
                    {setting.name}
                </span>
                {value !== undefined && (
                    <button className="reset" onClick={() => set(null)} title="Remove from the file">
                        ↺
                    </button>
                )}
            </div>
            <div className="option-editor">{editor}</div>
        </div>
    );
}

function FileSettings(): React.JSX.Element | null {
    const { state } = useTidyStore();
    if (!state.catalog) return null;
    const settings = state.catalog.topLevelKeys.filter((k) => k.name !== 'Checks' && k.name !== 'CheckOptions');
    return (
        <details className="file-settings">
            <summary>
                File settings <span className="count">({state.doc.settings.size} set)</span>
            </summary>
            {settings.map((s) => (
                <SettingEditor key={s.name} setting={s} />
            ))}
        </details>
    );
}

function FindingList({ findings, limit = 5 }: { findings: CheckFindings; limit?: number }): React.JSX.Element {
    const { dispatch } = useTidyStore();
    return (
        <ul className="finding-list">
            {findings.diagnostics.slice(0, limit).map((d, i) => (
                <li key={i}>
                    <button
                        className="linklike"
                        onClick={() => d.span && dispatch({ type: 'focusLine', line: d.span.line })}
                        disabled={!d.span}
                    >
                        {d.span ? `L${d.span.line}` : 'header'}
                    </button>{' '}
                    {d.message}
                </li>
            ))}
            {findings.diagnostics.length > limit && (
                <li className="muted">…and {findings.diagnostics.length - limit} more</li>
            )}
        </ul>
    );
}

function CheckDetail({ row }: { row: CheckRow }): React.JSX.Element {
    const { state, dispatch } = useTidyStore();
    const { check } = row;
    const builtin = state.catalog ? parseChecks(state.catalog.defaultChecks) : [];
    const decided = decidingGlob(state.doc.checks, check.name, builtin);
    const set = (key: string, value: string): void => dispatch({ type: 'setOption', key, value });
    const reset = (key: string): void => dispatch({ type: 'clearOption', key });
    return (
        <div className="option-detail">
            <p className="doc">{check.summary}</p>
            <p className="meta">
                {decided
                    ? `${decided.glob.enable ? 'on' : 'off'} because of ${decided.glob.enable ? '' : '-'}${decided.glob.pattern}${decided.builtin ? " (clang-tidy's default)" : ''}`
                    : 'off: no glob in Checks matches it'}
                {check.aliasOf && ` · alias of ${check.aliasOf}; with both on, each finding is reported once`}
                {check.offersFixes && ' · offers fixes'} ·{' '}
                <a href={checkDocUrl(check)} target="_blank" rel="noreferrer">
                    docs ↗
                </a>
            </p>
            {row.findings && <FindingList findings={row.findings} />}
            {check.options.length > 0 && (
                <div className="nested-fields">
                    {check.options.map((option) => {
                        const key = `${check.name}.${option.name}`;
                        const override = state.doc.options.get(key);
                        return (
                            <TidyOptionControl
                                key={key}
                                optionKey={key}
                                option={option}
                                value={override ?? state.effective?.values.get(key) ?? option.default}
                                overridden={override !== undefined}
                                provenance={state.effective?.provenance.get(key)}
                                impact={state.impact?.get(key)}
                                impactStale={state.analysisStale}
                                onChange={set}
                                onReset={reset}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

const CheckRowView = memo(function CheckRowView({
    row,
    expanded,
    stale,
    onToggle,
    onExpand,
}: {
    row: CheckRow;
    expanded: boolean;
    stale: boolean;
    onToggle: (check: string, enable: boolean) => void;
    onExpand: (check: string | null) => void;
}): React.JSX.Element {
    const { check, enabled, findings, silent } = row;
    return (
        <div className={`check-row ${enabled ? 'on' : ''} ${silent && !stale ? 'silent' : ''} ${stale ? 'stale' : ''}`}>
            <button
                className="disclosure"
                onClick={() => onExpand(expanded ? null : check.name)}
                aria-expanded={expanded}
                aria-label={`Details for ${check.name}`}
            >
                {expanded ? '▾' : '▸'}
            </button>
            <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => onToggle(check.name, e.target.checked)}
                aria-label={`Enable ${check.name}`}
            />
            <span className="check-name" title={check.summary}>
                {check.name}
            </span>
            <span className="option-badges">
                {findings && (
                    <span className="badge live" title={findings.via ? `Same findings as ${findings.via}` : undefined}>
                        {findings.diagnostics.length}
                    </span>
                )}
                {silent && <span className="badge dim">silent</span>}
                {check.aliasOf && <span className="badge dim">alias</span>}
                {check.offersFixes && <span className="badge fix">fix</span>}
                {check.options.length > 0 && (
                    <span className="badge dim" title={`${check.options.length} options`}>
                        ⚙{check.options.length}
                    </span>
                )}
            </span>
        </div>
    );
});

function ModuleHeader({ group }: { group: ModuleRows }): React.JSX.Element {
    const { dispatch } = useTidyStore();
    const box = useRef<HTMLInputElement>(null);
    const all = group.enabledCount === group.total;
    const some = group.enabledCount > 0 && !all;
    useEffect(() => {
        if (box.current) box.current.indeterminate = some;
    }, [some]);
    return (
        <h3 className="module-head" title={group.description}>
            <input
                ref={box}
                type="checkbox"
                checked={all}
                onChange={(e) => dispatch({ type: 'setModule', module: group.module, enable: e.target.checked })}
                aria-label={`Enable all ${group.module} checks`}
            />
            <span>{group.module}</span>
            <span className="count">
                {group.enabledCount}/{group.total} on
            </span>
        </h3>
    );
}

export function TidyCheckListPanel(): React.JSX.Element {
    const { state, dispatch } = useTidyStore();
    const { modules, total, shown } = useCheckRows();
    const onToggle = (check: string, enable: boolean): void => dispatch({ type: 'setCheck', check, enable });
    const onExpand = (check: string | null): void => dispatch({ type: 'expand', check });
    return (
        <div className="panel option-list">
            <TidyFilterBar shown={shown} total={total} />
            <div className="option-scroll">
                <ChecksLine />
                <FileSettings />
                {modules
                    .filter((m) => m.rows.length > 0)
                    .map((group) => (
                        <section key={group.module} className="option-group">
                            <ModuleHeader group={group} />
                            {group.rows.map((row) => (
                                <div key={row.check.name}>
                                    <CheckRowView
                                        row={row}
                                        expanded={state.expanded === row.check.name}
                                        stale={state.analysisStale}
                                        onToggle={onToggle}
                                        onExpand={onExpand}
                                    />
                                    {state.expanded === row.check.name && <CheckDetail row={row} />}
                                </div>
                            ))}
                        </section>
                    ))}
                {shown === 0 && <p className="empty">Nothing matches that filter.</p>}
            </div>
        </div>
    );
}

export { FindingList };
