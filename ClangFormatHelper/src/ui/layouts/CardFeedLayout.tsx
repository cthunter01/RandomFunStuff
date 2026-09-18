/**
 * Sample docked at the top, a scrolling feed of cards below — each card showing
 * what that setting would do to the code above it.
 */

import { useState } from 'react';
import { useActiveTool } from '../tools/registry.tsx';

export function CardFeedLayout(): React.JSX.Element {
    const [showFile, setShowFile] = useState(false);
    const tool = useActiveTool();
    const { CardFeed, Sample, File } = tool.panels;
    return (
        <div className="layout card-feed-layout">
            <section className="docked">
                <nav className="tabs">
                    <button className={!showFile ? 'active' : ''} onClick={() => setShowFile(false)}>
                        Your code
                    </button>
                    <button className={showFile ? 'active' : ''} onClick={() => setShowFile(true)}>
                        {tool.fileName}
                    </button>
                </nav>
                {showFile ? <File /> : <Sample />}
            </section>
            <section className="feed">
                <CardFeed />
            </section>
        </div>
    );
}
