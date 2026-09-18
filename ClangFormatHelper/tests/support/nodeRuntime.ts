/**
 * Boots the real clang-format wasm in Node for tests.
 *
 * Uses the same `createRuntime` the browser Worker does, so the engine tests
 * exercise production code rather than a mock. No DOM, no bundler, no Worker.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createRuntime, type Runtime } from '../../src/worker/runtime.ts';

const require = createRequire(import.meta.url);

let shared: Promise<Runtime> | null = null;

/**
 * A process-wide runtime. Compiling the 2.5 MB module takes long enough that
 * doing it per test file is a meaningful waste; the module is stateless between
 * calls, so sharing is safe.
 */
export function sharedRuntime(): Promise<Runtime> {
    shared ??= (async () => {
        const wasmPath = require.resolve('@wasm-fmt/clang-format/clang-format.wasm');
        const bytes = await readFile(wasmPath);
        return createRuntime(await WebAssembly.compile(bytes));
    })();
    return shared;
}
