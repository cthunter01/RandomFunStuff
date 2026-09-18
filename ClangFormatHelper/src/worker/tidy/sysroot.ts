/**
 * Turns the sysroot tarball into the in-memory filesystem clang-tidy reads headers from.
 *
 * The tarball is plain ustar, written deterministically by
 * `tools/clang-tidy-wasm/build.sh`, so a forty-line reader is all it takes and
 * there is no dependency to audit. File contents are views into the downloaded
 * buffer rather than copies, so the ~23 MB of headers are held in memory once
 * (see `readonlyView`).
 *
 * The tree is built once per worker and shared by every run: it is read-only, and
 * the per-file read position lives in the open file descriptor, not in the inode.
 */

import { Directory, File, type Inode } from '@bjorn3/browser_wasi_shim';

const BLOCK = 512;

function readString(bytes: Uint8Array, offset: number, length: number): string {
    let end = offset;
    while (end < offset + length && bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(offset, end));
}

function readOctal(bytes: Uint8Array, offset: number, length: number): number {
    const text = readString(bytes, offset, length).trim();
    return text === '' ? 0 : parseInt(text, 8);
}

/**
 * A read-only file whose contents are a view into `bytes`.
 *
 * The shim's `File` constructor copies whatever it is given, which would double
 * the sysroot's footprint, so the view is assigned after construction instead.
 * Safe only because the file is read-only: the one shim path that assumes `data`
 * starts at offset 0 of its buffer is truncation, which a read-only file refuses.
 */
function readonlyView(bytes: Uint8Array): File {
    const file = new File(new Uint8Array(0), { readonly: true });
    file.data = bytes;
    return file;
}

/** Walks to (creating as needed) the directory for `parts`. */
function directoryAt(root: Directory, parts: readonly string[]): Directory {
    let cursor = root;
    for (const part of parts) {
        let next = cursor.contents.get(part);
        if (!next) {
            next = new Directory(new Map());
            cursor.contents.set(part, next);
        }
        if (!(next instanceof Directory)) throw new Error(`sysroot: ${parts.join('/')} is both a file and a directory`);
        cursor = next;
    }
    return cursor;
}

/**
 * Parses a ustar archive into a directory tree. Only regular files and
 * directories are expected; anything else is a build problem and fails loudly
 * rather than producing a sysroot with silent holes in it.
 */
export function directoryFromTar(tar: Uint8Array): Directory {
    const root = new Directory(new Map<string, Inode>());
    let offset = 0;
    let files = 0;
    while (offset + BLOCK <= tar.length) {
        // Two zero blocks end the archive; one is enough to know we are done.
        if (tar[offset] === 0) break;
        const name = readString(tar, offset, 100);
        const size = readOctal(tar, offset + 124, 12);
        const type = String.fromCharCode(tar[offset + 156] ?? 0);
        const prefix = readString(tar, offset + 345, 155);
        const fullName = prefix ? `${prefix}/${name}` : name;
        const parts = fullName.split('/').filter((p) => p !== '' && p !== '.');
        const dataStart = offset + BLOCK;

        if (type === '5') {
            directoryAt(root, parts);
        } else if (type === '0' || type === '\0') {
            const leaf = parts.pop();
            if (!leaf) throw new Error(`sysroot: unnamed file entry at byte ${offset}`);
            directoryAt(root, parts).contents.set(leaf, readonlyView(tar.subarray(dataStart, dataStart + size)));
            files++;
        } else {
            throw new Error(`sysroot: unsupported tar entry type '${type}' for ${fullName}`);
        }
        offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    }
    if (files === 0) throw new Error('sysroot: the archive contained no files');
    return root;
}
