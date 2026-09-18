/**
 * Main-thread facade over the formatter worker.
 *
 * Implements the same `FormatterPort` the engine is written against, so the
 * impact and inference code neither knows nor cares that there is a Worker and a
 * wasm module behind it.
 */

import type { FormatOutcome, FormatRequest, FormatterPort } from '../core/formatter/port.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

type Pending = { resolve: (value: never) => void; reject: (error: Error) => void };

/** Omit must distribute over the request union, or every variant collapses to its common keys. */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface FormatterClient extends FormatterPort {
    /** Resolves once the wasm module has been compiled and is answering. */
    ready: Promise<void>;
    terminate(): void;
}

export function createFormatterClient(): FormatterClient {
    const worker = new Worker(new URL('./clang-format.worker.ts', import.meta.url), { type: 'module' });
    const pending = new Map<number, Pending>();
    let nextId = 1;

    let signalReady: () => void;
    const ready = new Promise<void>((resolve) => {
        signalReady = resolve;
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        if (response.ok && response.kind === 'ready') {
            signalReady();
            return;
        }
        const waiter = pending.get(response.id);
        if (!waiter) return;
        pending.delete(response.id);
        if (!response.ok) waiter.reject(new Error(response.message));
        else waiter.resolve(response as never);
    };

    worker.onerror = (event) => {
        const error = new Error(`Formatter worker failed: ${event.message}`);
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
    };

    const send = <R extends WorkerResponse>(request: WithoutId<WorkerRequest>): Promise<R> =>
        new Promise<R>((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve: resolve as never, reject });
            worker.postMessage({ ...request, id } as WorkerRequest);
        });

    return {
        ready,
        async version() {
            return (await send<Extract<WorkerResponse, { kind: 'version' }>>({ kind: 'version' })).version;
        },
        async format(request: FormatRequest): Promise<FormatOutcome> {
            const response = await send<Extract<WorkerResponse, { kind: 'format' }>>({
                kind: 'format',
                code: request.code,
                filename: request.filename,
                style: request.style,
            });
            return response.outcome;
        },
        async formatBatch(code, filename, styles) {
            const response = await send<Extract<WorkerResponse, { kind: 'formatBatch' }>>({
                kind: 'formatBatch',
                code,
                filename,
                styles,
            });
            return response.outcomes;
        },
        async dumpConfig(style, filename) {
            return (
                await send<Extract<WorkerResponse, { kind: 'dumpConfig' }>>({ kind: 'dumpConfig', style, filename })
            ).yaml;
        },
        terminate() {
            worker.terminate();
        },
    };
}
