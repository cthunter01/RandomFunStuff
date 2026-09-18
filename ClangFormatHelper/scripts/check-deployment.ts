/**
 * Checks a live deployment against the local build.
 *
 *   npm run check:deploy -- https://clang-format.example.com/
 *   npm run check:deploy -- https://example.com/tools/clang-format/
 *
 * Run it after uploading, against the same dist/ you uploaded. It fetches the
 * real files and verifies the things that go wrong in practice: the wasm MIME
 * type, caching of hashed assets vs. the entry point, compression that is
 * actually applied (and applied exactly once — double-compressed responses are a
 * classic Apache mistake that no browser error message will point you at),
 * security headers surviving into every location, and missing files producing a
 * real 404 rather than index.html.
 *
 * Uses node:http directly rather than fetch, because fetch transparently
 * decompresses and would hide exactly the bugs this exists to catch.
 */

import { readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const distFlag = args.indexOf('--dist');
// The build to compare against; defaults to ./dist, the one `npm run release` writes.
const DIST = path.resolve(distFlag >= 0 ? args.splice(distFlag, 2)[1]! : path.join(ROOT, 'dist'));

const target = args[0];
if (!target) {
    process.stderr.write(
        'usage: npm run check:deploy -- <url of the deployed app, e.g. https://host/path/> [--dist <build dir>]\n',
    );
    process.exit(2);
}
const base = new URL(target.endsWith('/') ? target : `${target}/`);

interface Response {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

function get(url: URL, headers: Record<string, string> = {}): Promise<Response> {
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = client.get(url, { headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        request.on('error', reject);
        request.setTimeout(30_000, () => request.destroy(new Error(`timed out fetching ${url}`)));
    });
}

type Level = 'PASS' | 'WARN' | 'FAIL';
const results: Array<{ level: Level; message: string }> = [];
const record = (level: Level, message: string): void => {
    results.push({ level, message });
    const mark = level === 'PASS' ? 'ok  ' : level === 'WARN' ? 'warn' : 'FAIL';
    process.stdout.write(`${mark}  ${message}\n`);
};
const check = (ok: boolean, pass: string, fail: string, level: Level = 'FAIL'): void =>
    record(ok ? 'PASS' : level, ok ? pass : fail);

const header = (res: Response, name: string): string => {
    const value = res.headers[name.toLowerCase()];
    return Array.isArray(value) ? value.join(', ') : (value ?? '');
};

const decode = (res: Response): Buffer => {
    const encoding = header(res, 'content-encoding').toLowerCase();
    if (encoding === 'br') return brotliDecompressSync(res.body);
    if (encoding === 'gzip') return gunzipSync(res.body);
    return res.body;
};

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;

const SECURITY_HEADERS = ['x-content-type-options', 'referrer-policy'];

function checkSecurityHeaders(res: Response, label: string): void {
    const missing = SECURITY_HEADERS.filter((h) => !header(res, h));
    check(
        missing.length === 0,
        `${label}: security headers present`,
        `${label}: missing ${missing.join(', ')} — on nginx, a location with its own add_header inherits none from the server block`,
        'WARN',
    );
}

async function main(): Promise<void> {
    const indexHtml = await readFile(path.join(DIST, 'index.html'), 'utf8').catch(() => {
        throw new Error('No local dist/index.html to compare against. Run "npm run release" first.');
    });
    const entryJs = /src="\.\/(assets\/[^"]+\.js)"/.exec(indexHtml)?.[1];
    const entryCss = /href="\.\/(assets\/[^"]+\.css)"/.exec(indexHtml)?.[1];
    const assets = await readdir(path.join(DIST, 'assets'));
    // The large binaries: the clang-format module, the clang-tidy module, and the
    // header tarball clang-tidy analyses against. Each is checked the same way.
    const binaries = assets
        .filter((f) => /\.(wasm|tar)$/.test(f))
        .map((file) => ({
            file,
            label: file.startsWith('clang-tidy-sysroot')
                ? 'clang-tidy headers'
                : file.startsWith('clang-tidy')
                  ? 'clang-tidy module'
                  : 'clang-format module',
            mime: file.endsWith('.wasm') ? /^application\/wasm$/ : /^application\/(x-tar|octet-stream)$/,
        }));
    if (!entryJs || !entryCss || !binaries.some((b) => b.file.endsWith('.wasm'))) {
        throw new Error('Could not find the entry script, stylesheet and wasm in dist/.');
    }

    process.stdout.write(`checking ${base.href} against ${path.relative(process.cwd(), DIST)}/\n\n`);

    // ---- the entry point ----
    const page = await get(base);
    check(page.status === 200, 'entry point: 200', `entry point: HTTP ${page.status}`);
    check(
        /^text\/html/.test(header(page, 'content-type')),
        'entry point: served as text/html',
        `entry point: Content-Type is "${header(page, 'content-type')}"`,
    );
    check(
        decode(page).toString('utf8').includes(entryJs),
        'entry point: is this build (references the current asset hashes)',
        'entry point: references different asset hashes — stale upload, or a cached index.html',
    );
    const pageCache = header(page, 'cache-control');
    check(
        /no-cache|no-store|max-age=0|must-revalidate/.test(pageCache),
        `entry point: always revalidated (Cache-Control: ${pageCache})`,
        `entry point: Cache-Control is "${pageCache || '(none)'}" — browsers may keep an index.html naming deleted assets`,
    );
    checkSecurityHeaders(page, 'entry point');

    // ---- hashed assets ----
    for (const [label, file, mime] of [
        ['script', entryJs, /^(text|application)\/javascript/],
        ['stylesheet', entryCss, /^text\/css/],
        ...binaries.map((b) => [b.label, `assets/${b.file}`, b.mime] as const),
    ] as const) {
        const res = await get(new URL(file, base), { 'Accept-Encoding': 'identity' });
        check(res.status === 200, `${label}: 200`, `${label}: HTTP ${res.status} for ${file}`);
        const type = header(res, 'content-type').split(';')[0]!.trim();
        check(
            mime.test(type),
            `${label}: served as ${type}`,
            label.endsWith('module')
                ? `${label}: Content-Type is "${type}" — must be exactly application/wasm or streaming compilation fails (the app falls back, slower, with a console warning)`
                : `${label}: Content-Type is "${type}"`,
        );
        const cache = header(res, 'cache-control');
        check(
            /max-age=\d{7,}/.test(cache) && /immutable/.test(cache),
            `${label}: cached long-term (Cache-Control: ${cache})`,
            `${label}: Cache-Control is "${cache || '(none)'}" — hashed assets can be cached for a year with "immutable"`,
            'WARN',
        );
        checkSecurityHeaders(res, label);
    }

    // ---- compression, verified byte-for-byte ----
    for (const binary of binaries) {
        const local = await readFile(path.join(DIST, 'assets', binary.file));
        const url = new URL(`assets/${binary.file}`, base);
        const name = binary.label;
        for (const encoding of ['br', 'gzip', 'identity'] as const) {
            const res = await get(url, { 'Accept-Encoding': encoding });
            const served = header(res, 'content-encoding').toLowerCase() || 'identity';
            let decoded: Buffer;
            try {
                decoded = decode(res);
            } catch {
                record('FAIL', `${name} with Accept-Encoding ${encoding}: body does not decode as "${served}"`);
                continue;
            }
            if (!decoded.equals(local)) {
                // The usual cause: a precompressed file compressed again on the fly.
                record(
                    'FAIL',
                    `${name} with Accept-Encoding ${encoding}: decodes to ${kb(decoded.length)}, expected ${kb(local.length)} — likely compressed twice`,
                );
                continue;
            }
            if (encoding === 'identity') {
                check(served === 'identity', `${name} uncompressed when the client asks for none`, `served "${served}" to a client that asked for identity`);
                continue;
            }
            if (served === 'identity') {
                record('WARN', `${name} with Accept-Encoding ${encoding}: sent uncompressed (${kb(res.body.length)})`);
                continue;
            }
            record('PASS', `${name} with Accept-Encoding ${encoding}: ${served}, ${kb(res.body.length)}, byte-identical once decoded`);
            // Caching has to be checked on the compressed response specifically: that is
            // what every real browser receives, and on Apache the precompressed variant
            // is answered by a rewritten request that can miss the caching rule entirely.
            const cache = header(res, 'cache-control');
            check(
                /max-age=\d{7,}/.test(cache) && /immutable/.test(cache),
                `${name} with Accept-Encoding ${encoding}: still cached long-term`,
                `${name} with Accept-Encoding ${encoding}: Cache-Control is "${cache || '(none)'}" — only uncompressed responses are cached, so real browsers re-download it on every visit`,
                'WARN',
            );
            check(
                /accept-encoding/i.test(header(res, 'vary')),
                `${name} with Accept-Encoding ${encoding}: Vary: Accept-Encoding set`,
                `${name} with Accept-Encoding ${encoding}: no Vary: Accept-Encoding — a shared cache could hand compressed bytes to a client that cannot decode them`,
            );
        }
    }

    // ---- things that should not be there ----
    const missing = await get(new URL(`assets/does-not-exist-${Date.now()}.js`, base));
    check(
        missing.status === 404,
        'a missing asset is a real 404',
        missing.status === 200 && /text\/html/.test(header(missing, 'content-type'))
            ? 'a missing asset returns index.html with 200 — a single-page-app fallback is configured; remove it, this app has no client-side routes'
            : `a missing asset returns HTTP ${missing.status}`,
    );
    const dotfile = await get(new URL('.htaccess', base));
    check(dotfile.status !== 200, `dotfiles are not served (HTTP ${dotfile.status})`, 'a dotfile (.htaccess) is served with 200', 'WARN');

    // ---- context the browser cares about ----
    check(
        base.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname),
        'secure context (HTTPS or localhost)',
        'plain HTTP on a non-local host: the browser disables the clipboard API, so "Copy" will not work — serve over HTTPS',
        'WARN',
    );

    const fails = results.filter((r) => r.level === 'FAIL').length;
    const warns = results.filter((r) => r.level === 'WARN').length;
    process.stdout.write(`\n${results.length - fails - warns} passed, ${warns} warning(s), ${fails} failure(s)\n`);
    process.exitCode = fails > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
});
