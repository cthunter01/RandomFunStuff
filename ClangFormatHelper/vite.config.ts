import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The app is a fully static, client-side bundle: clang-format runs as WebAssembly in a Web Worker,
// so there is no server component and nothing the user pastes ever leaves the browser.
export default defineConfig({
    plugins: [react()],
    // Relative base so the build can be dropped on GitHub Pages or any subpath without rewriting.
    base: './',
    resolve: {
        alias: {
            '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
            '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
        },
    },
    worker: { format: 'es' },
    build: { target: 'es2022', sourcemap: true },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        // The wasm sweeps in tests/core/analysis are genuinely slow; give them room.
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
});
