/**
 * Main-thread facade over a small pool of clang-tidy workers.
 *
 * Implements `TidyPort`, so the analysis engine neither knows nor cares that
 * there are Workers behind it. Two scheduling decisions matter:
 *
 *  - **Interactive jobs jump the queue.** The live run after an edit, and the
 *    config queries, go ahead of any queued analysis runs. A sweep can queue a
 *    dozen runs of a second or two each; without priority an edit would wait for
 *    all of them. With it, an edit waits for at most the one run in progress.
 *  - **The pool grows on demand.** One worker boots when Tidy opens. More are
 *    started only when a batch arrives, each adopting the module the first one
 *    compiled — 43 MB is compiled once, not once per worker.
 */

import type { TidyOutcome, TidyPort, TidyRequest } from '../../core/tidy/port.ts';
import type { TidyJob, TidyJobResult, TidyWorkerRequest, TidyWorkerResponse } from './protocol.ts';

export interface TidyClient extends TidyPort {
    /** Resolves once the first worker has compiled clang-tidy and loaded its headers. */
    ready: Promise<void>;
    /** Workers currently in the pool. */
    readonly size: number;
    terminate(): void;
}

interface Queued {
    id: number;
    job: TidyJob;
    interactive: boolean;
    resolve: (result: TidyJobResult) => void;
    reject: (error: Error) => void;
}

interface Slot {
    worker: Worker;
    ready: boolean;
    current: Queued | null;
}

/** Leave a core for the page itself; beyond four, memory grows faster than throughput. */
function defaultPoolSize(): number {
    const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2;
    return Math.max(1, Math.min(4, cores - 1));
}

export function createTidyClient(options: { maxWorkers?: number } = {}): TidyClient {
    const maxWorkers = options.maxWorkers ?? defaultPoolSize();
    const slots: Slot[] = [];
    const queue: Queued[] = [];
    let module: WebAssembly.Module | null = null;
    let nextId = 1;
    let terminated = false;

    let signalReady: () => void;
    let signalFailed: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
        signalReady = resolve;
        signalFailed = reject;
    });

    const dispatch = (): void => {
        for (const slot of slots) {
            if (!slot.ready || slot.current || queue.length === 0) continue;
            const index = Math.max(0, queue.findIndex((q) => q.interactive));
            const [next] = queue.splice(index, 1);
            slot.current = next!;
            slot.worker.postMessage({ type: 'job', id: next!.id, job: next!.job } satisfies TidyWorkerRequest);
        }
        // Work still waiting and nobody free: grow, if the pool may and a module exists to share.
        const idle = slots.filter((s) => s.ready && !s.current).length;
        const booting = slots.filter((s) => !s.ready).length;
        if (module && queue.length > idle + booting && slots.length < maxWorkers) spawn();
    };

    const spawn = (): void => {
        const worker = new Worker(new URL('./clang-tidy.worker.ts', import.meta.url), { type: 'module' });
        const slot: Slot = { worker, ready: false, current: null };
        slots.push(slot);

        worker.onmessage = (event: MessageEvent<TidyWorkerResponse>) => {
            const message = event.data;
            if (message.type === 'ready') {
                module ??= message.module;
                slot.ready = true;
                signalReady();
                dispatch();
                return;
            }
            if (message.type === 'boot-failed') {
                slots.splice(slots.indexOf(slot), 1);
                worker.terminate();
                // Only the first boot failing means Tidy is unusable; a later one just
                // leaves the pool a worker short.
                if (!module) signalFailed(new Error(message.message));
                return;
            }
            const job = slot.current;
            slot.current = null;
            if (job && job.id === message.id) {
                if (message.ok) job.resolve(message.result);
                else job.reject(new Error(message.message));
            }
            dispatch();
        };

        worker.onerror = (event) => {
            // The worker itself died — most likely out of memory. Fail its job, drop
            // it, and let the pool replace it on demand.
            const job = slot.current;
            slots.splice(slots.indexOf(slot), 1);
            worker.terminate();
            job?.reject(new Error(`clang-tidy worker failed: ${event.message || 'out of memory?'}`));
            if (!module && slots.length === 0) signalFailed(new Error(event.message || 'clang-tidy worker failed to start'));
            dispatch();
        };

        worker.postMessage({ type: 'boot', module } satisfies TidyWorkerRequest);
    };

    const submit = <K extends TidyJobResult['kind']>(
        job: TidyJob,
        interactive: boolean,
    ): Promise<Extract<TidyJobResult, { kind: K }>> =>
        new Promise((resolve, reject) => {
            if (terminated) {
                reject(new Error('clang-tidy client has been terminated'));
                return;
            }
            queue.push({ id: nextId++, job, interactive, resolve: resolve as (r: TidyJobResult) => void, reject });
            dispatch();
        });

    spawn();

    return {
        ready,
        get size() {
            return slots.length;
        },
        async version() {
            return (await submit<'version'>({ kind: 'version' }, true)).version;
        },
        async run(request: TidyRequest): Promise<TidyOutcome> {
            return (await submit<'run'>({ kind: 'run', request }, true)).outcome;
        },
        async runBatch(code, filename, compileArgs, configs) {
            const results = await Promise.all(
                configs.map((config) =>
                    submit<'run'>({ kind: 'run', request: { code, filename, config, compileArgs } }, false),
                ),
            );
            return results.map((r) => r.outcome);
        },
        async dumpConfig(config, filename) {
            return (await submit<'dumpConfig'>({ kind: 'dumpConfig', config, filename }, true)).yaml;
        },
        async listChecks(config) {
            return (await submit<'listChecks'>({ kind: 'listChecks', config }, true)).checks;
        },
        terminate() {
            terminated = true;
            for (const slot of slots) slot.worker.terminate();
            for (const job of queue.splice(0)) job.reject(new Error('clang-tidy client terminated'));
            slots.length = 0;
        },
    };
}
