import { StoreProvider, useStore } from './state/store.tsx';
import { Toolbar } from './panels/Toolbar.tsx';
import { getLayout } from './layouts/registry.tsx';
import './styles/app.css';

function Shell(): React.JSX.Element {
    const { state } = useStore();
    const layout = getLayout(state.layoutId);
    return (
        <div className="app">
            <Toolbar />
            {state.status === 'booting' && (
                <div className="boot">
                    <p>Loading clang-format (a one-time ~860 KB download)…</p>
                </div>
            )}
            {state.status === 'error' && <div className="boot error">Could not start clang-format: {state.error}</div>}
            {state.status === 'ready' && <layout.Component />}
        </div>
    );
}

export function App(): React.JSX.Element {
    return (
        <StoreProvider>
            <Shell />
        </StoreProvider>
    );
}
