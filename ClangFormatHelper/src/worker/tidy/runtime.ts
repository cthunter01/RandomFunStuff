/**
 * Hosts the clang-tidy WebAssembly module and implements TidyPort on top of it.
 *
 * clang-tidy is built as a WASI *command*: it has a `main`, runs once, and exits.
 * It cannot be re-entered — LLVM's command-line options are process-wide globals
 * that refuse to be parsed twice — so every run gets a fresh instance of the
 * already-compiled module. That costs milliseconds against a run that costs
 * hundreds of them, and it has a useful side effect: nothing can leak from one run
 * into the next, which the format runtime had to learn the hard way.
 *
 * Environment-agnostic, like the format runtime: it takes a compiled module and a
 * sysroot, so the browser Worker and the Node tests run exactly this code.
 */

import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI, type Inode } from '@bjorn3/browser_wasi_shim';
import { parseExportedFixes } from '../../core/tidy/diagnostics.ts';
import { scanIncludes } from '../../core/tidy/includes.ts';
import type { TidyOutcome, TidyPort, TidyRequest } from '../../core/tidy/port.ts';

/** The triple user code is analysed as. Must match the headers in the sysroot. */
export const ANALYSIS_TRIPLE = 'x86_64-unknown-linux-musl';

export interface TidyRuntime extends TidyPort {
    /**
     * Runs clang-tidy with arbitrary arguments over a /work holding `inputs`. For
     * tooling — the catalog generator probes the binary with it — not for the app,
     * which goes through the typed TidyPort methods.
     */
    exec(
        args: readonly string[],
        inputs?: Record<string, string>,
    ): Promise<{ exitCode: number; output: string; files: Record<string, string> }>;
    dispose(): void;
}

export interface TidyRuntimeOptions {
    /** The clang major version, which names the resource directory inside the sysroot. */
    clangMajor: string;
}

const WORK = '/work';
const FIXES = `${WORK}/fixes.yaml`;

function isCpp(filename: string): boolean {
    return !/\.c$/i.test(filename);
}

/**
 * Arguments the user never sees: where the headers are and what the code is
 * compiled as. `-stdlib` is only meaningful for C++; passing it for C would earn a
 * `clang-diagnostic-unused-command-line-argument` warning on every run.
 */
function driverArgs(filename: string, clangMajor: string): string[] {
    return [
        `--target=${ANALYSIS_TRIPLE}`,
        '--sysroot=/sysroot',
        `-resource-dir=/sysroot/lib/clang/${clangMajor}`,
        ...(isCpp(filename) ? ['-stdlib=libc++'] : []),
    ];
}

/** Where the driver finds headers inside the sysroot, for deciding what to stub. */
function searchDirs(filename: string, clangMajor: string): string[][] {
    return [
        ...(isCpp(filename) ? [['usr', 'include', 'c++', 'v1']] : []),
        ['lib', 'clang', clangMajor, 'include'],
        ['usr', 'include'],
    ];
}

function lookup(root: Directory, parts: readonly string[]): Inode | null {
    let cursor: Inode = root;
    for (const part of parts) {
        if (!(cursor instanceof Directory)) return null;
        const next = cursor.contents.get(part);
        if (!next) return null;
        cursor = next;
    }
    return cursor;
}

/** Adds an empty file at `path` under `root`, creating directories on the way. */
function addStub(root: Directory, path: string): void {
    const parts = path.split('/').filter(Boolean);
    const leaf = parts.pop();
    if (!leaf) return;
    let cursor = root;
    for (const part of parts) {
        const existing = cursor.contents.get(part);
        const next = existing instanceof Directory ? existing : new Directory(new Map());
        cursor.contents.set(part, next);
        cursor = next;
    }
    cursor.contents.set(leaf, new File(new Uint8Array(0), { readonly: true }));
}

interface Execution {
    exitCode: number;
    output: string;
    files: Map<string, Inode>;
}

