/**
 * Locates and boots the pinned clang-tidy wasm build in Node.
 *
 * The binary is not committed — at 43 MB it would bloat every clone — and is not
 * an npm package either. `tools/clang-tidy-wasm/release.json` pins it by URL and
 * SHA-256, `npm run tidy:fetch` puts it in `vendor/clang-tidy/`, and everything
 * that needs it in Node (the catalog generator, the tests) comes through here.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTidyRuntime, type TidyRuntime } from '../src/worker/tidy/runtime.ts';
import { directoryFromTar } from '../src/worker/tidy/sysroot.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface ReleaseFile {
    name: string;
    bytes: number;
    sha256: string;
}

export interface TidyRelease {
    llvmVersion: string;
    clangMajor: string;
    analysisTriple: string;
    releaseTag: string;
    baseUrl: string;
    files: { wasm: ReleaseFile; sysroot: ReleaseFile };
}

export const RELEASE_FILE = path.join(ROOT, 'tools/clang-tidy-wasm/release.json');
export const VENDOR_DIR = path.join(ROOT, 'vendor/clang-tidy');
export const release = JSON.parse(readFileSync(RELEASE_FILE, 'utf8')) as TidyRelease;

export function vendorPath(file: ReleaseFile): string {
    return path.join(VENDOR_DIR, file.name);
}

export function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** Throws with the fix in the message when the vendored files are missing or not the pinned ones. */
export async function readVendored(
    verify = false,
): Promise<{ wasm: Uint8Array<ArrayBuffer>; sysroot: Uint8Array<ArrayBuffer> }> {
    const read = async (file: ReleaseFile): Promise<Uint8Array<ArrayBuffer>> => {
        const where = vendorPath(file);
        if (!existsSync(where)) {
            throw new Error(`${path.relative(ROOT, where)} is missing. Run: npm run tidy:fetch`);
        }
        const bytes = Uint8Array.from(await readFile(where));
        if (verify && sha256(bytes) !== file.sha256) {
            throw new Error(
                `${path.relative(ROOT, where)} is not the build pinned in tools/clang-tidy-wasm/release.json. ` +
                    'Run: npm run tidy:fetch -- --force',
            );
        }
        return bytes;
    };
    return { wasm: await read(release.files.wasm), sysroot: await read(release.files.sysroot) };
}

export async function loadTidyRuntime(options: { verify?: boolean } = {}): Promise<TidyRuntime> {
    const { wasm, sysroot } = await readVendored(options.verify);
    return createTidyRuntime(await WebAssembly.compile(wasm), directoryFromTar(sysroot), {
        clangMajor: release.clangMajor,
    });
}
