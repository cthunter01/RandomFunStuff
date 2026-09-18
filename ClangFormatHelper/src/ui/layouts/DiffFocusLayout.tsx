/**
 * Two panes with the diff given as much room as possible, and the generated file
 * tucked into a drawer that slides up when wanted.
 */

import { useState } from 'react';
import { OptionListPanel } from '../panels/OptionListPanel.tsx';
import { DiffPanel, YamlPanel } from '../panels/CodePanels.tsx';
import { SamplePanel } from '../panels/CodePanels.tsx';

export function DiffFocusLayout(): React.JSX.Element {
    const [drawer, setDrawer] = useState(false);
    const [editing, setEditing] = useState(false);
    return (
        <div className={`layout diff-focus ${drawer ? 'drawer-open' : ''}`}>
            <aside className="pane left">
                <OptionListPanel density="compact" />
            </aside>
            <main className="pane main">
                <nav className="tabs">
                    <button className={!editing ? 'active' : ''} onClick={() => setEditing(false)}>
                        Diff vs base
                    </button>
                    <button className={editing ? 'active' : ''} onClick={() => setEditing(true)}>
                        Edit sample
                    </button>
                </nav>
                {editing ? <SamplePanel /> : <DiffPanel />}
            </main>
            <section className="drawer">
                <button className="drawer-handle" onClick={() => setDrawer((d) => !d)} aria-expanded={drawer}>
                    {drawer ? '▾' : '▴'} .clang-format
                </button>
                {drawer && <YamlPanel />}
            </section>
        </div>
    );
}
