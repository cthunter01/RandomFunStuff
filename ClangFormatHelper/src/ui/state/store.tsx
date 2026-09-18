/**
 * The single source of truth for the app.
 *
 * All three layouts read and write this one store, which is what makes switching
 * layouts a pure change of arrangement rather than a state migration. Panels are
 * given no state of their own for the same reason.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import catalogJson from '../../core/catalog/generated/options.23.1.1.json' with { type: 'json' };
import type { OptionCatalog } from '../../core/catalog/types.ts';
import type { BaseStyle } from '../../core/catalog/types.ts';
import { clearOverride, createDocument, setOverride, type ConfigValue, type StyleDocument } from '../../core/config/model.ts';
import { fromFileText, toFileText, toInlineStyle } from '../../core/config/serialize.ts';
import { resolveEffective, type EffectiveConfig } from '../../core/config/effective.ts';
import { evaluateConstraints, verdictsByPath, type Verdict } from '../../core/config/constraints.ts';
import { analyseImpact, type ImpactMap } from '../../core/analysis/impact.ts';
import type { SortMode } from '../hooks/ordering.ts';
import { DEFAULT_LANGUAGE_ID, getLanguage, listLanguages } from '../../core/languages/registry.ts';
import { createFormatterClient, type FormatterClient } from '../../worker/client.ts';

export const catalog = catalogJson as unknown as OptionCatalog;

/** Every settable dotted path, used when importing an existing file. */
const KNOWN_PATHS = new Set<string>(
    catalog.options.flatMap((o) => [o.name, ...o.fields.map((f) => `${o.name}.${f.name}`)]),
);

export type LayoutId = 'workbench' | 'diff-focus' | 'card-feed';

/** `system` follows the OS; the other two override it. */
export type ThemeChoice = 'system' | 'light' | 'dark';

const THEME_KEY = 'cfh.theme';

function storedTheme(): ThemeChoice {
    try {
        const value = localStorage.getItem(THEME_KEY);
        return value === 'light' || value === 'dark' ? value : 'system';
    } catch {
        return 'system';
    }
}

/**
 * Drives the `data-theme` attribute the stylesheet keys off. Removing it entirely
 * for `system` is deliberate — that lets `color-scheme: light dark` fall back to
 * the OS preference rather than pinning whatever it happened to be at load.
 */
function applyTheme(choice: ThemeChoice): void {
    const root = document.documentElement;
    if (choice === 'system') delete root.dataset['theme'];
    else root.dataset['theme'] = choice;
    try {
        if (choice === 'system') localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, choice);
    } catch {
        /* private mode: the choice just will not persist */
    }
}

export interface AppState {
    doc: StyleDocument;
    samples: Record<string, string>;
    layoutId: LayoutId;
    theme: ThemeChoice;
    /** Formatted output for the current sample and config. */
    formatted: string;
    /** The same sample under the untouched base style, for "what did my tweaks do?". */
    baseFormatted: string;
    effective: EffectiveConfig | null;
    verdicts: Map<string, Verdict[]>;
    impact: ImpactMap | null;
    /**
     * True when the config or sample moved since the analysis ran.
     *
     * The results are deliberately *kept* rather than discarded. Throwing them away
     * on every edit wiped every badge and — because the list could be ranked by
     * impact — reshuffled the whole rail underneath the row being edited.
     */
    impactStale: boolean;
    impactProgress: { done: number; total: number } | null;
    sortMode: SortMode;
    search: string;
    hideInert: boolean;
    onlyOverridden: boolean;
    expanded: string | null;
    status: 'booting' | 'ready' | 'error';
    error: string | null;
    importNotice: string | null;
}

type Action =
    | { type: 'setBaseStyle'; value: BaseStyle }
    | { type: 'setLanguage'; value: string }
    | { type: 'setOverride'; path: string; value: ConfigValue }
    | { type: 'clearOverride'; path: string }
    | { type: 'replaceDoc'; doc: StyleDocument; notice: string | null }
    | { type: 'resetAll' }
    | { type: 'setSample'; languageId: string; code: string }
    | { type: 'setLayout'; value: LayoutId }
    | { type: 'setTheme'; value: ThemeChoice }
    | { type: 'setSortMode'; value: SortMode }
    | { type: 'formatted'; current: string; base: string }
    | { type: 'effective'; effective: EffectiveConfig; verdicts: Map<string, Verdict[]> }
    | { type: 'impact'; map: ImpactMap | null }
    | { type: 'impactProgress'; done: number; total: number }
    | { type: 'search'; value: string }
    | { type: 'hideInert'; value: boolean }
    | { type: 'onlyOverridden'; value: boolean }
    | { type: 'expand'; path: string | null }
    | { type: 'status'; status: AppState['status']; error?: string };

