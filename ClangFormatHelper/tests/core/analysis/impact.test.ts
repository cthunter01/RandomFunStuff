import { beforeAll, describe, expect, it } from 'vitest';
import catalogJson from '../../../src/core/catalog/generated/options.23.1.1.json' with { type: 'json' };
import type { OptionCatalog } from '../../../src/core/catalog/types.ts';
import { analyseImpact, summarise } from '../../../src/core/analysis/impact.ts';
import { createDocument } from '../../../src/core/config/model.ts';
import { sharedRuntime } from '../../support/nodeRuntime.ts';
import type { Runtime } from '../../../src/worker/runtime.ts';

const catalog = catalogJson as unknown as OptionCatalog;
const SAMPLE = `#include <vector>
namespace demo {
class Widget : public Base {
public:
    Widget(int width, int height) : width_(width), height_(height) {}
    int area() const { return width_ * height_; }
private:
    int width_;
    int height_;
    std::vector<int> *cells_;
};
}  // namespace demo
`;

let runtime: Runtime;
beforeAll(async () => {
    runtime = await sharedRuntime();
});

describe('impact analysis', () => {
    it('separates options that change this code from ones that do not', async () => {
        const doc = createDocument('cpp', 'LLVM');
        const map = await analyseImpact({
            catalog,
            doc,
            code: SAMPLE,
            filename: 'main.cc',
            port: runtime,
        });

        // Every option and nested field gets a verdict.
        expect(map.size).toBe(343);

        const verdict = (path: string) => map.get(path)?.verdict;
        // These demonstrably reshape this sample.
        expect(verdict('IndentWidth')).toBe('live');
        expect(verdict('PointerAlignment')).toBe('live');
        expect(verdict('BreakBeforeBraces')).toBe('live');
        // These cannot possibly apply to a C++ sample with no such constructs.
        expect(verdict('JavaScriptQuotes')).toBe('inert');
        expect(verdict('ObjCBlockIndentWidth')).toBe('inert');

        // The whole premise of the feature: most options are noise for any one sample.
        const { live, inert } = summarise(map);
        expect(live).toBeGreaterThan(5);
        expect(inert).toBeGreaterThan(live * 3);
    });

    it('records a witness showing what the winning candidate did', async () => {
        const doc = createDocument('cpp', 'LLVM');
        const map = await analyseImpact({ catalog, doc, code: SAMPLE, filename: 'main.cc', port: runtime });
        const pointer = map.get('PointerAlignment');
        expect(pointer?.witness?.value).toBeDefined();
        expect(pointer?.witness?.hunk?.after.join('\n')).toContain('*');
        expect(pointer?.magnitude).toBeGreaterThan(0);
    });

    it('never proposes a value that needs an unmet prerequisite', async () => {
        const doc = createDocument('cpp', 'LLVM');
        const map = await analyseImpact({ catalog, doc, code: SAMPLE, filename: 'main.cc', port: runtime });
        // QualifierAlignment: Custom is rejected without QualifierOrder, so the sweep
        // must not have tried it — otherwise the result is based on a config that
        // clang-format refused to load.
        const values = catalog.options.find((o) => o.name === 'QualifierAlignment')?.values ?? [];
        expect(values.find((v) => v.value === 'Custom')?.needsPrerequisite).toBe(true);
        // Candidates are alternatives to the value currently in force, so the
        // effective value (LLVM's `Leave`) is excluded along with `Custom`.
        const offered = values.filter((v) => !v.needsPrerequisite && v.value !== 'Leave');
        expect(map.get('QualifierAlignment')?.candidatesTried).toBe(offered.length);
    });

    it('skips options that would trivially match anything', async () => {
        const doc = createDocument('cpp', 'LLVM');
        const map = await analyseImpact({ catalog, doc, code: SAMPLE, filename: 'main.cc', port: runtime });
        expect(map.get('DisableFormat')).toMatchObject({ verdict: 'skipped', skipReason: 'degenerate' });
    });

    it('survives repeated sweeps by recycling the wasm module', async () => {
        // Regression: the module accumulates state across distinct styles and dies
        // somewhere past ~800 formats — it traps or simply stops making progress.
        // One sweep is ~450 formats, so without recycling the second sweep in a
        // session hangs. This runs enough sweeps to cross that line several times.
        const doc = createDocument('cpp', 'LLVM');
        const before = runtime.recycleCount;
        for (let i = 0; i < 3; i++) {
            const map = await analyseImpact({ catalog, doc, code: SAMPLE, filename: 'main.cc', port: runtime });
            expect(summarise(map).live).toBeGreaterThan(5);
        }
        expect(runtime.recycleCount).toBeGreaterThan(before);
    });

    it('can be cancelled mid-sweep', async () => {
        const doc = createDocument('cpp', 'LLVM');
        const controller = new AbortController();
        const sweep = analyseImpact({
            catalog,
            doc,
            code: SAMPLE,
            filename: 'main.cc',
            port: runtime,
            chunkSize: 16,
            onProgress: (done) => {
                if (done >= 16) controller.abort();
            },
            signal: controller.signal,
        });
        await expect(sweep).rejects.toThrow(/cancelled/i);
    });
});
