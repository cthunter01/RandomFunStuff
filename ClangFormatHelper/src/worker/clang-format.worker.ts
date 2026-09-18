/**
 * The formatter worker.
 *
 * clang-format lives here and nowhere else. Keeping it off the main thread is
 * what lets a multi-second impact sweep run while the user keeps typing.
 */

import wasmUrl from '@wasm-fmt/clang-format/clang-format.wasm?url';
import { createRuntime, type Runtime } from './runtime.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

let runtime: Runtime | null = null;

async function boot(): Promise<Runtime> {
    if (runtime) return runtime;
    const response = await fetch(wasmUrl);
    if (!response.ok) {
        throw new Error(`The clang-format module failed to download (HTTP ${response.status} for ${response.url}).`);
    }
    let compiled: WebAssembly.Module;
    try {
        compiled = await WebAssembly.compileStreaming(response.clone());
    } catch (streamingError) {
        // compileStreaming insists on Content-Type: application/wasm. Plenty of
        // servers still send octet-stream, so fall back rather than fail — but say
        // so, because it is a server misconfiguration with a one-line fix.
        const type = response.headers.get('content-type') ?? '(none)';
        if (!/^application\/wasm\b/.test(type)) {
            console.warn(
                `clang-format module served as "${type}" instead of application/wasm; ` +
                    'using the slower non-streaming path. See docs/deployment.md.',
            );
        }
        try {
            compiled = await WebAssembly.compile(await response.arrayBuffer());
        } catch (error) {
            // Most often a Content-Security-Policy without 'wasm-unsafe-eval'.
            throw error instanceof Error ? error : streamingError;
        }
    }
    runtime = createRuntime(compiled);
    return runtime;
}

const post = (message: WorkerResponse): void => {
    self.postMessage(message);
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const request = event.data;
    try {
        const rt = await boot();
        switch (request.kind) {
            case 'version':
                post({ id: request.id, ok: true, kind: 'version', version: await rt.version() });
                break;
            case 'format':
                post({
                    id: request.id,
                    ok: true,
                    kind: 'format',
                    outcome: await rt.format({ code: request.code, filename: request.filename, style: request.style }),
                });
                break;
            case 'formatBatch':
                post({
                    id: request.id,
                    ok: true,
                    kind: 'formatBatch',
                    outcomes: await rt.formatBatch(request.code, request.filename, request.styles),
                });
                break;
            case 'dumpConfig':
                post({
                    id: request.id,
                    ok: true,
                    kind: 'dumpConfig',
                    yaml: await rt.dumpConfig(request.style, request.filename),
                });
                break;
        }
    } catch (error) {
        post({ id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
};

// Report a failed boot instead of leaving the page on "Loading…" forever. The
// likeliest cause in the wild is a Content-Security-Policy without
// 'wasm-unsafe-eval', which otherwise fails silently inside this worker.
boot().then(
    () => post({ id: 0, ok: true, kind: 'ready' }),
    (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const hint = /CSP|Content.Security|blocked/i.test(message)
            ? " The server's Content-Security-Policy must allow 'wasm-unsafe-eval'."
            : '';
        post({ id: 0, ok: false, message: `${message.replace(/\.?$/, '.')}${hint}` });
    },
);