function initialState(): AppState {
    const samples: Record<string, string> = {};
    for (const language of listLanguages()) {
        const sample = language.samples.find((s) => s.id === language.defaultSampleId) ?? language.samples[0];
        samples[language.id] = sample?.code ?? '';
    }
    return {
        doc: createDocument(DEFAULT_LANGUAGE_ID, 'LLVM'),
        samples,
        layoutId: (localStorage.getItem('cfh.layout') as LayoutId | null) ?? 'workbench',
        theme: storedTheme(),
        formatted: '',
        baseFormatted: '',
        effective: null,
        verdicts: new Map(),
        impact: null,
        impactStale: false,
        impactProgress: null,
        sortMode: (localStorage.getItem('cfh.sort') as SortMode | null) ?? 'static',
        search: '',
        hideInert: false,
        onlyOverridden: false,
        expanded: null,
        status: 'booting',
        error: null,
        importNotice: null,
    };
}

function reducer(state: AppState, action: Action): AppState {
    switch (action.type) {
        case 'setBaseStyle':
            return { ...state, doc: { ...state.doc, baseStyle: action.value }, impactStale: true };
        case 'setLanguage':
            return { ...state, doc: { ...state.doc, languageId: action.value }, impact: null, impactStale: false };
        case 'setOverride':
            return { ...state, doc: setOverride(state.doc, action.path, action.value), impactStale: true };
        case 'clearOverride':
            return { ...state, doc: clearOverride(state.doc, action.path), impactStale: true };
        case 'replaceDoc':
            return { ...state, doc: action.doc, impactStale: true, importNotice: action.notice };
        case 'resetAll':
            return { ...state, doc: createDocument(state.doc.languageId, state.doc.baseStyle), impactStale: true };
        case 'setSample':
            return { ...state, samples: { ...state.samples, [action.languageId]: action.code }, impactStale: true };
        case 'setLayout':
            localStorage.setItem('cfh.layout', action.value);
            return { ...state, layoutId: action.value };
        case 'setTheme':
            return { ...state, theme: action.value };
        case 'setSortMode':
            localStorage.setItem('cfh.sort', action.value);
            return { ...state, sortMode: action.value };
        case 'formatted':
            return { ...state, formatted: action.current, baseFormatted: action.base };
        case 'effective':
            return { ...state, effective: action.effective, verdicts: action.verdicts };
        case 'impact':
            return { ...state, impact: action.map, impactStale: false, impactProgress: null };
        case 'impactProgress':
            return { ...state, impactProgress: { done: action.done, total: action.total } };
        case 'search':
            return { ...state, search: action.value };
        case 'hideInert':
            return { ...state, hideInert: action.value };
        case 'onlyOverridden':
            return { ...state, onlyOverridden: action.value };
        case 'expand':
            return { ...state, expanded: action.path };
        case 'status':
            return { ...state, status: action.status, error: action.error ?? null };
        default:
            return state;
    }
}

interface StoreValue {
    state: AppState;
    dispatch: (action: Action) => void;
    client: FormatterClient;
    sample: string;
    fileText: string;
    runImpact: () => void;
    importFile: (text: string) => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
    const [state, dispatch] = useReducer(reducer, undefined, initialState);
    const clientRef = useRef<FormatterClient | null>(null);
    clientRef.current ??= createFormatterClient();
    const client = clientRef.current;

    const language = getLanguage(state.doc.languageId);
    const sample = state.samples[state.doc.languageId] ?? '';
    const fileText = useMemo(() => toFileText(state.doc), [state.doc]);
    const inlineStyle = useMemo(() => toInlineStyle(state.doc), [state.doc]);

