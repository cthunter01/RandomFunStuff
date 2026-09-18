/**
 * Search and filtering for the option list.
 *
 * Shared by the rail and the card feed. The filter lives in the store, so it
 * survives a layout switch — which means every layout that shows options must
 * also offer a way to clear it, or a user can end up stuck behind a filter they
 * set somewhere else.
 */

import { useStore } from '../state/store.tsx';
import type { SortMode } from '../hooks/ordering.ts';

export function OptionFilterBar({ shown, total }: { shown: number; total: number }): React.JSX.Element {
    const { state, dispatch } = useStore();
    return (
        <div className="panel-toolbar">
            <input
                className="search"
                type="search"
                placeholder={`Search ${total} options…`}
                value={state.search}
                onChange={(e) => dispatch({ type: 'search', value: e.target.value })}
            />
            <label className="check">
                <input
                    type="checkbox"
                    checked={state.hideInert}
                    onChange={(e) => dispatch({ type: 'hideInert', value: e.target.checked })}
                    disabled={!state.impact}
                    title={state.impact ? undefined : 'Run the analysis first'}
                />
                Hide no-effect
            </label>
            <label className="check">
                <input
                    type="checkbox"
                    checked={state.onlyOverridden}
                    onChange={(e) => dispatch({ type: 'onlyOverridden', value: e.target.checked })}
                />
                Only changed
            </label>
            <label className="check">
                Order
                <select
                    aria-label="Option order"
                    value={state.sortMode}
                    onChange={(e) => dispatch({ type: 'setSortMode', value: e.target.value as SortMode })}
                >
                    <option value="static">Grouped A–Z</option>
                    <option value="impact" disabled={!state.impact}>
                        By impact
                    </option>
                </select>
            </label>
            <span className="count">
                {shown} shown · {state.doc.overrides.size} changed
            </span>
        </div>
    );
}
