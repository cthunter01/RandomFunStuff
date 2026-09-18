import { useEffect, useReducer } from 'react';
import { ensureGrammar, subscribeToGrammars } from './highlight.ts';

/**
 * Makes a view repaint when its grammar finishes loading.
 *
 * Grammars arrive after first paint, so anything already rendered as plain text
 * needs a nudge. The returned version number is meant to be included in a
 * `useMemo` dependency list wherever highlighting is computed outside render.
 */
export function useGrammar(languageId: string): number {
    const [version, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        ensureGrammar(languageId);
        return subscribeToGrammars(bump);
    }, [languageId]);
    return version;
}
