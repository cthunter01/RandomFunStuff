/**
 * Sample docked at the top, a scrolling feed of option cards below — each card
 * showing what that option would do to the code above it.
 */

import { useState } from 'react';
import { OptionCardFeedPanel } from '../panels/OptionCardFeedPanel.tsx';
import { SamplePanel, YamlPanel } from '../panels/CodePanels.tsx';

export function CardFeedLayout(): React.JSX.Element {
    const [showYaml, setShowYaml] = useState(false);
    return (
        <div className="layout card-feed-layout">
            <section className="docked">
                <nav className="tabs">
                    <button className={!showYaml ? 'active' : ''} onClick={() => setShowYaml(false)}>
                        Your code
                    </button>
                    <button className={showYaml ? 'active' : ''} onClick={() => setShowYaml(true)}>
                        .clang-format
                    </button>
                </nav>
                {showYaml ? <YamlPanel /> : <SamplePanel />}
            </section>
            <section className="feed">
                <OptionCardFeedPanel />
            </section>
        </div>
    );
}
