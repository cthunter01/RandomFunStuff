/**
 * Boots the real clang-tidy wasm in Node for tests.
 *
 * Same idea as `nodeRuntime.ts`: the production `createTidyRuntime`, driven
 * directly, with no Worker, bundler or DOM. The binary comes from
 * `vendor/clang-tidy/` (`npm run tidy:fetch`); without it these tests fail with
 * that instruction rather than skipping, because a silently skipped engine test
 * is worse than a loud one.
 */

import { loadTidyRuntime } from '../../scripts/tidy-binary.ts';
import type { TidyRuntime } from '../../src/worker/tidy/runtime.ts';

let shared: Promise<TidyRuntime> | null = null;

/** One compiled module per test process; every run gets a fresh instance anyway. */
export function sharedTidyRuntime(): Promise<TidyRuntime> {
    shared ??= loadTidyRuntime();
    return shared;
}