    // The inline script in index.html normally applies the saved theme before first
    // paint. A strict Content-Security-Policy without that script's hash blocks it,
    // and then the page would render in the wrong theme while the menu claimed
    // otherwise. So the app applies it too: under such a policy you get a brief
    // flash, never a wrong theme. (Kept out of the reducer, which StrictMode runs twice.)
    useEffect(() => {
        applyTheme(state.theme);
    }, [state.theme]);

    useEffect(() => {
        let cancelled = false;
        client.ready
            .then(() => !cancelled && dispatch({ type: 'status', status: 'ready' }))
            .catch((e: Error) => !cancelled && dispatch({ type: 'status', status: 'error', error: e.message }));
        return () => {
            cancelled = true;
        };
    }, [client]);

    // Formatting is debounced: typing in the sample should not queue a format per
    // keystroke, and the result of a superseded one is thrown away anyway.
    useEffect(() => {
        if (state.status !== 'ready') return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const [current, base] = await Promise.all([
                        client.format({ code: sample, filename: language.probeFilename, style: inlineStyle }),
                        client.format({
                            code: sample,
                            filename: language.probeFilename,
                            style: state.doc.baseStyle,
                        }),
                    ]);
                    if (cancelled) return;
                    dispatch({
                        type: 'formatted',
                        current: current.status === 'changed' ? (current.text ?? sample) : sample,
                        base: base.status === 'changed' ? (base.text ?? sample) : sample,
                    });
                } catch (error) {
                    if (!cancelled) {
                        dispatch({ type: 'status', status: 'ready', error: (error as Error).message });
                    }
                }
            })();
        }, 120);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [client, sample, inlineStyle, state.doc.baseStyle, state.status, language.probeFilename]);

    // Effective config comes from the binary, never from our own defaults, so the
    // values shown include anything clang-format derived on its own.
    useEffect(() => {
        if (state.status !== 'ready') return undefined;
        let cancelled = false;
        void (async () => {
            try {
                const [currentDump, baseDump] = await Promise.all([
                    client.dumpConfig(inlineStyle, language.probeFilename),
                    client.dumpConfig(state.doc.baseStyle, language.probeFilename),
                ]);
                if (cancelled) return;
                const effective = resolveEffective(state.doc, baseDump, currentDump);
                const verdicts = verdictsByPath(evaluateConstraints({ doc: state.doc, effective, catalog }));
                dispatch({ type: 'effective', effective, verdicts });
            } catch {
                /* a rejected config is reported through the format path instead */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [client, inlineStyle, state.doc, state.status, language.probeFilename]);

    const impactRun = useRef<AbortController | null>(null);
    const runImpact = useCallback(() => {
        impactRun.current?.abort();
        const controller = new AbortController();
        impactRun.current = controller;
        void analyseImpact({
            catalog,
            doc: state.doc,
            code: sample,
            filename: language.probeFilename,
            port: client,
            signal: controller.signal,
            onProgress: (done, total) => dispatch({ type: 'impactProgress', done, total }),
        })
            .then((map) => {
                if (!controller.signal.aborted) dispatch({ type: 'impact', map });
            })
            .catch(() => dispatch({ type: 'impact', map: null }));
    }, [client, sample, state.doc, language.probeFilename]);

    const importFile = useCallback(
        async (text: string) => {
            const declared = /BasedOnStyle:\s*(\w+)/.exec(text)?.[1] as BaseStyle | undefined;
            const baseStyle = declared ?? 'LLVM';
            const baseDump = await client.dumpConfig(baseStyle, language.probeFilename);
            const parsed = fromFileText(text, baseDump, KNOWN_PATHS);
            dispatch({
                type: 'replaceDoc',
                doc: { languageId: state.doc.languageId, baseStyle, overrides: parsed.overrides },
                notice:
                    parsed.unknownKeys.length > 0
                        ? `Ignored ${parsed.unknownKeys.length} key(s) clang-format ${catalog.clangFormatVersion} does not know: ${parsed.unknownKeys.join(', ')}`
                        : null,
            });
        },
        [client, language.probeFilename, state.doc.languageId],
    );

    const value = useMemo<StoreValue>(
        () => ({ state, dispatch, client, sample, fileText, runImpact, importFile }),
        [state, client, sample, fileText, runImpact, importFile],
    );
    return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
    const value = useContext(StoreContext);
    if (!value) throw new Error('useStore must be used inside StoreProvider');
    return value;
}
