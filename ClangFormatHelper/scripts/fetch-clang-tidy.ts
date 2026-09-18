/**
 * Puts the pinned clang-tidy wasm build into `vendor/clang-tidy/`.
 *
 *   npm run tidy:fetch              # no-op when the vendored files already match the pins
 *   npm run tidy:fetch -- --force   # fetch again regardless
 *
 * Sources, in order: files already in place; a local build in
 * `.build/clang-tidy-wasm/out/` (from `tools/clang-tidy-wasm/build.sh`); the
 * GitHub release named in `tools/clang-tidy-wasm/release.json`. Whatever the
 * source, a file is only accepted if its SHA-256 matches the pin — so a local
 * build that differs from the published one is refused, not silently used.
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { release, sha256, VENDOR_DIR, vendorPath, type ReleaseFile } from './tidy-binary.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_BUILD = path.join(ROOT, '.build/clang-tidy-wasm/out');
const force = process.argv.includes('--force');

async function matches(file: string, pin: ReleaseFile): Promise<boolean> {
    return existsSync(file) && sha256(new Uint8Array(await readFile(file))) === pin.sha256;
}

async function fetchOne(pin: ReleaseFile): Promise<string> {
    const target = vendorPath(pin);
    if (!force && (await matches(target, pin))) return 'already in place';

    const local = path.join(LOCAL_BUILD, pin.name);
    if (await matches(local, pin)) {
        await copyFile(local, target);
        return 'copied from the local build';
    }

    const url = `${release.baseUrl}${pin.name}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `${pin.name}: HTTP ${response.status} from ${url}\n` +
                (response.status === 404
                    ? `  The release ${release.releaseTag} does not exist yet, or lacks this file. Either publish it ` +
                      '(see tools/clang-tidy-wasm/README.md), or build locally with tools/clang-tidy-wasm/build.sh ' +
                      'and point release.json at the result.'
                    : '  Check your network connection and try again.'),
        );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== pin.sha256) {
        throw new Error(`${pin.name}: downloaded file has SHA-256 ${actual}, but release.json pins ${pin.sha256}. Refusing it.`);
    }
    // Write-then-rename, so an interrupted download never leaves a truncated file
    // that a later run would have to notice.
    await writeFile(`${target}.part`, bytes);
    await rename(`${target}.part`, target);
    return `downloaded ${(bytes.length / 1048576).toFixed(1)} MB`;
}

async function main(): Promise<void> {
    await mkdir(VENDOR_DIR, { recursive: true });
    for (const pin of [release.files.wasm, release.files.sysroot]) {
        process.stdout.write(`${pin.name}: ${await fetchOne(pin)}\n`);
    }
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
