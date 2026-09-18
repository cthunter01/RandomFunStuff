/**
 * Browser smoke test: drives the built app in a real Firefox.
 *
 * The Node tests cover the engine, but the Worker + wasm + React wiring only
 * exists in a browser, and that is exactly the part a bundler can silently break.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

    // The option rail must not reorder when you edit a value. An earlier version
    // ranked overridden options to the top, so the row you were editing jumped out
    // from under the cursor the moment you touched it.
    // Clear it like a user would: React ignores a raw `el.value = ''` assignment.
    await page.click('.search');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => document.querySelectorAll('.option-wrap').length > 100);

    const readOrder = () => page.$$eval('.option-wrap .option-name', (nodes) => nodes.map((n) => n.textContent ?? ''));
    const orderBefore = await readOrder();

    // Pick a checkbox roughly in the middle, so a jump in either direction shows up.
    const target = await page.evaluate(() => {
        const wraps = [...document.querySelectorAll('.option-wrap')].filter((w) =>
            w.querySelector('.option-editor input[type=checkbox]'),
        );
        const chosen = wraps[Math.floor(wraps.length / 2)]!;
        const name = chosen.querySelector('.option-name')?.textContent ?? '';
        (chosen.querySelector('.option-editor input[type=checkbox]') as HTMLInputElement).click();
        return name;
    });
    await page.waitForFunction(
        (name: string) => (document.querySelector('.output.yaml')?.textContent ?? '').includes(name),
        {},
        target,
    );

    const orderAfter = await readOrder();
    if (orderBefore.join('|') !== orderAfter.join('|')) {
        const moved = orderBefore.findIndex((n, i) => n !== orderAfter[i]);
        fail(
            `editing "${target}" reordered the rail — first difference at index ${moved}: ` +
                `"${orderBefore[moved]}" became "${orderAfter[moved]}"`,
        );
    }
    if (orderBefore.indexOf(target) !== orderAfter.indexOf(target)) {
        fail(`"${target}" moved from index ${orderBefore.indexOf(target)} to ${orderAfter.indexOf(target)}`);
    }
    console.log(`OK  editing "${target}" left all ${orderAfter.length} rows in place`);

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

    // Results arriving must not reorder the rail either, while the order is static.
    const orderAfterAnalysis = await readOrder();
    if (orderAfterAnalysis.join('|') !== orderAfter.join('|')) {
        fail('the impact analysis reordered the rail even though the order is set to static');
    }
    console.log('OK  impact results did not disturb the static order');

    // Editing after an analysis keeps the (now stale) figures rather than blanking them.
    await page.$$eval('.option-editor input[type=checkbox]', (boxes) => (boxes[0] as HTMLInputElement).click());
    await page.waitForFunction(() => /out of date/.test(document.querySelector('.toolbar')?.textContent ?? ''));
    const badgesKept = await page.$$eval('.badge.live', (n) => n.length);
    if (badgesKept === 0) fail('editing after an analysis threw away every impact badge');
    console.log(`OK  edits mark results stale but keep them (${badgesKept} badges retained)`);

    // Ranking by impact is opt-in, and must be just as stable while editing —
    // this is the mode where a naive implementation reshuffles on every click.
    await page.select('.option-list select[aria-label="Option order"], select[aria-label="Option order"]', 'impact');
    await page.waitForFunction(() => document.querySelectorAll('.option-wrap').length > 100);
    const rankedBefore = await readOrder();
    if (rankedBefore.join('|') === orderAfterAnalysis.join('|')) {
        fail('"By impact" did not change the order at all, so it is not doing anything');
    }
    const yamlBefore = await page.$eval('.output.yaml', (n) => n.textContent ?? '');
    await page.$$eval('.option-editor input[type=checkbox]', (boxes) => (boxes[1] as HTMLInputElement).click());
    await page.waitForFunction(
        (previous: string) => (document.querySelector('.output.yaml')?.textContent ?? '') !== previous,
        {},
        yamlBefore,
    );
    const rankedAfter = await readOrder();
    if (rankedBefore.join('|') !== rankedAfter.join('|')) {
        const moved = rankedBefore.findIndex((n, i) => n !== rankedAfter[i]);
        fail(`editing while sorted by impact reordered the rail at index ${moved} ("${rankedBefore[moved]}")`);
    }
    console.log('OK  editing while sorted by impact also leaves every row in place');
    await page.screenshot({ path: path.join(shotDir, 'analysed.png') as `${string}.png`, fullPage: false });

    // ---------------------------------------------------------------------
    // clang-tidy. A separate wasm, worker pool and store; the sample, layout and
    // theme are shared with clang-format and must survive the switch.
    // ---------------------------------------------------------------------
    await page.select('.toolbar select[aria-label="Layout"]', 'workbench');
    const formatFileBefore = await page.$eval('.output.yaml', (n) => n.textContent ?? '');
    await page.click('.tool-switch button:nth-child(2)');
    await page.waitForFunction(() => document.querySelectorAll('.check-row').length > 500, { timeout: 120_000 });
    await page.waitForSelector('.finding', { timeout: 120_000 });
    const tidyStatus = await page.$eval('.code-panel .panel-toolbar .hint', (n) => n.textContent ?? '');
    console.log(`OK  clang-tidy booted in the browser and reported live findings (${tidyStatus.trim()})`);

    const marked = await page.$$eval('.editor-backdrop .code-line.mark-warning', (n) => n.length);
    if (marked === 0) fail('findings are listed but none is marked on the sample');
    const firstFinding = await page.$eval('.finding .where', (n) => Number((n.textContent ?? '').split(':')[0]));
    const markedLines = await page.$$eval('.editor-backdrop .code-line', (lines) =>
        lines.map((l, i) => (l.classList.contains('mark-warning') || l.classList.contains('mark-error') ? i + 1 : 0)),
    );
    if (!markedLines.includes(firstFinding)) fail(`finding on line ${firstFinding} is not marked on that line`);
    console.log(`OK  ${marked} sample lines marked, on the lines the findings name`);

    const tidyFile = () => page.$eval('.output.yaml', (n) => n.textContent ?? '');
    if (!(await tidyFile()).includes('bugprone-*')) fail(`.clang-tidy pane does not show the starting point:\n${await tidyFile()}`);

    // Enabling a check: the file says so, the findings follow, and no row moves.
    const readChecks = () => page.$$eval('.check-row .check-name', (n) => n.map((x) => x.textContent ?? ''));
    const checksBefore = await readChecks();
    await page.evaluate(() => {
        const row = [...document.querySelectorAll('.check-row')].find(
            (r) => r.querySelector('.check-name')?.textContent === 'modernize-use-trailing-return-type',
        );
        (row?.querySelector('input[type=checkbox]') as HTMLInputElement).click();
    });
    await page.waitForFunction(
        () => (document.querySelector('.output.yaml')?.textContent ?? '').includes('modernize-use-trailing-return-type'),
    );
    await page.waitForFunction(
        () => [...document.querySelectorAll('.finding .which')].some((n) => n.textContent?.includes('modernize-use-trailing-return-type')),
        { timeout: 60_000 },
    );
    if ((await readChecks()).join('|') !== checksBefore.join('|')) fail('enabling a check reordered the check rail');
    console.log('OK  enabling a check updates .clang-tidy and the findings, and moves no row');

    // An option lands in CheckOptions.
    await page.evaluate(() => {
        const row = [...document.querySelectorAll('.check-row')].find(
            (r) => r.querySelector('.check-name')?.textContent === 'modernize-use-trailing-return-type',
        );
        (row?.querySelector('.disclosure') as HTMLButtonElement).click();
    });
    await page.waitForSelector('.option-detail .option-editor select');
    await page.select('.option-detail .option-editor select', 'none');
    await page.waitForFunction(() =>
        /CheckOptions:[\s\S]*modernize-use-trailing-return-type\.TransformLambdas: none/.test(
            document.querySelector('.output.yaml')?.textContent ?? '',
        ),
    );
    console.log('OK  setting an option writes it to CheckOptions');

    // Importing a file replaces the config, and survives the round trip.
    const imported = path.join(mkdtempSync(path.join(tmpdir(), 'cfh-tidy-')), '.clang-tidy');
    writeFileSync(imported, "Checks: '-*,performance-*'\nCheckOptions:\n  performance-for-range-copy.WarnOnAllAutoCopies: true\n");
    const upload = await page.$('.import input[type=file]');
    await upload!.uploadFile(imported);
    await page.waitForFunction(() => (document.querySelector('input[aria-label="Checks globs"]') as HTMLInputElement)?.value === '-*,performance-*');
    if (!(await tidyFile()).includes('performance-for-range-copy.WarnOnAllAutoCopies')) fail('import lost the CheckOptions');
    console.log('OK  importing a .clang-tidy replaces the config');

    // The analysis: every check once, then the option sweep.
    await page.$$eval('.toolbar button', (buttons) => {
        (buttons.find((b) => /Analyse|Re-analyse/.test(b.textContent ?? '')) as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForFunction(() => /checks fire here/.test(document.querySelector('.toolbar')?.textContent ?? ''), {
        timeout: 300_000,
        polling: 500,
    });
    const tidySummary = await page.$eval('.toolbar .progress', (n) => n.textContent ?? '');
    const firing = Number(/^(\d+)/.exec(tidySummary.trim())?.[1] ?? 0);
    if (firing < 20) fail(`expected the kitchen sink to trip many checks, got "${tidySummary}"`);
    const impactBadges = await page.$$eval('.option-detail .badge.live, .option-detail .badge.dim', (n) => n.length);
    console.log(`OK  tidy analysis completed — ${tidySummary.trim()} (${impactBadges} option badges in the open check)`);

    await page.select('.toolbar select[aria-label="Layout"]', 'card-feed');
    await page.waitForSelector('.tidy-card', { timeout: 30_000 });
    const cards = await page.$$eval('.tidy-card', (n) => n.length);
    const previews = await page.$$eval('.tidy-card .micro-preview', (n) => n.length);
    if (cards !== firing) fail(`card feed shows ${cards} cards for ${firing} firing checks`);
    if (previews === 0) fail('no card has a fix preview');
    console.log(`OK  card feed: ${cards} cards, ${previews} with a before/after of the fix`);
    await page.screenshot({ path: path.join(shotDir, 'tidy-card-feed.png') as `${string}.png` });
    await page.select('.toolbar select[aria-label="Layout"]', 'workbench');

    // Back to clang-format: nothing lost on either side.
    await page.click('.tool-switch button:nth-child(1)');
    await page.waitForSelector('.option-wrap', { timeout: 30_000 });
    if ((await page.$eval('.output.yaml', (n) => n.textContent ?? '')) !== formatFileBefore) {
        fail('switching to clang-tidy and back changed the .clang-format');
    }
    await page.click('.tool-switch button:nth-child(2)');
    await page.waitForSelector('.check-row', { timeout: 30_000 });
    if (!(await tidyFile()).includes('performance-for-range-copy.WarnOnAllAutoCopies')) fail('switching tools lost the .clang-tidy');
    console.log('OK  switching tools keeps both configs');

    const fatal = consoleErrors.filter((e) => !/Download the React DevTools/.test(e));
    if (fatal.length > 0) fail(`console errors:\n  ${fatal.join('\n  ')}`);
    console.log('OK  no console errors');
    console.log('\nALL BROWSER CHECKS PASSED');
} finally {
    await browser.close();
}
