/**
 * Browser smoke test: drives the built app in a real Firefox.
 *
 * The Node tests cover the engine, but the Worker + wasm + React wiring only
 * exists in a browser, and that is exactly the part a bundler can silently break.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const URL_UNDER_TEST = process.env['CFH_URL'] ?? 'http://localhost:4173/';
const shotDir = process.env['CFH_SHOTS'] ?? tmpdir();

const browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: '/usr/bin/firefox',
    headless: true,
    userDataDir: mkdtempSync(path.join(tmpdir(), 'cfh-ff-')),
    defaultViewport: { width: 1680, height: 1000 },
});

const fail = (message: string): never => {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    throw new Error(message);
};

try {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(URL_UNDER_TEST, { waitUntil: 'load' });

    // The app only leaves the boot screen once the wasm module answers.
    await page.waitForSelector('.layout.workbench', { timeout: 60_000 });
    console.log('OK  wasm booted, workbench layout mounted');

    // Formatting happens in the worker; the YAML pane is rendered from the model.
    await page.waitForFunction(
        () => (document.querySelector('.output.yaml')?.textContent ?? '').includes('BasedOnStyle: LLVM'),
        { timeout: 30_000 },
    );
    console.log('OK  .clang-format pane shows the base style');

    const optionCount = await page.$$eval('.option-wrap', (n) => n.length);
    if (optionCount < 50) fail(`expected many option rows, saw ${optionCount}`);
    console.log(`OK  option rail rendered ${optionCount} rows`);

    // Change an option and confirm the formatted output actually changes.
    await page.waitForFunction(() => (document.querySelector('.editor') as HTMLTextAreaElement)?.value.length > 0);
    await page.type('.search', 'PointerAlignment');
    await page.waitForFunction(() => document.querySelectorAll('.option-wrap').length < 20);
    const before = await page.$eval('.output.yaml', (n) => n.textContent ?? '');
    await page.select('.option-editor select', 'Left');
    await page.waitForFunction(
        (prev: string) => (document.querySelector('.output.yaml')?.textContent ?? '') !== prev,
        {},
        before,
    );
    const after = await page.$eval('.output.yaml', (n) => n.textContent ?? '');
    if (!after.includes('PointerAlignment: Left')) fail(`YAML did not pick up the change:\n${after}`);
    console.log('OK  changing an option updates the generated .clang-format');

    // Syntax highlighting: grammars load after first paint, so wait for real tokens.
    await page.waitForSelector('.editor-backdrop [class^=tok-]', { timeout: 30_000 });
    await page.waitForSelector('.output.yaml [class^=tok-]', { timeout: 30_000 });
    console.log('OK  editor and .clang-format pane are highlighted');

    // The editable sample is a transparent textarea over a highlighted copy of the
    // same text. If the two layers disagree on metrics the caret drifts off the
    // glyphs, which is invisible to every other assertion here.
    const layers = await page.evaluate(() => {
        const ta = document.querySelector('textarea.editor') as HTMLTextAreaElement;
        const pre = document.querySelector('.editor-backdrop pre.code') as HTMLElement;
        const taBox = ta.getBoundingClientRect();
        const preBox = pre.getBoundingClientRect();
        return {
            heightDelta: Math.abs(ta.scrollHeight - pre.scrollHeight),
            originDelta: Math.abs(taBox.left - preBox.left) + Math.abs(taBox.top - preBox.top),
            lines: ta.value.split('\n').length,
            lineDivs: pre.querySelectorAll('.code-line').length,
        };
    });
    if (layers.heightDelta > 2 || layers.originDelta > 1 || layers.lines !== layers.lineDivs) {
        fail(`editor layers are misaligned: ${JSON.stringify(layers)}`);
    }
    console.log(`OK  editor layers aligned (${layers.lines} lines, ${layers.heightDelta}px height delta)`);

    await page.click('.tabs button:nth-child(3)'); // Diff vs base
    await page.waitForSelector('.diff-row [class^=tok-]', { timeout: 30_000 });
    console.log('OK  diff is highlighted on both sides');
    await page.click('.tabs button:nth-child(1)');

    // Switch to each layout and confirm it mounts and keeps the override.
    for (const [value, selector] of [
        ['diff-focus', '.layout.diff-focus'],
        ['card-feed', '.layout.card-feed-layout'],
        ['workbench', '.layout.workbench'],
    ] as const) {
        await page.select('.toolbar select[aria-label="Layout"]', value);
        await page.waitForSelector(selector, { timeout: 15_000 });
        const yaml = await page.$eval('.output.yaml, .panel', (n) => n.textContent ?? '');
        void yaml;
        console.log(`OK  layout "${value}" mounted, state preserved`);
        await page.screenshot({ path: path.join(shotDir, `layout-${value}.png`) as `${string}.png` });
    }

    // Theme: an explicit choice must beat the OS preference, survive a reload, and
    // repaint without needing anything re-rendered by hand.
    const themeProbe = () =>
        page.evaluate(() => ({
            bg: getComputedStyle(document.body).backgroundColor,
            scheme: getComputedStyle(document.documentElement).colorScheme,
            attr: document.documentElement.dataset.theme ?? '',
            stored: localStorage.getItem('cfh.theme') ?? '',
        }));

    await page.select('.toolbar select[aria-label="Theme"]', 'dark');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    const dark = await themeProbe();
    if (dark.scheme !== 'dark' || dark.bg === 'rgb(255, 255, 255)') fail(`dark theme not applied: ${JSON.stringify(dark)}`);
    console.log(`OK  dark theme applied (${dark.bg})`);

    await page.reload({ waitUntil: 'load' });
    // The inline bootstrap in index.html must have run before anything painted.
    const beforePaint = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
    if (beforePaint !== 'dark') fail('theme was not applied before first paint — it will flash');
    await page.waitForSelector('.layout', { timeout: 60_000 });
    if ((await themeProbe()).scheme !== 'dark') fail('theme did not survive a reload');
    console.log('OK  theme persists and is applied before first paint');

    await page.select('.toolbar select[aria-label="Theme"]', 'system');
    await page.waitForFunction(() => document.documentElement.dataset.theme === undefined);
    const system = await themeProbe();
    if (system.scheme !== 'light dark' || system.stored !== '') {
        fail(`"match system" should clear the override, got ${JSON.stringify(system)}`);
    }
    console.log('OK  "match system" hands control back to the OS');

    // The headline feature.
    await page.$$eval('.toolbar button', (buttons) => {
        const analyse = buttons.find((b) => /Analyse|Re-analyse/.test(b.textContent ?? ''));
        (analyse as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForFunction(
        () => /options affect this sample/.test(document.querySelector('.toolbar')?.textContent ?? ''),
        { timeout: 120_000 },
    );
    const summary = await page.$eval('.toolbar .progress', (n) => n.textContent ?? '');
    console.log(`OK  impact analysis completed — ${summary.trim()}`);
    await page.screenshot({ path: path.join(shotDir, 'analysed.png') as `${string}.png`, fullPage: false });

    const fatal = consoleErrors.filter((e) => !/Download the React DevTools/.test(e));
    if (fatal.length > 0) fail(`console errors:\n  ${fatal.join('\n  ')}`);
    console.log('OK  no console errors');
    console.log('\nALL BROWSER CHECKS PASSED');
} finally {
    await browser.close();
}
