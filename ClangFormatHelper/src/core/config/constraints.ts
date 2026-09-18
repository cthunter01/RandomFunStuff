/**
 * Interactions between options that would otherwise produce a config that is
 * silently wrong, or that clang-format refuses to load at all.
 *
 * Every entry here was reproduced against the real 23.1.1 binary. The first one
 * is the single biggest trap in clang-format: setting `BreakBeforeBraces` to
 * anything other than `Custom` overwrites every `BraceWrapping` flag, in either
 * key order, so a user who carefully sets `AfterFunction: true` next to
 * `BreakBeforeBraces: Attach` gets no error and no effect.
 */

import type { OptionCatalog } from '../catalog/types.ts';
import type { EffectiveConfig } from './effective.ts';
import { overridesUnder, type ConfigPath, type ConfigValue, type StyleDocument } from './model.ts';

export type VerdictKind =
    /** Set, accepted, doing something. */
    | 'ok'
    /** Accepted but inert, because another option overrides or disables it. */
    | 'ineffective'
    /** Would be rejected outright without a prerequisite. */
    | 'requires';

export interface Verdict {
    path: ConfigPath;
    kind: VerdictKind;
    message: string;
    /** A one-click repair the UI can offer. */
    fix?: { path: ConfigPath; value: ConfigValue; label: string };
}

export interface ConstraintContext {
    doc: StyleDocument;
    effective: EffectiveConfig;
    catalog: OptionCatalog;
}

type Constraint = (ctx: ConstraintContext) => Verdict[];

const braceWrappingNeedsCustom: Constraint = ({ doc, effective }) => {
    const touched = overridesUnder(doc, 'BraceWrapping');
    if (touched.length === 0) return [];
    const mode = effective.values.get('BreakBeforeBraces');
    if (mode === 'Custom') return [];
    return touched.map((path) => ({
        path,
        kind: 'ineffective' as const,
        message:
            `BreakBeforeBraces is ${String(mode)}, which overwrites every BraceWrapping flag. ` +
            `This setting has no effect until BreakBeforeBraces is Custom.`,
        fix: { path: 'BreakBeforeBraces', value: 'Custom', label: 'Set BreakBeforeBraces: Custom' },
    }));
};

const qualifierOrderNeedsCustom: Constraint = ({ doc, effective }) => {
    if (!doc.overrides.has('QualifierOrder')) return [];
    if (effective.values.get('QualifierAlignment') === 'Custom') return [];
    return [
        {
            path: 'QualifierOrder',
            kind: 'ineffective',
            message: 'QualifierOrder is only consulted when QualifierAlignment is Custom.',
            fix: { path: 'QualifierAlignment', value: 'Custom', label: 'Set QualifierAlignment: Custom' },
        },
    ];
};

const qualifierAlignmentCustomNeedsOrder: Constraint = ({ doc }) => {
    if (doc.overrides.get('QualifierAlignment') !== 'Custom') return [];
    if (doc.overrides.has('QualifierOrder')) return [];
    return [
        {
            path: 'QualifierAlignment',
            kind: 'requires',
            message: 'QualifierAlignment: Custom is rejected unless QualifierOrder lists the qualifiers.',
            fix: {
                path: 'QualifierOrder',
                value: ['inline', 'static', 'const', 'volatile', 'type'],
                label: 'Add a default QualifierOrder',
            },
        },
    ];
};

const trailingCommasConflictWithBinPack: Constraint = ({ doc, effective }) => {
    if (doc.overrides.get('InsertTrailingCommas') !== 'Wrapped') return [];
    if (effective.values.get('BinPackArguments') === false) return [];
    return [
        {
            path: 'InsertTrailingCommas',
            kind: 'requires',
            message: 'InsertTrailingCommas: Wrapped is rejected while BinPackArguments is true.',
            fix: { path: 'BinPackArguments', value: false, label: 'Set BinPackArguments: false' },
        },
    ];
};

const disableFormatSilencesEverything: Constraint = ({ effective }) => {
    if (effective.values.get('DisableFormat') !== true) return [];
    return [
        {
            path: 'DisableFormat',
            kind: 'ineffective',
            message: 'DisableFormat: true turns formatting off entirely — every other option is inert.',
            fix: { path: 'DisableFormat', value: false, label: 'Turn formatting back on' },
        },
    ];
};

const columnLimitZeroDisablesReflow: Constraint = ({ effective }) => {
    if (effective.values.get('ColumnLimit') !== 0) return [];
    return [
        {
            path: 'ColumnLimit',
            kind: 'ok',
            message: 'ColumnLimit: 0 means no line-length limit, so line-breaking options mostly stop applying.',
        },
    ];
};

const CONSTRAINTS: Constraint[] = [
    braceWrappingNeedsCustom,
    qualifierOrderNeedsCustom,
    qualifierAlignmentCustomNeedsOrder,
    trailingCommasConflictWithBinPack,
    disableFormatSilencesEverything,
    columnLimitZeroDisablesReflow,
];

export function evaluateConstraints(ctx: ConstraintContext): Verdict[] {
    return CONSTRAINTS.flatMap((constraint) => constraint(ctx));
}

/** Verdicts keyed by the path they apply to, for O(1) lookup while rendering rows. */
export function verdictsByPath(verdicts: readonly Verdict[]): Map<ConfigPath, Verdict[]> {
    const out = new Map<ConfigPath, Verdict[]>();
    for (const verdict of verdicts) {
        const list = out.get(verdict.path);
        if (list) list.push(verdict);
        else out.set(verdict.path, [verdict]);
    }
    return out;
}
