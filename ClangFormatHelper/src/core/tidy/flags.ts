/**
 * Splits a compiler command line the way a shell would, near enough: whitespace
 * separates arguments, and single or double quotes group them. Good for what
 * people type into a flags box (`-std=c++23 -DNAME="a b"`), not a shell parser.
 */
export function splitFlags(text: string): string[] {
    const out: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let started = false;
    for (const ch of text) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
        } else if (/\s/.test(ch)) {
            if (started) out.push(current);
            current = '';
            started = false;
        } else {
            current += ch;
            started = true;
        }
    }
    if (started) out.push(current);
    return out;
}

/** The file name a sample is analysed under; its extension is what selects C or C++. */
export function tidyFilename(languageId: string): string {
    return languageId === 'c' ? 'sample.c' : 'sample.cpp';
}
