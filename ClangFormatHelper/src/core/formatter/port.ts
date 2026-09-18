/**
 * The boundary between the pure engine and the thing that actually runs clang-format.
 *
 * `src/core` never imports `@wasm-fmt/clang-format`. It talks to this interface
 * instead, which keeps the engine framework-free and — more usefully — makes the
 * impact and inference engines testable against the real binary in Node without
 * a Worker, a bundler, or a DOM.
 *
 * The app injects a Worker-backed implementation; tests inject a direct one.
 */

/** Status reported by clang-format for one format request. */
export type FormatStatus = 'changed' | 'unchanged' | 'error';

export interface Diagnostic {
    severity: 'error' | 'warning' | 'note';
    /** 1-based, into the style text that was sent. */
    line: number;
    /** 1-based. */
    column: number;
    /** Width of the caret run, or 0 when absent. */
    length: number;
    message: string;
}

export interface FormatFailure {
    message: string;
    diagnostics: Diagnostic[];
    /** Full captured stderr, for a details disclosure. */
    raw: string;
}

export interface FormatOutcome {
    status: FormatStatus;
    /**
     * Omitted when `status` is `unchanged` — the caller already has the input, and
     * not shipping it back is what makes a large impact sweep cheap.
     */
    text?: string;
    error?: FormatFailure;
}

export interface FormatRequest {
    code: string;
    /** Selects the language. This, not the `Language:` key, is what the binary uses. */
    filename: string;
    /**
     * A predefined style name, inline flow (`{...}`), or full `.clang-format` text.
     * Note `dumpConfig` is stricter — see its doc comment.
     */
    style: string;
}

export interface FormatterPort {
    /** clang-format's own version string. */
    version(): Promise<string>;

    format(request: FormatRequest): Promise<FormatOutcome>;

    /**
     * Formats one input against many styles in a single round trip.
     * This is the primitive the impact sweep and the inference search are built on.
     */
    formatBatch(code: string, filename: string, styles: readonly string[]): Promise<FormatOutcome[]>;

    /**
     * Resolves a style to its full effective configuration, as YAML.
     *
     * The style MUST be a predefined name or inline flow (`{Key: Value, ...}`).
     * Raw multi-line YAML is rejected by the binary with "Invalid value for
     * -style", even though `format()` accepts it — verified against 23.1.1. Use
     * `toInlineStyle()` from `core/config/serialize` to build the argument.
     */
    dumpConfig(style: string, filename: string): Promise<string>;
}
