/**
 * Parses clang-format's own diagnostics out of captured stderr.
 *
 * This exists because the published JS wrapper throws away everything useful: a
 * malformed config surfaces as `Error: Error reading .clang-format: Invalid
 * argument`, with no hint about which key. The real message goes to Emscripten's
 * stderr, in clang's standard shape:
 *
 *     <command-line>:1:22: error: unknown key 'NotAnOption'
 *     {BasedOnStyle: LLVM, NotAnOption: 3}
 *                          ^~~~~~~~~~~
 *
 * Capturing `printErr` and parsing this is what turns the YAML pane into a real
 * editor with inline errors. Pure and unit-tested; no wasm involved.
 */

import type { Diagnostic } from './port.ts';

const HEADER = /^(?<file>.*?):(?<line>\d+):(?<column>\d+):\s+(?<severity>error|warning|note):\s+(?<message>.*)$/;
const CARET = /^(?<lead>\s*)(?<carets>\^~*)\s*$/;

export function parseDiagnostics(stderr: readonly string[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (let i = 0; i < stderr.length; i++) {
        const match = HEADER.exec(stderr[i] ?? '');
        if (!match?.groups) continue;
        // clang prints the offending source on the next line and a caret run under
        // it; the caret run's width is the span to underline in the editor.
        const caret = CARET.exec(stderr[i + 2] ?? '');
        diagnostics.push({
            severity: match.groups['severity'] as Diagnostic['severity'],
            line: Number(match.groups['line']),
            column: Number(match.groups['column']),
            length: caret?.groups ? caret.groups['carets']!.length : 0,
            message: match.groups['message']!,
        });
    }
    return diagnostics;
}
