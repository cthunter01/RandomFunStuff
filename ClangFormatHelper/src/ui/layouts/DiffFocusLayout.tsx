/**
 * Two panes with the comparison given as much room as possible, and the
 * generated file tucked into a drawer that slides up when wanted.
 */

import { useState } from 'react';
import { useActiveTool } from '../tools/registry.tsx';

export function DiffFocusLayout(): React.JSX.Element {
    const [drawer, setDrawer] = useState(false);
    const [editing, setEditing] = useState(false);
    const tool = useActiveTool();
    const { Rail, Sample, Diff, File } = tool.panels;
    return (
        <div className={`layout diff-focus ${drawer ? 'drawer-open' : ''}`}>
            <aside className="pane left">
                <Rail density="compact" />
            </aside>
            <main className="pane main">
                <nav className="tabs">
                    <button className={!editing ? 'active' : ''} onClick={() => setEditing(false)}>
                        {tool.diffLabel}
                    </button>
                    <button className={editing ? 'active' : ''} onClick={() => setEditing(true)}>
                        Edit sample
                    </button>
                </nav>
                {editing ? <Sample /> : <Diff />}
            </main>
            <section className="drawer">
                <button className="drawer-handle" onClick={() => setDrawer((d) => !d)} aria-expanded={drawer}>
                    {drawer ? '▾' : '▴'} {tool.fileName}
                </button>
                {drawer && <File />}
            </section>
        </div>
    );
}
