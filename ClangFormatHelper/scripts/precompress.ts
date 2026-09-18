/**
 * Writes `.br` and `.gz` siblings for every compressible file in dist/.
 *
 *   npm run release        # build, then this
 *
 * The web server then serves those files as-is (nginx `gzip_static`, the rewrite
 * rules in deploy/apache) instead of compressing on every request. That matters
 * more than usual here because of the 2.5 MB wasm module: maximum-effort brotli
 * takes it to ~860 KB, against ~1.08 MB for gzip, but brotli at that effort takes
 * seconds per file — far too slow to do per request, trivial to do once at deploy.
 *
 * Uses Node's own zlib, so it needs no gzip or brotli binaries and works the same
 * on every platform.
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, process.argv[2] ?? 'dist');

/** Worth compressing: text formats plus wasm. Images and fonts are already compressed. */
const COMPRESSIBLE = /\.(?:html|js|mjs|css|wasm|json|map|svg|txt)$/i;
/** Below this, the headers cost more than compression saves. */
const MIN_BYTES = 1024;

async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield full;
    }
}

function brotli(data: Buffer): Buffer {
    return brotliCompressSync(data, {
        params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
        },
    });
}

const rows: Array<{ file: string; raw: number; gz: number; br: number }> = [];

try {
    await stat(DIST);
} catch {
    process.stderr.write(`No build output at ${DIST}. Run "npm run build" first.\n`);
    process.exit(1);
}

for await (const file of walk(DIST)) {
    if (!COMPRESSIBLE.test(file)) continue;
    const data = await readFile(file);
    if (data.length < MIN_BYTES) continue;

    const gz = gzipSync(data, { level: 9 });
    const br = brotli(data);
    // Only keep a variant that actually wins; a server will happily serve a larger
    // "compressed" file if it exists.
    if (gz.length < data.length) await writeFile(`${file}.gz`, gz);
    if (br.length < data.length) await writeFile(`${file}.br`, br);
    rows.push({ file: path.relative(DIST, file), raw: data.length, gz: gz.length, br: br.length });
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`.padStart(11);
rows.sort((a, b) => b.raw - a.raw);
process.stdout.write(`${'file'.padEnd(46)}${'raw'.padStart(11)}${'gzip'.padStart(11)}${'brotli'.padStart(11)}\n`);
for (const row of rows) {
    process.stdout.write(`${row.file.padEnd(46)}${kb(row.raw)}${kb(row.gz)}${kb(row.br)}\n`);
}
const total = (key: 'raw' | 'gz' | 'br'): number => rows.reduce((n, r) => n + r[key], 0);
process.stdout.write(
    `${'total'.padEnd(46)}${kb(total('raw'))}${kb(total('gz'))}${kb(total('br'))}\n` +
        `precompressed ${rows.length} files in ${path.relative(ROOT, DIST)}/\n`,
);
