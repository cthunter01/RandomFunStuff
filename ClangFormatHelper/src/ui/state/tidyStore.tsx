/**
 * State for the clang-tidy tool.
 *
 * Kept apart from the format store, but not independent of it: the sample code,
 * the language, the layout and the theme are shared and stay in `store.tsx`, so
 * switching tools keeps your code. This store holds what only Tidy has — the
 * `.clang-tidy` being built, the live findings, and the analysis.
 *
 * Nothing here costs anything until Tidy is first opened. The 1.2 MB check
 * catalog is a dynamic import and the workers (about 9 MB of wasm and headers, compressed) start
 * on first activation, so a clang-format user never downloads either.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import type { TidyCatalog, TidyOptionKind } from '../../core/tidy/catalog.ts';
import { formatChecks, parseChecks, setCheck, setFamily, type CheckGlob } from '../../core/tidy/checks.ts';
import {
    clearOption,
    createTidyDocument,
    fromTidyFileText,
    resolveTidyEffective,
    setOption,
    setSetting,
    TIDY_PRESETS,
    toConfigJson,
    toTidyFileText,
    withChecks,
    type TidyDocument,
    type TidyEffective,
    type TidySettingValue,
} from '../../core/tidy/config.ts';
import { survey as runSurvey, sweepOptions, type OptionImpactMap, type Survey } from '../../core/tidy/analysis.ts';
import { splitFlags, tidyFilename } from '../../core/tidy/flags.ts';
import type { TidyOutcome } from '../../core/tidy/port.ts';
import { getLanguage, listLanguages } from '../../core/languages/registry.ts';
import { createTidyClient, type TidyClient } from '../../worker/tidy/client.ts';
import { useStore } from './store.tsx';
import type { TidySortMode } from '../hooks/tidyOrdering.ts';

export type { TidySortMode };

export interface TidyAnalysisProgress {
    phase: 'survey' | 'options';
    done: number;
    total: number;
}

export interface TidyState {
    catalog: TidyCatalog | null;
    status: 'idle' | 'booting' | 'ready' | 'error';
    error: string | null;
    doc: TidyDocument;
    /** Compiler flags per language id, as typed. */
    flags: Record<string, string>;
    /** Findings under the current config. */
    live: TidyOutcome | null;
    liveRunning: boolean;
    /** The config or sample moved since `live` was computed; a new run is coming. */
    liveStale: boolean;
    liveError: string | null;
    effective: TidyEffective | null;
    /** What `--list-checks` says is enabled — the authority, not the glob model. */
    enabled: ReadonlySet<string> | null;
    survey: Survey | null;
    impact: OptionImpactMap | null;
    /** Kept, not discarded, when the config or sample changes: see the format store. */
    analysisStale: boolean;
    analysis: TidyAnalysisProgress | null;
    analysisError: string | null;
    search: string;
    onlyEnabled: boolean;
    hideSilent: boolean;
    sortMode: TidySortMode;
    /** The expanded check in the rail, which the doc panel also follows. */
    expanded: string | null;
    /** A finding's line the user picked, highlighted in the sample. 1-based. */
    focusLine: number | null;
    importNotice: string | null;
}

type Action =
    | { type: 'catalog'; catalog: TidyCatalog }
    | { type: 'status'; status: TidyState['status']; error?: string }
    | { type: 'replaceDoc'; doc: TidyDocument; notice: string | null }
    | { type: 'setChecks'; checks: readonly CheckGlob[] }
    | { type: 'setCheck'; check: string; enable: boolean }
    | { type: 'setModule'; module: string; enable: boolean }
    | { type: 'setOption'; key: string; value: string }
    | { type: 'clearOption'; key: string }
    | { type: 'setSetting'; key: string; value: TidySettingValue | null }
    | { type: 'setFlags'; languageId: string; flags: string }
    | { type: 'liveStarted' }
    | { type: 'live'; outcome: TidyOutcome | null; error: string | null }
    | { type: 'effective'; effective: TidyEffective; enabled: ReadonlySet<string> }
    | { type: 'inputsChanged' }
    | { type: 'analysisProgress'; progress: TidyAnalysisProgress }
    | { type: 'survey'; survey: Survey }
    | { type: 'impact'; impact: OptionImpactMap | null; error?: string | null }
    | { type: 'search'; value: string }
    | { type: 'onlyEnabled'; value: boolean }
    | { type: 'hideSilent'; value: boolean }
    | { type: 'sortMode'; value: TidySortMode }
    | { type: 'expand'; check: string | null }
    | { type: 'focusLine'; line: number | null };

