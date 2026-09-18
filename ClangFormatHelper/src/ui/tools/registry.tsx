/**
 * The tool registry — extensibility seam #3, next to languages and layouts.
 *
 * A tool is a config file the app helps build: `.clang-format` or `.clang-tidy`.
 * Each supplies panels for the same fixed set of slots, and the layouts arrange
 * slots without knowing which tool fills them. That is what lets all three
 * layouts serve both tools with no tool-specific code in any layout — and what a
 * third tool would plug into.
 */

import type { ComponentType, ReactNode } from 'react';
import type { ToolId } from '../state/store.tsx';
import { useStore } from '../state/store.tsx';
import type { Density } from '../controls/OptionControl.tsx';
import { OptionListPanel } from '../panels/OptionListPanel.tsx';
import { OptionCardFeedPanel } from '../panels/OptionCardFeedPanel.tsx';
import { DiffPanel, DocExamplePanel, FormattedPanel, SamplePanel, YamlPanel } from '../panels/CodePanels.tsx';
import { FormatToolbarControls, FormatToolbarStatus, FormatGate } from '../panels/FormatToolbar.tsx';
import { TidyCheckListPanel } from '../panels/tidy/TidyCheckListPanel.tsx';
import { TidyCardFeedPanel } from '../panels/tidy/TidyCardFeedPanel.tsx';
import {
    TidyDiffPanel,
    TidyDocPanel,
    TidyFilePanel,
    TidyFixedPanel,
    TidySamplePanel,
} from '../panels/tidy/TidyCodePanels.tsx';
import { TidyGate, TidyToolbarControls, TidyToolbarStatus } from '../panels/tidy/TidyToolbar.tsx';

export interface ToolPanels {
    /** The settings list down the side. */
    Rail: ComponentType<{ density?: Density }>;
    /** Every setting as a card with a preview from the user's code. */
    CardFeed: ComponentType;
    /** The editable sample. */
    Sample: ComponentType;
    /** The sample after the tool has done its work. */
    Result: ComponentType;
    /** Sample-side comparison. */
    Diff: ComponentType;
    /** Documentation for the setting in focus. */
    Doc: ComponentType;
    /** The generated config file. */
    File: ComponentType;
    /** Tool-specific controls in the toolbar. */
    ToolbarControls: ComponentType;
    /** Analysis button and status, at the right of the toolbar. */
    ToolbarStatus: ComponentType;
    /** Shown instead of the layout until the tool is ready. */
    Gate: ComponentType<{ children: ReactNode }>;
}

export interface ToolDefinition {
    id: ToolId;
    /** The tool's own name, e.g. `clang-tidy`. */
    label: string;
    fileName: string;
    /** Tab labels for the Result and Diff slots. */
    resultLabel: string;
    diffLabel: string;
    panels: ToolPanels;
}

export const tools: readonly ToolDefinition[] = [
    {
        id: 'format',
        label: 'clang-format',
        fileName: '.clang-format',
        resultLabel: 'Formatted',
        diffLabel: 'Diff vs base',
        panels: {
            Rail: OptionListPanel,
            CardFeed: OptionCardFeedPanel,
            Sample: SamplePanel,
            Result: FormattedPanel,
            Diff: DiffPanel,
            Doc: DocExamplePanel,
            File: YamlPanel,
            ToolbarControls: FormatToolbarControls,
            ToolbarStatus: FormatToolbarStatus,
            Gate: FormatGate,
        },
    },
    {
        id: 'tidy',
        label: 'clang-tidy',
        fileName: '.clang-tidy',
        resultLabel: 'Fixed',
        diffLabel: 'Diff vs fixed',
        panels: {
            Rail: TidyCheckListPanel,
            CardFeed: TidyCardFeedPanel,
            Sample: TidySamplePanel,
            Result: TidyFixedPanel,
            Diff: TidyDiffPanel,
            Doc: TidyDocPanel,
            File: TidyFilePanel,
            ToolbarControls: TidyToolbarControls,
            ToolbarStatus: TidyToolbarStatus,
            Gate: TidyGate,
        },
    },
];

export function getTool(id: ToolId): ToolDefinition {
    return tools.find((t) => t.id === id) ?? tools[0]!;
}

export function useActiveTool(): ToolDefinition {
    const { state } = useStore();
    return getTool(state.toolId);
}
