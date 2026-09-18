/**
 * The `Checks:` glob list — what a `.clang-tidy` file says, and what it means.
 *
 * `Checks` is an ordered, comma-separated list of globs. A plain glob enables the
 * matching checks, a `-`-prefixed one disables them, and later entries win over
 * earlier ones. The model keeps that list as written rather than as a set of
 * enabled check names, for two reasons: it is what a hand-written file looks like
 * (`-*,bugprone-*,-bugprone-easily-swappable-parameters`), and a module glob
 * picks up the checks a future clang-tidy adds to that module, which a flattened
 * list silently would not.
 *
 * clang-tidy does not *replace* its default checks with yours, it appends yours
 * to them. In 23.1.1 that default is only `clang-diagnostic-*` — compiler
 * warnings, reported as if they were checks — so `Checks: 'bugprone-*'` also
 * reports `-Wunused-variable` and friends unless the list starts with `-*`. (It
 * used to include `clang-analyzer-*` too; older advice about that is out of date.)
 * The default is read from the binary into the catalog rather than written down
 * here, and passed in as `builtin`, so the model cannot drift from the tool.
 *
 * The binary's `--list-checks` remains the authority on what is enabled; this is
 * for editing, and a test pins it to the binary's answer.
 */

export interface CheckGlob {
    /** The glob without its sign, e.g. `bugprone-*`. */
    pattern: string;
    /** False for a `-`-prefixed (disabling) glob. */
    enable: boolean;
}

/** Splits a `Checks` string into globs, tolerating the whitespace and newlines people put in them. */
export function parseChecks(text: string): CheckGlob[] {
    return text
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) =>
            part.startsWith('-') ? { pattern: part.slice(1).trim(), enable: false } : { pattern: part, enable: true },
        );
}

export function formatChecks(globs: readonly CheckGlob[]): string {
    return globs.map((g) => (g.enable ? g.pattern : `-${g.pattern}`)).join(',');
}

/** Converts a glob to an anchored regex. `*` is the only wildcard clang-tidy recognises. */
function globRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}

export function globMatches(pattern: string, check: string): boolean {
    return globRegex(pattern).test(check);
}

/**
 * Whether `check` ends up enabled: the last matching glob decides, and no match
 * means disabled. `builtin` is clang-tidy's implicit default list, applied before
 * the file's own globs — which is what the binary does.
 */
export function isCheckEnabled(
    globs: readonly CheckGlob[],
    check: string,
    builtin: readonly CheckGlob[] = [],
): boolean {
    const all = [...builtin, ...globs];
    for (let i = all.length - 1; i >= 0; i--) {
        const glob = all[i]!;
        if (globMatches(glob.pattern, check)) return glob.enable;
    }
    return false;
}

/** The glob that decides `check`, or null when none does — for "why is this on?". */
export function decidingGlob(
    globs: readonly CheckGlob[],
    check: string,
    builtin: readonly CheckGlob[] = [],
): { glob: CheckGlob; builtin: boolean } | null {
    for (let i = globs.length - 1; i >= 0; i--) {
        if (globMatches(globs[i]!.pattern, check)) return { glob: globs[i]!, builtin: false };
    }
    for (let i = builtin.length - 1; i >= 0; i--) {
        if (globMatches(builtin[i]!.pattern, check)) return { glob: builtin[i]!, builtin: true };
    }
    return null;
}

/**
 * Switches one check on or off with the smallest edit that does it.
 *
 * An existing exact entry for the check is removed first, so toggling back and
 * forth does not grow the list. Then, only if the remaining globs do not already
 * give the wanted answer, an exact entry is appended — last, so it wins.
 */
export function setCheck(
    globs: readonly CheckGlob[],
    check: string,
    enable: boolean,
    builtin: readonly CheckGlob[] = [],
): CheckGlob[] {
    const without = globs.filter((g) => g.pattern !== check);
    if (isCheckEnabled(without, check, builtin) === enable) return without;
    return [...without, { pattern: check, enable }];
}

/**
 * Switches a whole family (`bugprone-*`) on or off. Exact entries for checks in
 * the family are dropped, since the family glob now decides them; that makes
 * "enable the module" mean what it says. Exceptions can be re-added afterwards
 * with `setCheck`, which appends them after the family glob.
 */
export function setFamily(globs: readonly CheckGlob[], familyGlob: string, enable: boolean): CheckGlob[] {
    const family = globRegex(familyGlob);
    const kept = globs.filter((g) => g.pattern !== familyGlob && !(family.test(g.pattern) && !g.pattern.includes('*')));
    return [...kept, { pattern: familyGlob, enable }];
}
