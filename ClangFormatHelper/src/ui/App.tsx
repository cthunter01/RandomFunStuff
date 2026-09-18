import { StoreProvider, useStore } from './state/store.tsx';
import { TidyStoreProvider } from './state/tidyStore.tsx';
import { Toolbar } from './panels/Toolbar.tsx';
import { getLayout } from './layouts/registry.tsx';
import { useActiveTool } from './tools/registry.tsx';
import './styles/app.css';

function Shell(): React.JSX.Element {
    const { state } = useStore();
    const layout = getLayout(state.layoutId);
    const { Gate } = useActiveTool().panels;
    return (
        <div className="app">
            <Toolbar />
            <Gate>
                <layout.Component />
            </Gate>
        </div>
    );
}

export function App(): React.JSX.Element {
    return (
        <StoreProvider>
            <TidyStoreProvider>
                <Shell />
            </TidyStoreProvider>
        </StoreProvider>
    );
}
