/**
 * Describes the clang-tidy check surface.
 *
 * Generated at build time by `scripts/generate-tidy-catalog.ts`, from two sources
 * that must agree: clang-tidy's own documentation at the pinned `llvmorg-*` tag,
 * which says what each check and option is *for*, and the wasm binary itself,
 * which says what actually exists and what every option defaults to. Nothing
 * about the surface is hand-maintained, for the same reason as the format
 * catalog: it changes every release.
 */

import type { CodeExample } from '../catalog/types.ts';

/**
 * How an option's value is written, which decides the control.
 *
 * clang-tidy stores every option as a string, so this is inferred — from the
 * dumped default, from the documentation, and, for enums, confirmed by asking the
 * binary whether it accepts each value.
 */
export type TidyOptionKind =
    | 'bool'
    | 'integer'
    /** Floating point, e.g. a ratio. */
    | 'number'
    /** One of a fixed set, each value confirmed against the binary. */
    | 'enum'
    /** Semicolon-separated, as clang-tidy spells lists. */
    | 'list'
    | 'regex'
    | 'string';

export interface TidyOptionDescriptor {
    /** The bare name, e.g. `StrictMode`; the config key is `<check>.<name>`. */
    name: string;
    kind: TidyOptionKind;
    /**
     * The default exactly as `--dump-config` prints it. Null for options that are
     * documented but never dumped — mostly `readability-identifier-naming`'s
     * per-kind settings, which have no default because unset means "not enforced".
     */
    default: string | null;
    /** Accepted values, for `enum`. */
    values: string[];
    /**
     * clang-tidy *crashes* on a value it cannot parse, rather than warning and
     * using the default. Upstream bug, found by the generator's probe:
     * `bugprone-suspicious-missing-comma.RatioThreshold` is read with `std::stod`,
     * which throws, in a program built without exceptions. The UI must never send
     * such an option a value that fails to parse.
     */
    fragile?: boolean;
    doc: string;
    examples: CodeExample[];
}

export interface TidyCheckDescriptor {
    /** e.g. `bugprone-argument-comment`, `clang-analyzer-core.DivideZero`. */
    name: string;
    /** The name prefix it is grouped under, e.g. `bugprone`, `clang-analyzer`. */
    module: string;
    /** The first paragraph of the documentation. */
    summary: string;
    /** The rest of the prose, lightly cleaned of reStructuredText markup. */
    doc: string;
    examples: CodeExample[];
    /** Whether the check can offer fix-its, per the upstream check list. */
    offersFixes: boolean;
    /**
     * The check this one is an alias of, if any. An alias runs the same code under
     * another name, so enabling both reports every finding twice.
     */
    aliasOf: string | null;
    /** Options, including those an alias inherits from its target. */
    options: TidyOptionDescriptor[];
    /** Path of its page under `clang-tools-extra/docs/clang-tidy/checks/`, without `.rst`. */
    docPath: string | null;
}

export interface TidyModuleDescriptor {
    name: string;
    description: string;
}

/** A key a `.clang-tidy` file may set at top level, e.g. `WarningsAsErrors`. */
export interface TidyTopLevelKey {
    name: string;
    doc: string;
    /**
     * From the value type `--dump-config` prints for it; for keys it omits, from
     * the documentation. `complex` is edited as text (`CustomChecks`, `CheckOptions`).
     */
    kind: 'bool' | 'string' | 'list' | 'complex';
    /** The binary's default, when it dumps one. */
    default: string | boolean | string[] | null;
}

export interface TidyCatalog {
    clangTidyVersion: string;
    sourceTag: string;
    /** SHA-256 over the documentation the catalog was built from. */
    docsSha256: string;
    generatedAt: string;
    /**
     * What clang-tidy enables before reading any config, from the binary's own
     * `--dump-config`. A file's `Checks` are appended to this, not substituted.
     */
    defaultChecks: string;
    topLevelKeys: TidyTopLevelKey[];
    modules: TidyModuleDescriptor[];
    checks: TidyCheckDescriptor[];
}

/** The module a check belongs to: its name up to the first `-`, except for the analyzer. */
export function moduleOf(check: string): string {
    if (check.startsWith('clang-analyzer-')) return 'clang-analyzer';
    if (check.startsWith('clang-diagnostic-')) return 'clang-diagnostic';
    return check.slice(0, check.indexOf('-'));
}

const YAML_TRUE = new Set(['y', 'Y', 'yes', 'Yes', 'YES', 'true', 'True', 'TRUE', 'on', 'On', 'ON']);
const YAML_FALSE = new Set(['n', 'N', 'no', 'No', 'NO', 'false', 'False', 'FALSE', 'off', 'Off', 'OFF']);

/**
 * Reads a boolean option the way clang-tidy does: any YAML 1.1 spelling, or any
 * integer (non-zero is true). The integer form matters in practice — several
 * checks read a bool but *store* an int, so `--dump-config` reports `'1'` for an
 * option that was set to `true`.
 */
export function parseTidyBool(value: string): boolean | null {
    if (YAML_TRUE.has(value)) return true;
    if (YAML_FALSE.has(value)) return false;
    return /^[-+]?\d+$/.test(value) ? Number(value) !== 0 : null;
}

/** Whether two spellings of an option value mean the same thing to clang-tidy. */
export function sameOptionValue(kind: TidyOptionKind, a: string, b: string): boolean {
    if (a === b) return true;
    switch (kind) {
        case 'bool': {
            const left = parseTidyBool(a);
            return left !== null && left === parseTidyBool(b);
        }
        case 'integer':
        case 'number':
            return a.trim() !== '' && b.trim() !== '' && Number(a) === Number(b);
        default:
            return false;
    }
}