const SORT_KEY = 'cfh.tidy.sort';

function initialState(): TidyState {
    const flags: Record<string, string> = {};
    for (const language of listLanguages()) if (language.tidy) flags[language.id] = language.tidy.compileFlags;
    let sortMode: TidySortMode = 'static';
    try {
        sortMode = localStorage.getItem(SORT_KEY) === 'findings' ? 'findings' : 'static';
    } catch {
        /* private mode */
    }
    return {
        catalog: null,
        status: 'idle',
        error: null,
        doc: createTidyDocument(),
        flags,
        live: null,
        liveRunning: false,
        liveStale: true,
        liveError: null,
        effective: null,
        enabled: null,
        survey: null,
        impact: null,
        analysisStale: false,
        analysis: null,
        analysisError: null,
        search: '',
        onlyEnabled: false,
        hideSilent: false,
        sortMode,
        expanded: null,
        focusLine: null,
        importNotice: null,
    };
}

/** Every edit to the config goes through here, so each one marks results stale the same way. */
function edited(state: TidyState, doc: TidyDocument): TidyState {
    return { ...state, doc, liveStale: true, analysisStale: state.survey !== null };
}

function reducer(state: TidyState, action: Action): TidyState {
    const builtin = state.catalog ? parseChecks(state.catalog.defaultChecks) : [];
    switch (action.type) {
        case 'catalog':
            return { ...state, catalog: action.catalog };
        case 'status':
            return { ...state, status: action.status, error: action.error ?? null };
        case 'replaceDoc':
            return { ...edited(state, action.doc), importNotice: action.notice };
        case 'setChecks':
            return edited(state, withChecks(state.doc, action.checks));
        case 'setCheck':
            return edited(state, withChecks(state.doc, setCheck(state.doc.checks, action.check, action.enable, builtin)));
        case 'setModule':
            return edited(state, withChecks(state.doc, setFamily(state.doc.checks, `${action.module}-*`, action.enable)));
        case 'setOption':
            return edited(state, setOption(state.doc, action.key, action.value));
        case 'clearOption':
            return edited(state, clearOption(state.doc, action.key));
        case 'setSetting':
            return edited(state, setSetting(state.doc, action.key, action.value));
        case 'setFlags':
            return {
                ...state,
                flags: { ...state.flags, [action.languageId]: action.flags },
                liveStale: true,
                analysisStale: state.survey !== null,
            };
        case 'inputsChanged':
            return { ...state, liveStale: true, analysisStale: state.survey !== null };
        case 'liveStarted':
            return { ...state, liveRunning: true };
        case 'live':
            // If an edit landed mid-run, another run is already on its way and will
            // set `liveRunning` again; the flicker is harmless.
            return {
                ...state,
                live: action.outcome ?? state.live,
                liveRunning: false,
                liveStale: action.outcome === null && state.liveStale,
                liveError: action.error,
            };
        case 'effective':
            return { ...state, effective: action.effective, enabled: action.enabled };
        case 'analysisProgress':
            return { ...state, analysis: action.progress, analysisError: null };
        case 'survey':
            return { ...state, survey: action.survey, impact: null, analysisStale: false };
        case 'impact':
            return { ...state, impact: action.impact, analysis: null, analysisError: action.error ?? null };
        case 'search':
            return { ...state, search: action.value };
        case 'onlyEnabled':
            return { ...state, onlyEnabled: action.value };
        case 'hideSilent':
            return { ...state, hideSilent: action.value };
        case 'sortMode':
            try {
                localStorage.setItem(SORT_KEY, action.value);
            } catch {
                /* private mode */
            }
            return { ...state, sortMode: action.value };
        case 'expand':
            return { ...state, expanded: action.check };
        case 'focusLine':
            return { ...state, focusLine: action.line };
        default:
            return state;
    }
}

