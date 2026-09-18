/**
 * Hosts the clang-format WebAssembly module and implements FormatterPort on top of it.
 *
 * Bypasses the package's own `initAsync`/`format` helpers on purpose. Going
 * through `createModule` + `set_wasm` ourselves buys two things the wrapper does
 * not offer:
 *
 *  - a `printErr` hook, which is the only way to recover clang-format's real
 *    diagnostics (the wrapper reports a generic "Invalid argument");
 *  - direct access to `Result.status`, so an `Unchanged` result is a free
 *    "this option changed nothing" signal that ships no text back. That is what
 *    keeps a 500-candidate impact sweep cheap.
 *
 * Environment-agnostic: it takes an already-compiled module, so the browser
 * Worker and the Node tests exercise exactly this code.
 */

import { createModule, type ClangFormatWasmModule, type RawClangFormat } from '@wasm-fmt/clang-format/clang-format.js';
import { set_wasm } from '@wasm-fmt/clang-format/clang-format-binding.js';
import { parseDiagnostics } from '../core/formatter/diagnostics.ts';
import type { FormatOutcome, FormatRequest, FormatterPort } from '../core/formatter/port.ts';

export interface Runtime extends FormatterPort {
    dispose(): void;
    /** Diagnostic counter: how many times the module has been re-instantiated. */
    readonly recycleCount: number;
}

export interface RuntimeOptions {
    /**
     * Re-instantiate the module after this many operations.
     *
     * This is not tidiness, it is a correctness requirement. The module
     * accumulates state across *distinct* styles, and somewhere north of ~800
     * formats it either traps with "memory access out of bounds" or stops
     * making progress entirely. No single input triggers it — every candidate
     * that appears to hang formats fine on its own — so it cannot be avoided by
     * filtering inputs. An impact sweep is 450+ formats, so the second sweep in
     * a session would land squarely in that window.
     *
     * Re-instantiating from the already-compiled module measures ~2 ms, against
     * hundreds of formats at ~0.5-10 ms each, so the ceiling is set low and
     * cheaply rather than tuned to the edge of the failure.
     */
    recycleAfter?: number;
}

export function createRuntime(compiled: WebAssembly.Module, options: RuntimeOptions = {}): Runtime {
    const recycleAfter = options.recycleAfter ?? 250;

    let stderr: string[] = [];
    const capture = (line: string): void => {
        stderr.push(line);
    };

    let wasm: ClangFormatWasmModule;
    let operations = 0;
    let recycleCount = 0;
    let disposed = false;

    const instantiate = (): void => {
        wasm = createModule({ wasm: compiled, print: capture, printErr: capture });
        // Keep the package's own wrapper functional for anything that reaches for it.
        set_wasm(wasm);
        operations = 0;
    };
    instantiate();

    const ready = (): ClangFormatWasmModule => {
        if (disposed) throw new Error('Formatter runtime has been disposed');
        if (operations >= recycleAfter) {
            instantiate();
            recycleCount++;
        }
        operations++;
        return wasm;
    };

    /**
     * A fresh formatter per call, disposed immediately.
     *
     * Reusing one instance across many styles looks like the obvious
     * optimisation and is wrong twice over: each `with_style` allocates inside
     * the wasm heap, and it buys nothing anyway. Measured over 1500 formats of a
     * 522-line file: 7.75 ms/call with a fresh instance, 7.73 ms/call reusing one.
     */
    const withFormatter = <T>(fn: (cf: RawClangFormat) => T): T => {
        const module = ready();
        const cf = new module.ClangFormat();
        try {
            return fn(cf);
        } finally {
            cf.delete();
        }
    };

    const failure = (message: string) => ({
        message,
        diagnostics: parseDiagnostics(stderr),
        raw: stderr.join('\n'),
    });

    const runFormat = (request: FormatRequest): FormatOutcome => {
        stderr = [];
        let result;
        try {
            result = withFormatter((cf) => {
                cf.with_style(request.style);
                return cf.format(request.code, request.filename);
            });
        } catch (error) {
            // A rejected style throws out of the Embind call. The module stays
            // healthy afterwards — verified — so there is nothing to recover from.
            return { status: 'error', error: failure(error instanceof Error ? error.message : String(error)) };
        }
        if (result.status === wasm.ResultStatus.Error) return { status: 'error', error: failure(result.content) };
        if (result.status === wasm.ResultStatus.Unchanged) return { status: 'unchanged' };
        return { status: 'changed', text: result.content };
    };

    return {
        get recycleCount() {
            return recycleCount;
        },
        async version() {
            return ready().ClangFormat.version();
        },
        async format(request) {
            return runFormat(request);
        },
        async formatBatch(code, filename, styles) {
            return styles.map((style) => runFormat({ code, filename, style }));
        },
        async dumpConfig(style, filename) {
            stderr = [];
            if (!style.startsWith('{') && !/^[A-Za-z]+$/.test(style)) {
                throw new Error(
                    'dumpConfig requires a predefined style name or inline flow ({Key: Value}); ' +
                        'clang-format rejects multi-line YAML here. Use toInlineStyle().',
                );
            }
            const module = ready();
            const result = module.ClangFormat.dump_config(style, filename, '');
            if (result.status === module.ResultStatus.Error) throw new Error(failure(result.content).message);
            return result.content;
        },
        dispose() {
            disposed = true;
        },
    };
}
