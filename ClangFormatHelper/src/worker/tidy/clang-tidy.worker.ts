/**
 * A clang-tidy worker. Several of these form the pool behind `TidyClient`.
 *
 * Each holds its own copy of the sysroot and runs one clang-tidy at a time; the
 * pool provides the parallelism. The wasm and the header tarball are imported as
 * URLs, so they are fetched only when a worker actually boots — which is only
 * when the user first opens Tidy. clang-format users never download them.
 */

import wasmUrl from '../../../vendor/clang-tidy/clang-tidy-23.1.1.wasm?url';
import sysrootUrl from '../../../vendor/clang-tidy/clang-tidy-sysroot-23.1.1.tar?url';
import { createTidyRuntime, type TidyRuntime } from './runtime.ts';
import { directoryFromTar } from './sysroot.ts';
import type { TidyJobResult, TidyWorkerRequest, TidyWorkerResponse } from './protocol.ts';

const CLANG_MAJOR = '23';

let runtime: TidyRuntime | null = null;

const post = (message: TidyWorkerResponse): void => {
    self.postMessage(message);
};

async function fetchOk(url: string, what: string): Promise<Response> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The clang-tidy ${what} failed to download (HTTP ${response.status} for ${response.url}).`);
    return response;
}

async function compile(): Promise<WebAssembly.Module> {
    const response = await fetchOk(wasmUrl, 'module');
    try {
        return await WebAssembly.compileStreaming(response.clone());
    } catch (streamingError) {
        // Same fallback as the format worker: a wrong Content-Type costs speed, not function.
        try {
            return await WebAssembly.compile(await response.arrayBuffer());
        } catch (error) {
            throw error instanceof Error ? error : streamingError;
        }
    }
}

async function boot(module: WebAssembly.Module | null): Promise<WebAssembly.Module> {
    const [compiled, tar] = await Promise.all([
        module ?? compile(),
        fetchOk(sysrootUrl, 'headers').then((r) => r.arrayBuffer()),
    ]);
    runtime = createTidyRuntime(compiled, directoryFromTar(new Uint8Array(tar)), { clangMajor: CLANG_MAJOR });
    return compiled;
}

async function perform(job: Extract<TidyWorkerRequest, { type: 'job' }>['job']): Promise<TidyJobResult> {
    if (!runtime) throw new Error('clang-tidy worker used before it booted');
    switch (job.kind) {
        case 'version':
            return { kind: 'version', version: await runtime.version() };
        case 'run':
            return { kind: 'run', outcome: await runtime.run(job.request) };
        case 'dumpConfig':
            return { kind: 'dumpConfig', yaml: await runtime.dumpConfig(job.config, job.filename) };
        case 'listChecks':
            return { kind: 'listChecks', checks: await runtime.listChecks(job.config) };
    }
}

self.onmessage = async (event: MessageEvent<TidyWorkerRequest>) => {
    const message = event.data;
    if (message.type === 'boot') {
        try {
            post({ type: 'ready', module: await boot(message.module) });
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            const hint = /CSP|Content.Security|blocked/i.test(text)
                ? " The server's Content-Security-Policy must allow 'wasm-unsafe-eval'."
                : '';
            post({ type: 'boot-failed', message: `${text.replace(/\.?$/, '.')}${hint}` });
        }
        return;
    }
    try {
        post({ type: 'result', id: message.id, ok: true, result: await perform(message.job) });
    } catch (error) {
        post({ type: 'result', id: message.id, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
};