interface TidyStoreValue {
    state: TidyState;
    dispatch: (action: Action) => void;
    /** The current config as a `.clang-tidy` file. */
    fileText: string;
    /** Whether the current language is one clang-tidy can analyse. */
    supported: boolean;
    filename: string;
    compileArgs: string[];
    applyPreset: (id: string) => void;
    importFile: (text: string) => void;
    runAnalysis: () => void;
    cancelAnalysis: () => void;
    kindOf: (key: string) => TidyOptionKind | undefined;
}

const TidyContext = createContext<TidyStoreValue | null>(null);

export function TidyStoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
    const { state: shell, sample } = useStore();
    const [state, dispatch] = useReducer(reducer, undefined, initialState);
    const active = shell.toolId === 'tidy';
    const language = getLanguage(shell.doc.languageId);
    const supported = language.tidy !== undefined;
    const filename = tidyFilename(language.id);
    const flagsText = state.flags[language.id] ?? '';
    const compileArgs = useMemo(() => splitFlags(flagsText), [flagsText]);
    const configJson = useMemo(() => toConfigJson(state.doc), [state.doc]);
    const fileText = useMemo(() => toTidyFileText(state.doc), [state.doc]);

    const clientRef = useRef<TidyClient | null>(null);

    // Boot on first activation, and only then.
    useEffect(() => {
        if (!active || state.status !== 'idle') return;
        dispatch({ type: 'status', status: 'booting' });
        void (async () => {
            try {
                const [catalogModule] = await Promise.all([import('../../core/catalog/generated/tidy.23.1.1.json')]);
                dispatch({ type: 'catalog', catalog: catalogModule.default as unknown as TidyCatalog });
                clientRef.current ??= createTidyClient();
                await clientRef.current.ready;
                dispatch({ type: 'status', status: 'ready' });
            } catch (error) {
                dispatch({ type: 'status', status: 'error', error: (error as Error).message });
            }
        })();
    }, [active, state.status]);

    useEffect(() => () => clientRef.current?.terminate(), []);

    // The sample is shared state; editing it (in either tool) makes our results stale.
    const firstSample = useRef(true);
    useEffect(() => {
        if (firstSample.current) {
            firstSample.current = false;
            return;
        }
        dispatch({ type: 'inputsChanged' });
    }, [sample, language.id]);

    // The live run. Runs are serialised: while one is in flight, further edits
    // only record that another is wanted, and when it finishes the *latest*
    // inputs run once. Queuing a run per keystroke would bury the one that
    // matters behind a dozen that do not.
    const liveInputs = useRef({ code: sample, filename, config: configJson, compileArgs });
    liveInputs.current = { code: sample, filename, config: configJson, compileArgs };
    const liveBusy = useRef(false);
    const liveWanted = useRef(false);
    const startLive = useCallback(() => {
        const client = clientRef.current;
        if (!client) return;
        if (liveBusy.current) {
            liveWanted.current = true;
            return;
        }
        liveBusy.current = true;
        liveWanted.current = false;
        dispatch({ type: 'liveStarted' });
        const inputs = liveInputs.current;
        client
            .run(inputs)
            .then(
                (outcome) => dispatch({ type: 'live', outcome, error: null }),
                (error: Error) => dispatch({ type: 'live', outcome: null, error: error.message }),
            )
            .finally(() => {
                liveBusy.current = false;
                if (liveWanted.current) startLive();
            });
    }, []);

    useEffect(() => {
        if (!active || state.status !== 'ready' || !supported) return undefined;
        const timer = setTimeout(startLive, 350);
        return () => clearTimeout(timer);
    }, [active, state.status, supported, sample, configJson, compileArgs, filename, startLive]);

    // Effective values and the enabled set come from the binary: cheap queries
    // that do not parse the sample, so they run on every config change.
    const kindOf = useCallback(
        (key: string): TidyOptionKind | undefined => {
            const dot = key.lastIndexOf('.');
            const check = state.catalog?.checks.find((c) => c.name === key.slice(0, dot));
            return check?.options.find((o) => o.name === key.slice(dot + 1))?.kind;
        },
        [state.catalog],
    );
    useEffect(() => {
        const client = clientRef.current;
        if (!active || state.status !== 'ready' || !client) return undefined;
        let cancelled = false;
        void (async () => {
            try {
                const [dump, enabled] = await Promise.all([
                    client.dumpConfig(configJson, filename),
                    // `--list-checks` refuses to run with nothing enabled.
                    client.listChecks(configJson).catch(() => [] as string[]),
                ]);
                if (!cancelled) {
                    dispatch({
                        type: 'effective',
                        effective: resolveTidyEffective(state.doc, dump, kindOf),
                        enabled: new Set(enabled),
                    });
                }
            } catch {
                /* a bad config is reported by the live run, with clang-tidy's own words */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [active, state.status, configJson, filename, state.doc, kindOf]);

    const analysisRun = useRef<AbortController | null>(null);
    const runAnalysis = useCallback(() => {
        const client = clientRef.current;
        if (!client || !state.catalog) return;
        analysisRun.current?.abort();
        const controller = new AbortController();
        analysisRun.current = controller;
        const input = {
            catalog: state.catalog,
            doc: state.doc,
            code: sample,
            filename,
            compileArgs,
            port: client,
            signal: controller.signal,
        };
        void (async () => {
            try {
                const surveyed = await runSurvey({
                    ...input,
                    onProgress: (done, total) =>
                        dispatch({ type: 'analysisProgress', progress: { phase: 'survey', done, total } }),
                });
                if (controller.signal.aborted) return;
                dispatch({ type: 'survey', survey: surveyed });
                const impact = await sweepOptions({
                    ...input,
                    survey: surveyed,
                    onProgress: (done, total) =>
                        dispatch({ type: 'analysisProgress', progress: { phase: 'options', done, total } }),
                });
                if (!controller.signal.aborted) dispatch({ type: 'impact', impact });
            } catch (error) {
                if (controller.signal.aborted) return;
                dispatch({ type: 'impact', impact: null, error: (error as Error).message });
            }
        })();
    }, [state.catalog, state.doc, sample, filename, compileArgs]);

    const cancelAnalysis = useCallback(() => {
        analysisRun.current?.abort();
        analysisRun.current = null;
        dispatch({ type: 'impact', impact: null });
    }, []);

    const applyPreset = useCallback((id: string) => {
        const preset = TIDY_PRESETS.find((p) => p.id === id);
        if (preset) dispatch({ type: 'setChecks', checks: parseChecks(preset.checks) });
    }, []);

    const importFile = useCallback(
        (text: string) => {
            if (!state.catalog) return;
            try {
                const parsed = fromTidyFileText(text, state.catalog);
                const notes: string[] = [];
                if (parsed.unknownKeys.length > 0) {
                    notes.push(`ignored keys clang-tidy ${state.catalog.clangTidyVersion} does not know: ${parsed.unknownKeys.join(', ')}`);
                }
                if (parsed.unknownOptions.length > 0) {
                    notes.push(`kept options that match no known check option: ${parsed.unknownOptions.join(', ')}`);
                }
                dispatch({ type: 'replaceDoc', doc: parsed.doc, notice: notes.length > 0 ? `Imported; ${notes.join('; ')}` : null });
            } catch (error) {
                dispatch({ type: 'replaceDoc', doc: state.doc, notice: `Could not read that file: ${(error as Error).message}` });
            }
        },
        [state.catalog, state.doc],
    );

    const value = useMemo<TidyStoreValue>(
        () => ({
            state,
            dispatch,
            fileText,
            supported,
            filename,
            compileArgs,
            applyPreset,
            importFile,
            runAnalysis,
            cancelAnalysis,
            kindOf,
        }),
        [state, fileText, supported, filename, compileArgs, applyPreset, importFile, runAnalysis, cancelAnalysis, kindOf],
    );
    return <TidyContext.Provider value={value}>{children}</TidyContext.Provider>;
}

export function useTidyStore(): TidyStoreValue {
    const value = useContext(TidyContext);
    if (!value) throw new Error('useTidyStore must be used inside TidyStoreProvider');
    return value;
}

/** The preset whose Checks line the document currently has, if any. */
export function currentPresetId(doc: TidyDocument): string {
    const checks = formatChecks(doc.checks);
    return TIDY_PRESETS.find((p) => formatChecks(parseChecks(p.checks)) === checks)?.id ?? '';
}
