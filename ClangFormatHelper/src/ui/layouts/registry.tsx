/**
 * The layout registry — extensibility seam #2.
 *
 * A layout is pure arrangement. It holds no state, and it composes the same
 * panel components every other layout uses, so all three stay in step and
 * switching between them preserves everything.
 */

import type { ComponentType } from 'react';
import { WorkbenchLayout } from './WorkbenchLayout.tsx';
import { DiffFocusLayout } from './DiffFocusLayout.tsx';
import { CardFeedLayout } from './CardFeedLayout.tsx';

export type LayoutId = 'workbench' | 'diff-focus' | 'card-feed';

export interface LayoutDefinition {
    id: LayoutId;
    label: string;
    blurb: string;
    Component: ComponentType;
}

export const layouts: readonly LayoutDefinition[] = [
    {
        id: 'workbench',
        label: 'Workbench (3 panes)',
        blurb: 'Options, code and the generated file all visible at once.',
        Component: WorkbenchLayout,
    },
    {
        id: 'diff-focus',
        label: 'Diff focus (2 panes)',
        blurb: 'Maximum room for a side-by-side comparison against the base style.',
        Component: DiffFocusLayout,
    },
    {
        id: 'card-feed',
        label: 'Card feed',
        blurb: 'Every option as a card with its own before/after from your code.',
        Component: CardFeedLayout,
    },
];

export function getLayout(id: LayoutId): LayoutDefinition {
    return layouts.find((l) => l.id === id) ?? layouts[0]!;
}
