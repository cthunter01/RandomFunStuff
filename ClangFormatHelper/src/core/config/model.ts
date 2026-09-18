/**
 * The configuration the user is building.
 *
 * Deliberately stored as a base style plus a *sparse* set of overrides rather
 * than a full option map. That is what a hand-written `.clang-format` looks like,
 * it makes "has the user changed this?" an O(1) question, "reset this option" a
 * single delete, and it keeps the exported file small and reviewable.
 */

import type { BaseStyle } from '../catalog/types.ts';

export type ConfigScalar = string | number | boolean;
export type ConfigValue = ConfigScalar | ConfigValue[] | { [key: string]: ConfigValue };

/**
 * A dotted path to a settable value.
 *
 * Nested structs store leaves (`BraceWrapping.AfterFunction`), because
 * clang-format merges a partial struct onto the base. Lists are stored whole at
 * their own path (`IncludeCategories`), because clang-format replaces lists
 * rather than merging them.
 */
export type ConfigPath = string;

export interface StyleDocument {
    languageId: string;
    baseStyle: BaseStyle;
    overrides: ReadonlyMap<ConfigPath, ConfigValue>;
}

export interface Project {
    /** clang-format version this config targets. */
    clangVersion: string;
    document: StyleDocument;
    /** Sample source per language id, so switching languages does not lose work. */
    samples: Readonly<Record<string, string>>;
}

export function createDocument(languageId: string, baseStyle: BaseStyle): StyleDocument {
    return { languageId, baseStyle, overrides: new Map() };
}

export function setOverride(doc: StyleDocument, path: ConfigPath, value: ConfigValue): StyleDocument {
    const overrides = new Map(doc.overrides);
    overrides.set(path, value);
    return { ...doc, overrides };
}

export function clearOverride(doc: StyleDocument, path: ConfigPath): StyleDocument {
    const overrides = new Map(doc.overrides);
    overrides.delete(path);
    // Dropping the last leaf of a struct should drop the struct, not leave `{}`.
    return { ...doc, overrides };
}

export function isOverridden(doc: StyleDocument, path: ConfigPath): boolean {
    return doc.overrides.has(path);
}

/** Every override under a struct, e.g. all `BraceWrapping.*` leaves. */
export function overridesUnder(doc: StyleDocument, prefix: string): ConfigPath[] {
    const dotted = `${prefix}.`;
    return [...doc.overrides.keys()].filter((p) => p === prefix || p.startsWith(dotted));
}

/** Expands dotted paths into the nested object clang-format expects. */
export function toNestedObject(overrides: ReadonlyMap<ConfigPath, ConfigValue>): Record<string, ConfigValue> {
    const root: Record<string, ConfigValue> = {};
    for (const path of [...overrides.keys()].sort()) {
        const value = overrides.get(path)!;
        const segments = path.split('.');
        let cursor = root;
        for (let i = 0; i < segments.length - 1; i++) {
            const segment = segments[i]!;
            const existing = cursor[segment];
            if (existing === undefined || typeof existing !== 'object' || Array.isArray(existing)) {
                cursor[segment] = {};
            }
            cursor = cursor[segment] as Record<string, ConfigValue>;
        }
        cursor[segments[segments.length - 1]!] = value;
    }
    return root;
}

/** Collapses a nested object into dotted leaf paths. Lists stay whole. */
export function flatten(value: unknown, prefix = '', into = new Map<ConfigPath, ConfigValue>()): Map<ConfigPath, ConfigValue> {
    if (value === null || value === undefined) return into;
    if (typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            flatten(child, prefix ? `${prefix}.${key}` : key, into);
        }
        return into;
    }
    if (prefix) into.set(prefix, value as ConfigValue);
    return into;
}

/** Structural equality, adequate for config values (scalars, arrays, plain objects). */
export function valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => valuesEqual(item, b[i]));
    }
    if (a && b && typeof a === 'object') {
        const ka = Object.keys(a as object);
        const kb = Object.keys(b as object);
        if (ka.length !== kb.length) return false;
        return ka.every((k) => valuesEqual((a as never)[k], (b as never)[k]));
    }
    return false;
}
