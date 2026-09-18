/**
 * Parses clang's `ClangFormatStyleOptions.rst` into a structured option catalog.
 *
 * That file is itself generated from `clang/include/clang/Format/Format.h` by
 * clang's own `dump_format_style.py`, so it is machine-regular and tracks the
 * binary exactly. Reading it is how we get descriptions, enum values, version
 * badges and official before/after examples without hand-maintaining anything.
 *
 * Pure: no network, no filesystem. That keeps it unit-testable.
 */

import type { ClangLanguageKey } from '../src/core/languages/types.ts';
import type {
    CodeExample,
    EnumValueDescriptor,
    NestedFieldDescriptor,
    OptionDescriptor,
    OptionKind,
} from '../src/core/catalog/types.ts';

/** `**Name** (``Type``) :versionbadge:`clang-format 3.7` :ref:`¶ <Name>`` */
const HEADING = /^\*\*(\w+)\*\* \(``([^`]+)``\)(?:\s*:versionbadge:`clang-format ([^`]+)`)?/;
/** `* ``PAS_Left`` (in configuration: ``Left``)` */
const ENUM_VALUE = /^\s*\* ``(\w+)`` \(in configuration: ``([^`]*)``\)/;
/** `* ``bool AfterCaseLabel`` Wrap case labels.` */
const NESTED_FIELD = /^\s*\* ``([\w:<>, ]+?) (\w+)``\s*(.*)$/;
/** `* ``AcrossEmptyLines`` — a bare shorthand value for a nested-struct option. */
const SHORTHAND = /^\s*\* ``(\w+)``\s*$/;

const MARKER_POSSIBLE_VALUES = 'Possible values:';
const MARKER_NESTED_FLAGS = 'Nested configuration flags:';

/** Ordered name→group rules. First match wins, so the specific ones come first. */
const GROUP_RULES: ReadonlyArray<readonly [RegExp, string]> = [
    [/^Penalty/, 'Penalties'],
    [/^(ObjC|Java(?!S)|JavaScript|CSharp|Proto|TableGen|Verilog|Json)/, 'Language-specific'],
    [/(Macros|MacroBlock)/, 'Macros'],
    [/^(Include|SortIncludes|MainInclude)/, 'Includes'],
    [/^(BraceWrapping|BreakBeforeBraces|Cpp11BracedListStyle|InsertBraces|RemoveBraces|SpaceInEmptyBraces)/, 'Braces'],
    [/^Align/, 'Alignment'],
    [/^Allow/, 'Short constructs'],
    [/^Space/, 'Spaces'],
    [/^(Pointer|Reference|Qualifier|DerivePointer)/, 'Pointers & qualifiers'],
    [/(Comment|Comments)/, 'Comments'],
    [
        /^(Indent|Continuation|Constructor|AccessModifierOffset|NamespaceIndentation|LambdaBodyIndentation|PPIndentWidth|TabWidth|UseTab|BracedInitializerIndentWidth|RequiresExpressionIndentation)/,
        'Indentation',
    ],
    [
        /^(Break|AlwaysBreak|Pack|BinPack|KeepEmpty|MaxEmptyLines|SeparateDefinitionBlocks|EmptyLine|ColumnLimit|LineEnding)/,
        'Line breaking',
    ],
    [/^(Sort|Remove|Insert|Fix|Derive|Qualifier)/, 'Cleanup & sorting'],
];

function groupFor(name: string): string {
    for (const [pattern, group] of GROUP_RULES) if (pattern.test(name)) return group;
    return 'Other';
}

/** Strip the common leading whitespace from a block so examples render sanely. */
function dedent(lines: string[]): string {
    const meaningful = lines.filter((l) => l.trim().length > 0);
    if (meaningful.length === 0) return '';
    const indent = Math.min(...meaningful.map((l) => l.length - l.trimStart().length));
    return lines.map((l) => l.slice(indent)).join('\n').replace(/\n+$/, '');
}

/**
 * Pulls every `.. code-block:: lang` out of a block, returning the examples and
 * the remaining prose. A directive owns all following lines that are blank or
 * indented further than the directive itself.
 */
function extractCodeBlocks(lines: string[]): { examples: CodeExample[]; prose: string[] } {
    const examples: CodeExample[] = [];
    const prose: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const directive = /^(\s*)\.\. code-block::\s*(\S*)/.exec(line);
        if (!directive) {
            // Other RST directives (warning/note/versionadded) keep their text but lose the marker.
            const other = /^(\s*)\.\. (\w+)::\s*(.*)$/.exec(line);
            if (other) {
                const label = other[2]!;
                if (label === 'warning' || label === 'note') prose.push(`${other[1]}**${label}:** ${other[3]}`);
                continue;
            }
            prose.push(line);
            continue;
        }
        const baseIndent = directive[1]!.length;
        const body: string[] = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
            const candidate = lines[j]!;
            if (candidate.trim().length === 0) {
                body.push('');
                continue;
            }
            const indent = candidate.length - candidate.trimStart().length;
            if (indent <= baseIndent) break;
            body.push(candidate);
        }
        const code = dedent(body);
        if (code.length > 0) examples.push({ language: directive[2] || 'text', code });
        i = j - 1;
    }
    return { examples, prose };
}

interface Bullet {
    /** The full first line of the bullet, used for pattern matching. */
    head: string;
    /** First line plus its continuation lines. */
    lines: string[];
}

/**
 * Splits a block into top-level bullets. Only bullets at the shallowest bullet
 * indent count as top level; deeper ones belong to whichever bullet contains them.
 */
function splitBullets(lines: string[]): Bullet[] {
    const indents = lines
        .filter((l) => /^\s*\* /.test(l))
        .map((l) => l.length - l.trimStart().length);
    if (indents.length === 0) return [];
    const topIndent = Math.min(...indents);
    const bullets: Bullet[] = [];
    let current: Bullet | null = null;
    for (const line of lines) {
        const isBullet = /^\s*\* /.test(line);
        const indent = line.length - line.trimStart().length;
        if (isBullet && indent === topIndent) {
            current = { head: line, lines: [line] };
            bullets.push(current);
        } else if (current) {
            current.lines.push(line);
        }
    }
    return bullets;
}

/** Everything after the bullet's own marker text, as clean prose. */
function bulletDoc(bullet: Bullet, stripHead: RegExp): { doc: string; examples: CodeExample[] } {
    const [first, ...rest] = bullet.lines;
    const headRemainder = (first ?? '').replace(stripHead, '').trim();
    const { examples, prose } = extractCodeBlocks(rest);
    const doc = [headRemainder, dedent(prose)].filter((s) => s.trim().length > 0).join('\n').trim();
    return { doc, examples };
}

function kindForDeclaredType(declaredType: string): OptionKind {
    switch (declaredType) {
        case 'Boolean':
            return 'bool';
        case 'Unsigned':
            return 'unsigned';
        case 'Integer':
            return 'integer';
        case 'String':
            return 'string';
        case 'List of Strings':
            return 'stringList';
        case 'List of IncludeCategories':
            return 'includeCategories';
        case 'List of RawStringFormats':
            return 'rawStringFormats';
        case 'deprecated':
            return 'deprecated';
        default:
            return 'unknown';
    }
}

/**
 * Hand-written requirements. These are real: clang-format rejects or silently
 * ignores the dependent option otherwise, and emitting a broken config is worse
 * than not offering the option. Verified against the 23.1.1 binary.
 */
const REQUIREMENTS: Record<string, OptionDescriptor['requires']> = {
    BraceWrapping: [
        {
            option: 'BreakBeforeBraces',
            value: 'Custom',
            reason: 'BraceWrapping is only consulted when BreakBeforeBraces is Custom.',
        },
    ],
    QualifierOrder: [
        {
            option: 'QualifierAlignment',
            value: 'Custom',
            reason: 'QualifierOrder only applies when QualifierAlignment is Custom.',
        },
    ],
    QualifierAlignment: [
        {
            option: 'QualifierOrder',
            value: '',
            reason: 'QualifierAlignment: Custom is rejected unless QualifierOrder lists the qualifiers.',
        },
    ],
    AlignConsecutiveShortCaseStatements: [
        {
            option: 'AllowShortCaseLabelsOnASingleLine',
            value: 'true',
            reason: 'Short case labels can only be aligned when they are allowed on a single line.',
        },
    ],
    InsertTrailingCommas: [
        {
            option: 'BinPackArguments',
            value: 'false',
            reason: 'InsertTrailingCommas: Wrapped is rejected while BinPackArguments is true.',
        },
    ],
};

/**
 * Language tagging, from the option name and then from its documentation prose.
 *
 * Deliberately a heuristic. See the note on `OptionDescriptor.languageHints`:
 * probing the binary finds nothing, because clang-format accepts nearly every
 * key for every language and simply ignores the ones that do not apply.
 */
const NAME_PREFIXES: ReadonlyArray<readonly [string, ClangLanguageKey]> = [
    ['JavaScript', 'JavaScript'],
    ['Java', 'Java'],
    ['ObjC', 'ObjC'],
    ['Cpp', 'Cpp'],
    ['CSharp', 'CSharp'],
    ['Proto', 'Proto'],
    ['TableGen', 'TableGen'],
    ['Verilog', 'Verilog'],
    ['Json', 'Json'],
];

const PROSE_PATTERNS: ReadonlyArray<readonly [RegExp, ClangLanguageKey]> = [
    [/\bJavaScript\b|\bTypeScript\b/, 'JavaScript'],
    [/\bJava\b(?!Script)/, 'Java'],
    [/Objective-C/, 'ObjC'],
    [/Protocol Buffer|\bproto\b/, 'Proto'],
    [/\bC#/, 'CSharp'],
    [/\bTableGen\b/, 'TableGen'],
    [/\bVerilog\b/, 'Verilog'],
    [/\bJSON\b/, 'Json'],
];

function languageHintsFor(name: string, doc: string): ClangLanguageKey[] {
    for (const [prefix, key] of NAME_PREFIXES) if (name.startsWith(prefix)) return [key];
    const hints = new Set<ClangLanguageKey>();
    // Only the opening prose: a passing mention deep in an example is not a claim
    // that the option is language-specific.
    const lead = doc.slice(0, 300);
    for (const [pattern, key] of PROSE_PATTERNS) if (pattern.test(lead)) hints.add(key);
    return [...hints];
}

/**
 * Fields the binary emits that the docs describe only in prose, never as a bullet.
 *
 * Without these the validation gate fails — correctly, because a field the binary
 * accepts but the catalog omits is a field the UI would hide. They are all
 * deprecated renames, called out in a `.. note::` in the option's own docs.
 */
const UNDOCUMENTED_FIELDS: Record<string, NestedFieldDescriptor[]> = {
    IntegerLiteralSeparator: (
        [
            ['BinaryMinDigits', 'BinaryMinDigitsInsert'],
            ['DecimalMinDigits', 'DecimalMinDigitsInsert'],
            ['HexMinDigits', 'HexMinDigitsInsert'],
        ] as const
    ).map(([name, replacedBy]) => ({
        name,
        kind: 'integer' as const,
        declaredType: 'int8_t',
        doc: `Deprecated. Renamed to \`${replacedBy}\`.`,
        values: [],
        examples: [],
        deprecated: true,
        replacedBy,
    })),
};

export function parseStyleOptionsRst(rst: string): OptionDescriptor[] {
    const lines = rst.split('\n');
    const headings: Array<{ name: string; declaredType: string; since: string | null; line: number }> = [];
    for (let i = 0; i < lines.length; i++) {
        const m = HEADING.exec(lines[i]!);
        if (m) headings.push({ name: m[1]!, declaredType: m[2]!, since: m[3] ?? null, line: i });
    }

    const options: OptionDescriptor[] = [];
    for (let h = 0; h < headings.length; h++) {
        const heading = headings[h]!;
        const end = headings[h + 1]?.line ?? lines.length;
        const body = lines.slice(heading.line + 1, end);

        // Find the markers that introduce enum values / nested fields.
        const valuesAt = body.findIndex((l) => l.trim() === MARKER_POSSIBLE_VALUES);
        const nestedAt = body.findIndex((l) => l.trim() === MARKER_NESTED_FLAGS);
        const firstMarker = [valuesAt, nestedAt].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? body.length;

        const intro = extractCodeBlocks(body.slice(0, firstMarker));
        const doc = dedent(intro.prose).trim();
        const examples = [...intro.examples];

        const values: EnumValueDescriptor[] = [];
        const fields: NestedFieldDescriptor[] = [];
        const shorthandValues: string[] = [];

        // Take whichever marker comes FIRST, not "Possible values:" by preference.
        // A nested option whose own fields include an enum-typed one (BraceWrapping
        // has AfterControlStatement) carries a "Possible values:" marker *inside*
        // the section; preferring it silently drops every field declared above it.
        const listStart = firstMarker < body.length ? firstMarker : -1;
        if (listStart >= 0) {
            const listBody = body.slice(listStart + 1);
            for (const bullet of splitBullets(listBody)) {
                const enumMatch = ENUM_VALUE.exec(bullet.head);
                if (enumMatch) {
                    const { doc: vdoc, examples: vex } = bulletDoc(bullet, ENUM_VALUE);
                    values.push({
                        value: enumMatch[2]!,
                        symbol: enumMatch[1]!,
                        doc: vdoc,
                        examples: vex,
                        needsPrerequisite: false,
                    });
                    continue;
                }
                const shorthandMatch = SHORTHAND.exec(bullet.head);
                if (shorthandMatch) {
                    shorthandValues.push(shorthandMatch[1]!);
                    continue;
                }
                const fieldMatch = NESTED_FIELD.exec(bullet.head);
                if (fieldMatch) {
                    const { doc: fdoc, examples: fex } = bulletDoc(bullet, NESTED_FIELD);
                    const nestedType = fieldMatch[1]!;
                    // A nested field's own enum values are listed as deeper bullets.
                    const nestedValues: EnumValueDescriptor[] = [];
                    for (const sub of bullet.lines) {
                        const sm = ENUM_VALUE.exec(sub);
                        if (sm) {
                            nestedValues.push({
                                value: sm[2]!,
                                symbol: sm[1]!,
                                doc: '',
                                examples: [],
                                needsPrerequisite: false,
                            });
                        }
                    }
                    fields.push({
                        name: fieldMatch[2]!,
                        kind: nestedType === 'bool' ? 'bool' : nestedValues.length > 0 ? 'enum' : 'unknown',
                        declaredType: nestedType,
                        doc: fdoc,
                        values: nestedValues,
                        examples: fex,
                    });
                }
            }
            // Examples that sit between the marker and the first bullet still belong to the option.
            const preludeEnd = listBody.findIndex((l) => /^\s*\* /.test(l));
            if (preludeEnd > 0) examples.push(...extractCodeBlocks(listBody.slice(0, preludeEnd)).examples);
        }

        let kind = kindForDeclaredType(heading.declaredType);
        if (kind === 'unknown') {
            if (fields.length > 0) kind = 'nested';
            else if (values.length > 0) kind = 'enum';
        }

        const extraFields = UNDOCUMENTED_FIELDS[heading.name];
        if (extraFields) fields.push(...extraFields);

        options.push({
            name: heading.name,
            kind,
            declaredType: heading.declaredType,
            doc,
            since: heading.since,
            deprecated: heading.declaredType === 'deprecated' || /deprecated/i.test(doc.slice(0, 200)),
            values,
            fields,
            shorthandValues,
            examples,
            group: groupFor(heading.name),
            languageHints: languageHintsFor(heading.name, doc),
            emittedByDumpConfig: false,
            requires: REQUIREMENTS[heading.name] ?? [],
        });
    }
    return options;
}
