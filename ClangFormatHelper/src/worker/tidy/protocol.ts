/**
 * Messages between the main thread and the clang-tidy workers.
 *
 * Types only, like the format protocol, so importing it never pulls the wasm onto
 * the main thread.
 */

import type { TidyOutcome, TidyRequest } from '../../core/tidy/port.ts';

export type TidyJob =
    | { kind: 'version' }
    | { kind: 'run'; request: TidyRequest }
    | { kind: 'dumpConfig'; config: string; filename: string }
    | { kind: 'listChecks'; config: string };

export type TidyWorkerRequest =
    /**
     * Boot with an already-compiled module, so a pool compiles the 43 MB binary
     * once rather than once per worker. Absent for the first worker, which
     * compiles it and sends it back.
     */
    | { type: 'boot'; module: WebAssembly.Module | null }
    | { type: 'job'; id: number; job: TidyJob };

export type TidyJobResult =
    | { kind: 'version'; version: string }
    | { kind: 'run'; outcome: TidyOutcome }
    | { kind: 'dumpConfig'; yaml: string }
    | { kind: 'listChecks'; checks: string[] };

export type TidyWorkerResponse =
    | { type: 'ready'; module: WebAssembly.Module }
    | { type: 'boot-failed'; message: string }
    | { type: 'result'; id: number; ok: true; result: TidyJobResult }
    | { type: 'result'; id: number; ok: false; message: string };
