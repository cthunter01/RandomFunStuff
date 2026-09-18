/**
 * Finds the `#include`s in a sample, so headers the analyser does not have can be
 * stood in for.
 *
 * Pasted code nearly always includes its own project's headers, and a missing
 * header is a *fatal* error to clang: it suppresses every compiler diagnostic
 * after it and leaves the checks working on a half-understood file. So headers
 * the sysroot cannot supply are replaced by empty files, searched last
 * (`-idirafter`), so a real header of the same name always wins. The UI is told
 * which ones were stubbed, since anything they would have declared is unknown.
 */

export interface IncludeDirective {
    path: string;
    /** `<...>` rather than `"..."`. */
    angled: boolean;
}

/**
 * Every include directive, in order, deduplicated. Directives inside `#if 0` or
 * behind a macro are included too; stubbing a header nothing reads is harmless.
 */
export function scanIncludes(code: string): IncludeDirective[] {
    const seen = new Set<string>();
    const out: IncludeDirective[] = [];
    for (const match of code.matchAll(/^[ \t]*#[ \t]*include(?:_next)?[ \t]*([<"])([^>"\n]+)[>"]/gm)) {
        const path = match[2]!.trim();
        // Only plain relative paths: nothing absolute, nothing escaping upwards.
        if (!path || path.startsWith('/') || path.split('/').includes('..') || seen.has(path)) continue;
        seen.add(path);
        out.push({ path, angled: match[1] === '<' });
    }
    return out;
}
