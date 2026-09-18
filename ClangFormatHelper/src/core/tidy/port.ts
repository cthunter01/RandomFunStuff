/**
 * The boundary between the pure engine and the thing that actually runs clang-tidy.
 *
 * The same arrangement as `FormatterPort`: `src/core` never touches the wasm, it
 * talks to this interface, and the app and the tests inject different
 * implementations of it. The tests' one drives the production runtime directly in
 * Node, so the engine is tested against the real binary.
 *
 * The cost model is what shapes everything downstream. A clang-format call costs
 * half a millisecond; a clang-tidy run re-parses the translation unit, standard
 * headers included, and costs the better part of a second. So where the format
 * side can afford one run per candidate value, the tidy side has to make each run
 * answer many questions at once.
 */

export type TidyLevel = 'error' | 'warning' | 'remark';

/** A source range, 1-based, in the file that was analysed. */
export interface TidySpan {
    line: number;
    column: number;
    /** Byte offset into the file — what replacements are expressed in. */
    offset: number;
    length: number;
}

export interface TidyReplacement {
    offset: number;
    length: number;
    text: string;
}

export interface TidyNote {
    message: string;
    /** Null when the note points into a header rather than the analysed file. */
    span: TidySpan | null;
}

export interface TidyDiagnostic {
    /** The check that fired, e.g. `modernize-use-nullptr`, or `clang-diagnostic-error`. */
    check: string;
    level: TidyLevel;
    message: string;
    /** Null when the diagnostic points outside the analysed file. */
    span: TidySpan | null;
    /** Fix-it edits, already filtered to the analysed file. Empty when the check offers none. */
    replacements: TidyReplacement[];
    notes: TidyNote[];
}

export interface TidyRequest {
    code: string;
    /** Its extension selects C or C++ (`sample.c`, `sample.cpp`). */
    filename: string;
    /** The `.clang-tidy` content to apply, YAML or JSON. */
    config: string;
    /** Compiler flags for the file, e.g. `-std=c++23`. Target and sysroot are the runtime's business. */
    compileArgs: readonly string[];
}

export interface TidyOutcome {
    /** The process exit status. Non-zero on compile errors or `WarningsAsErrors` hits. */
    exitCode: number;
    diagnostics: TidyDiagnostic[];
    /** Everything clang-tidy printed, for a details disclosure. */
    output: string;
    /**
     * Headers the sample includes that the analyser does not have, which were
     * replaced by empty stand-ins (see `core/tidy/includes`). Anything they would
     * have declared is unknown, so errors naming such things are expected.
     */
    stubbedIncludes: string[];
    /** Wall time of the run itself, excluding queueing. */
    millis: number;
}

export interface TidyPort {
    /** clang-tidy's own version string. */
    version(): Promise<string>;

    run(request: TidyRequest): Promise<TidyOutcome>;

    /**
     * Runs one input under many configs. Implementations may spread these over
     * several instances in parallel; results come back in request order.
     */
    runBatch(
        code: string,
        filename: string,
        compileArgs: readonly string[],
        configs: readonly string[],
    ): Promise<TidyOutcome[]>;

    /**
     * The fully resolved configuration, as `--dump-config` prints it: every enabled
     * check's options with their effective values, defaults included.
     */
    dumpConfig(config: string, filename: string): Promise<string>;

    /** The checks a config actually enables, as `--list-checks` resolves its globs. */
    listChecks(config: string): Promise<string[]>;
}