export function createTidyRuntime(
    compiled: WebAssembly.Module,
    sysroot: Directory,
    options: TidyRuntimeOptions,
): TidyRuntime {
    let disposed = false;
    const encoder = new TextEncoder();

    /** Runs clang-tidy once with `args`, over a fresh /work holding `inputs` and /stubs holding `stubs`. */
    const execute = async (
        args: readonly string[],
        inputs: Record<string, string>,
        stubs: Directory = new Directory(new Map()),
    ): Promise<Execution> => {
        if (disposed) throw new Error('clang-tidy runtime has been disposed');
        const work = new Map<string, Inode>(
            Object.entries(inputs).map(([name, text]) => [name, new File(encoder.encode(text))]),
        );
        const lines: string[] = [];
        const capture = ConsoleStdout.lineBuffered((line) => lines.push(line));
        const wasi = new WASI(
            ['clang-tidy', ...args],
            [],
            [
                new OpenFile(new File(new Uint8Array(0), { readonly: true })),
                capture,
                capture,
                new PreopenDirectory(
                    '/',
                    new Map<string, Inode>([
                        ['sysroot', sysroot],
                        ['work', new Directory(work)],
                        ['stubs', stubs],
                    ]),
                ),
            ],
            // Must be explicit: the shim treats an absent `debug` as *on* and logs
            // every failed header lookup, which is thousands of lines per run.
            { debug: false },
        );
        const instance = (await WebAssembly.instantiate(compiled, {
            wasi_snapshot_preview1: wasi.wasiImport,
        })) as unknown as { exports: { memory: WebAssembly.Memory; _start: () => unknown } };
        let exitCode: number;
        try {
            exitCode = wasi.start(instance);
        } catch (error) {
            // A trap: out of memory, stack overflow, or a genuine crash in clang. The
            // instance is discarded either way, so there is nothing to recover.
            const reason = error instanceof Error ? error.message : String(error);
            lines.push(`clang-tidy crashed: ${reason}`);
            exitCode = -1;
        }
        return { exitCode, output: lines.join('\n'), files: work };
    };

    const readFile = (files: Map<string, Inode>, name: string): string | null => {
        const inode = files.get(name);
        return inode instanceof File ? new TextDecoder().decode(inode.data) : null;
    };

    const run = async (request: TidyRequest): Promise<TidyOutcome> => {
        const started = performance.now();
        const dirs = searchDirs(request.filename, options.clangMajor);
        const stubs = new Directory(new Map());
        const stubbedIncludes: string[] = [];
        for (const include of scanIncludes(request.code)) {
            const parts = include.path.split('/');
            if (dirs.some((dir) => lookup(sysroot, [...dir, ...parts]) instanceof File)) continue;
            addStub(stubs, include.path);
            stubbedIncludes.push(include.path);
        }
        const { exitCode, output, files } = await execute(
            [
                `${WORK}/${request.filename}`,
                `--config=${request.config}`,
                `--export-fixes=${FIXES}`,
                '--quiet',
                '--',
                ...driverArgs(request.filename, options.clangMajor),
                // Searched last, so a real header of the same name always wins.
                '-idirafter',
                '/stubs',
                ...request.compileArgs,
            ],
            { [request.filename]: request.code },
            stubs,
        );
        const millis = performance.now() - started;
        // No fixes file means clang-tidy stopped before analysing anything — a bad
        // config or bad arguments. The output says why.
        const fixes = readFile(files, 'fixes.yaml');
        const diagnostics = fixes === null ? [] : parseExportedFixes(fixes, request.code, `${WORK}/${request.filename}`);
        return { exitCode, diagnostics, output, millis, stubbedIncludes };
    };

    return {
        async version() {
            const { output } = await execute(['--version'], {});
            return /version (\S+)/.exec(output)?.[1] ?? output.trim();
        },
        run,
        async exec(args, inputs = {}) {
            const { exitCode, output, files } = await execute(args, inputs);
            const texts: Record<string, string> = {};
            for (const name of files.keys()) texts[name] = readFile(files, name) ?? '';
            return { exitCode, output, files: texts };
        },
        async runBatch(code, filename, compileArgs, configs) {
            const outcomes: TidyOutcome[] = [];
            for (const config of configs) outcomes.push(await run({ code, filename, config, compileArgs }));
            return outcomes;
        },
        async dumpConfig(config, filename) {
            const { exitCode, output } = await execute(
                [`--config=${config}`, '--dump-config', `${WORK}/${filename}`, '--'],
                { [filename]: '' },
            );
            if (exitCode !== 0) throw new Error(`clang-tidy rejected the config:\n${output}`);
            return output;
        },
        async listChecks(config) {
            const { exitCode, output } = await execute([`--config=${config}`, '--list-checks', '--'], {});
            if (exitCode !== 0) throw new Error(`clang-tidy rejected the config:\n${output}`);
            return output
                .split('\n')
                .filter((line) => /^\s{4}\S/.test(line))
                .map((line) => line.trim());
        },
        dispose() {
            disposed = true;
        },
    };
}
