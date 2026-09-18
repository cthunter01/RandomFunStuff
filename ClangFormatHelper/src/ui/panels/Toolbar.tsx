/**
 * The app-level controls: which tool, what you are configuring, and how you want
 * to look at it.
 *
 * The tool and layout switchers live here because both are views over shared
 * state — switching either keeps every bit of it, which is the point. Everything
 * tool-specific comes from the active tool's own toolbar slots.
 */

import { useStore, type LayoutId, type ThemeChoice, type ToolId } from '../state/store.tsx';
import { listLanguages } from '../../core/languages/registry.ts';
import { layouts } from '../layouts/registry.tsx';
import { tools, useActiveTool } from '../tools/registry.tsx';

export function Toolbar(): React.JSX.Element {
    const { state, dispatch } = useStore();
    const tool = useActiveTool();
    const { ToolbarControls, ToolbarStatus } = tool.panels;

    return (
        <header className="toolbar">
            <div className="brand">
                <strong>{tool.label} Helper</strong>
                <span className="version">builds a {tool.fileName}</span>
            </div>

            <div className="tool-switch" role="tablist" aria-label="Tool">
                {tools.map((t) => (
                    <button
                        key={t.id}
                        role="tab"
                        aria-selected={t.id === state.toolId}
                        className={t.id === state.toolId ? 'active' : ''}
                        onClick={() => dispatch({ type: 'setTool', value: t.id as ToolId })}
                    >
                        {t.label}
                    </button>
                ))}
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

            <ToolbarControls />

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

            <ToolbarStatus />
        </header>
    );
}
