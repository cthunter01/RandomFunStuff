/**
 * Messages between the main thread and the formatter worker.
 *
 * This module is the one part of `src/worker` that `src/core` and `src/ui` are
 * allowed to import — it is types only, so importing it never drags the wasm
 * onto the main thread.
 */

import type { FormatOutcome } from '../core/formatter/port.ts';

export type RequestId = number;

export type WorkerRequest =
    | { id: RequestId; kind: 'version' }
    | { id: RequestId; kind: 'format'; code: string; filename: string; style: string }
    | { id: RequestId; kind: 'formatBatch'; code: string; filename: string; styles: readonly string[] }
    | { id: RequestId; kind: 'dumpConfig'; style: string; filename: string };

export type WorkerResponse =
    | { id: RequestId; ok: true; kind: 'version'; version: string }
    | { id: RequestId; ok: true; kind: 'format'; outcome: FormatOutcome }
    | { id: RequestId; ok: true; kind: 'formatBatch'; outcomes: FormatOutcome[] }
    | { id: RequestId; ok: true; kind: 'dumpConfig'; yaml: string }
    | { id: RequestId; ok: false; message: string }
    | { id: RequestId; ok: true; kind: 'ready' };
