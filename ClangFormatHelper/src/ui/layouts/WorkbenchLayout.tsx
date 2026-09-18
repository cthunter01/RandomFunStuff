/**
 * Three panes: options, code, generated file — everything visible at once.
 * The centre pane is tabbed so the sample, the diff and the option's official
 * example share the same space.
 */

import { useState } from 'react';
import { OptionListPanel } from '../panels/OptionListPanel.tsx';
import { DiffPanel, DocExamplePanel, FormattedPanel, SamplePanel, YamlPanel } from '../panels/CodePanels.tsx';

type Tab = 'sample' | 'formatted' | 'diff' | 'doc';

export function WorkbenchLayout(): React.JSX.Element {
    const [tab, setTab] = useState<Tab>('sample');
    return (
        <div className="layout workbench">
            <aside className="pane left">
                <OptionListPanel density="compact" />
            </aside>
            <main className="pane center">
                <nav className="tabs">
                    {(
                        [
                            ['sample', 'Your code'],
                            ['formatted', 'Formatted'],
                            ['diff', 'Diff vs base'],
                            ['doc', 'Doc example'],
                        ] as const
                    ).map(([id, label]) => (
                        <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                            {label}
                        </button>
                    ))}
                </nav>
                {tab === 'sample' && <SamplePanel />}
                {tab === 'formatted' && <FormattedPanel />}
                {tab === 'diff' && <DiffPanel />}
                {tab === 'doc' && <DocExamplePanel />}
            </main>
            <aside className="pane right">
                <YamlPanel />
            </aside>
        </div>
    );
}
