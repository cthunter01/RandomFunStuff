import type { ClangLanguageKey } from '../languages/types.ts';

/**
 * Describes the clang-format option surface.
 *
 * Everything in here is generated at build time from clang's own
 * `ClangFormatStyleOptions.rst` at a pinned `llvmorg-*` tag (see
 * `scripts/generate-catalog.ts`). Nothing is hand-maintained, because the option
 * set changes every release and a hand-written table would silently rot.
 */

/** How a value is written in a `.clang-format` file, which decides the UI control. */
export type OptionKind =
    | 'bool'
    | 'enum'
    | 'unsigned'
    | 'integer'
    | 'string'
    | 'stringList'
    | 'nested'
    | 'includeCategories'
    | 'rawStringFormats'
    | 'deprecated'
    | 'unknown';

export interface CodeExample {
    /** The `.. code-block::` language, e.g. `c++`, `yaml`, `java`. */
    language: string;
    code: string;
}

export interface EnumValueDescriptor {
    /** As written in the config file, e.g. `Left`. */
    value: string;
    /** The C++ enum symbol, e.g. `PAS_Left`. Useful when cross-referencing clang source. */
    symbol: string;
    doc: string;
    examples: CodeExample[];
    /**
     * True when clang-format rejects this value if it is set on its own. Such a
     * value needs a prerequisite option set first (see `OptionDescriptor.requires`),
     * so the UI must not offer it as a bare choice.
     */
    needsPrerequisite: boolean;
}

/** A field of a nested-struct option, e.g. `BraceWrapping.AfterFunction`. */
export interface NestedFieldDescriptor {
    name: string;
    kind: OptionKind;
    declaredType: string;
    doc: string;
    values: EnumValueDescriptor[];
    examples: CodeExample[];
    /** Deprecated alias kept for compatibility; `replacedBy` names the successor. */
    deprecated?: boolean;
    replacedBy?: string;
}

/** An option that must be set a particular way before this one takes effect. */
export interface OptionRequirement {
    option: string;
    value: string;
    /** Human-readable reason, shown in the UI. */
    reason: string;
}

export interface OptionDescriptor {
    name: string;
    kind: OptionKind;
    /** The type name as clang documents it, e.g. `PointerAlignmentStyle`. */
    declaredType: string;
    doc: string;
    /** Minimum clang-format version, from the docs' `:versionbadge:`. */
    since: string | null;
    deprecated: boolean;
    /** Populated for `enum`. */
    values: EnumValueDescriptor[];
    /** Populated for `nested`. */
    fields: NestedFieldDescriptor[];
    /**
     * Some nested options also accept a single shorthand string
     * (`AlignConsecutiveAssignments: AcrossComments`) as well as a map.
     */
    shorthandValues: string[];
    examples: CodeExample[];
    /** UI grouping bucket, derived from the option name. */
    group: string;
    /**
     * Language ids for which clang-format *rejects* this option outright.
     * Empirically probed at generation time; a reliable "does not apply" signal.
     * Acceptance is NOT proof of relevance, so this is only ever a hint.
     */
    /**
     * Languages this option is specific to, derived from its name and its docs.
     *
     * This is a heuristic on purpose. Probing the binary for language
     * applicability was tried and does not work: clang-format accepts virtually
     * every key for every language and silently ignores the irrelevant ones, so
     * the probe found zero restrictions across all 209 options. The authority on
     * whether an option matters is the impact engine — does changing it change
     * *your* code. These hints only reorder and annotate.
     *
     * Empty means "not language-specific as far as we can tell".
     */
    languageHints: ClangLanguageKey[];
    requires: OptionRequirement[];
    /**
     * Whether `dump_config` actually emits this key. Deprecated aliases and
     * empty list-valued options are documented but never dumped, and the UI
     * needs to know an effective value is simply not observable.
     */
    emittedByDumpConfig: boolean;
}

export interface OptionCatalog {
    /** The clang-format version this catalog describes, e.g. `23.1.1`. */
    clangFormatVersion: string;
    /** The upstream tag the docs were read from, e.g. `llvmorg-23.1.1`. */
    sourceTag: string;
    /** SHA-256 of the docs file the catalog was built from. */
    rstSha256: string;
    generatedAt: string;
    baseStyles: readonly string[];
    options: OptionDescriptor[];
}

/** The predefined styles clang-format ships. `BasedOnStyle` accepts exactly these. */
export const BASE_STYLES = ['LLVM', 'Google', 'Chromium', 'Mozilla', 'WebKit', 'Microsoft', 'GNU'] as const;
export type BaseStyle = (typeof BASE_STYLES)[number];


/**
 * `Language` is a document selector, not a tweakable option — setting it by hand
 * produces configs clang-format rejects. The language registry owns it instead.
 */
export const NON_OPTION_KEYS = new Set(['Language']);


/**
 * Options that make the formatter a no-op and therefore trivially "match" any input.
 * Inference must exclude these or it reports a meaningless perfect score.
 */
export const DEGENERATE_OPTIONS = new Set(['DisableFormat']);
