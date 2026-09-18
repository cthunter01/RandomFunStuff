/**
 * Three panes: settings, code, generated file — everything visible at once.
 * The centre pane is tabbed so the sample, the result, the diff and the
 * documentation share the same space.
 */

import { useState } from 'react';
import { useActiveTool } from '../tools/registry.tsx';

type Tab = 'sample' | 'result' | 'diff' | 'doc';

export function WorkbenchLayout(): React.JSX.Element {
    const [tab, setTab] = useState<Tab>('sample');
    const tool = useActiveTool();
    const { Rail, Sample, Result, Diff, Doc, File } = tool.panels;
    return (
        <div className="layout workbench">
            <aside className="pane left">
                <Rail density="compact" />
            </aside>
            <main className="pane center">
                <nav className="tabs">
                    {(
                        [
                            ['sample', 'Your code'],
                            ['result', tool.resultLabel],
                            ['diff', tool.diffLabel],
                            ['doc', tool.id === 'format' ? 'Doc example' : 'Check docs'],
                        ] as const
                    ).map(([id, label]) => (
                        <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                            {label}
                        </button>
                    ))}
                </nav>
                {tab === 'sample' && <Sample />}
                {tab === 'result' && <Result />}
                {tab === 'diff' && <Diff />}
                {tab === 'doc' && <Doc />}
            </main>
            <aside className="pane right">
                <File />
            </aside>
        </div>
    );
}
