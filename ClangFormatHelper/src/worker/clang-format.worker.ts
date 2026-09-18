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
    // compileStreaming needs the right MIME type; fall back for hosts that serve
    // .wasm as octet-stream, which is common on simple static hosting.
    const response = await fetch(wasmUrl);
    let compiled: WebAssembly.Module;
    try {
        compiled = await WebAssembly.compileStreaming(response.clone());
    } catch {
        compiled = await WebAssembly.compile(await response.arrayBuffer());
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

void boot().then(() => post({ id: 0, ok: true, kind: 'ready' }));
