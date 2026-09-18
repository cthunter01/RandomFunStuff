/**
 * The language registry — extensibility seam #1.
 *
 * The same clang-format binary already understands C/C++, Java, JavaScript,
 * TypeScript, ObjC, Proto, C# and JSON. Supporting one is therefore a matter of
 * describing it, not of writing new code paths: add a file under `defs/`,
 * register it, done.
 *
 * Note there is deliberately no editor/CodeMirror concern here. `src/core` stays
 * framework-free; the UI maps a LanguageId to a syntax mode on its own side.
 */

/** Value of clang-format's `Language:` key. */
export type ClangLanguageKey =
    | 'Cpp'
    | 'Java'
    | 'JavaScript'
    | 'ObjC'
    | 'Proto'
    | 'CSharp'
    | 'Json'
    | 'TableGen'
    | 'TextProto'
    | 'Verilog';

export interface CodeSample {
    readonly id: string;
    readonly title: string;
    /** What this sample is built to exercise, shown when an option has no effect. */
    readonly exercises: readonly string[];
    readonly code: string;
}

export interface LanguageDefinition {
    readonly id: string;
    readonly label: string;
    readonly clangLanguage: ClangLanguageKey;
    /**
     * Handed to `format()`/`dump_config()` to select the parser. This — not the
     * `Language:` key — is how the wasm decides which language it is looking at.
     */
    readonly probeFilename: string;
    /** File extensions this language claims, used when the user opens a file. */
    readonly extensions: readonly string[];
    readonly samples: readonly CodeSample[];
    readonly defaultSampleId: string;
    /**
     * Options worth surfacing first for this language. Purely presentational;
     * the impact engine is the authority on what actually matters.
     */
    readonly signatureOptions: readonly string[];
    /**
     * How clang-tidy compiles this language. Absent for languages clang-tidy
     * cannot analyse (it is a C-family tool; clang-format is not), which is how
     * the tidy UI knows not to offer them.
     */
    readonly tidy?: {
        /** Default compiler flags, as typed into a command line. */
        readonly compileFlags: string;
    };
}
