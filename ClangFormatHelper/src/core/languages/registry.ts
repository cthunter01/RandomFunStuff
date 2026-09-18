import type { LanguageDefinition } from './types.ts';
import { cpp, c } from './defs/cpp.ts';

/**
 * Registered languages, in menu order. C and C++ come first because they are the
 * focus; everything else is added by dropping a definition in `defs/` and
 * appending it here.
 */
const DEFINITIONS: readonly LanguageDefinition[] = [cpp, c];

const BY_ID = new Map(DEFINITIONS.map((d) => [d.id, d]));

export function listLanguages(): readonly LanguageDefinition[] {
    return DEFINITIONS;
}

export function getLanguage(id: string): LanguageDefinition {
    const found = BY_ID.get(id);
    if (!found) throw new Error(`Unknown language id: ${id}`);
    return found;
}

export function hasLanguage(id: string): boolean {
    return BY_ID.has(id);
}

export const DEFAULT_LANGUAGE_ID = cpp.id;
