/**
 * Type declarations for the `@wasm-fmt/clang-format` internals we reach into.
 *
 * The package ships types for its public entry points, but its export map also
 * exposes every internal file (`"./*": "./*"`). We use three of those directly
 * because the published wrapper hides things we need:
 *
 *  - `createModule` + `set_wasm` let us install our own Emscripten `printErr`,
 *    which is the only way to recover clang-format's real diagnostics
 *    ("unknown key 'Foo'" with line/column). The wrapper throws them away and
 *    reports a generic "Invalid argument".
 *  - The raw Embind `ClangFormat` exposes `Result.status`, so an `Unchanged`
 *    result is a free "this option had no effect" signal that ships no text.
 */

declare module '@wasm-fmt/clang-format/clang-format.js' {
    export interface EmscriptenModuleOptions {
        /** A pre-compiled module or raw bytes; becomes the instantiation source. */
        wasm?: WebAssembly.Module | BufferSource;
        print?: (line: string) => void;
        printErr?: (line: string) => void;
    }
    export interface RawResult {
        status: number;
        content: string;
    }
    export interface RawClangFormat {
        with_style(style: string): void;
        with_fallback_style(style: string): void;
        format(content: string, filename: string): RawResult;
        format_range(content: string, filename: string, offset: number, length: number): RawResult;
        format_line(content: string, filename: string, from: number, to: number): RawResult;
        delete(): void;
    }
    export interface ClangFormatWasmModule {
        ClangFormat: {
            new (): RawClangFormat;
            version(): string;
            dump_config(style: string, filename: string, code: string): RawResult;
        };
        ResultStatus: { Success: number; Error: number; Unchanged: number };
        HEAPU8: Uint8Array;
    }
    export function createModule(options: EmscriptenModuleOptions): ClangFormatWasmModule;
}

declare module '@wasm-fmt/clang-format/clang-format-binding.js' {
    import type { ClangFormatWasmModule } from '@wasm-fmt/clang-format/clang-format.js';
    export function set_wasm(wasm: ClangFormatWasmModule): void;
}

declare module '@wasm-fmt/clang-format/clang-format-node.js' {
    export * from '@wasm-fmt/clang-format';
}

declare module '*.wasm?url' {
    const url: string;
    export default url;
}
