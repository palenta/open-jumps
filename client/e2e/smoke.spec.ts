// The smoke route in a real browser (plan 2.9, matrix row 19): two phones — the host creates a room, a friend
// enters the code, the host lets her in, both pick a height, the course walk, a round in which the friend taps
// at her first two fences from the displayed tap control at the moment the page announces (data-takeoff-at) and
// is judged clean by the server (no faults, the next fence comes up — a missing pointerdown handler or a lost
// command would give the self-jump's rail instead), the results table with both riders, "again" into the next
// course walk; on the way the tab lifecycle event leaves the screen alone and the Spanish locale shows a Spanish fence.
// Run with `npx playwright test -c client/e2e/playwright.config.ts` after `npx playwright install chromium`
// (a browser download — done together with the owner). Not part of `npm test`.
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

const PIN = '1234';

/** Unique rider names per run (the server keeps the accounts): at most 16 characters, letters and digits. */
const runSuffix = Date.now().toString(36).slice(-6);
const HOST_NAME = `Host${runSuffix}`;
const FRIEND_NAME = `Friend${runSuffix}`;

/** The context options of the running project (baseURL, viewport, touch), applied to every context this test opens by hand. */
function contextOptions(): Parameters<Browser['newContext']>[0] {
  const use = test.info().project.use;
  return {
    ...(use.baseURL !== undefined ? { baseURL: use.baseURL } : {}),
    ...(use.viewport !== undefined && use.viewport !== null ? { viewport: use.viewport } : {}),
    ...(use.isMobile !== undefined ? { isMobile: use.isMobile } : {}),
    ...(use.hasTouch !== undefined ? { hasTouch: use.hasTouch } : {}),
    ...(use.userAgent !== undefined ? { userAgent: use.userAgent } : {}),
    ...(use.deviceScaleFactor !== undefined ? { deviceScaleFactor: use.deviceScaleFactor } : {}),
  };
}

const screen = (page: Page, name: string): Locator => page.locator(`[data-screen="${name}"]`);

async function screenOf(page: Page): Promise<string | null> {
  return page.locator('[data-screen]').first().getAttribute('data-screen');
}

async function expectScreen(page: Page, name: string, timeout = 15_000): Promise<void> {
  await expect(screen(page, name)).toHaveCount(1, { timeout });
}

/** Sets a form field by name whatever the control is: a select, a radio group, or a text input. */
async function setField(form: Locator, name: string, value: string): Promise<void> {
  const field = form.locator(`[name="${name}"]`).first();
  const tag = await field.evaluate((element) => element.tagName);
  if (tag === 'SELECT') {
    await field.selectOption(value);
    return;
  }
  if ((await field.getAttribute('type')) === 'radio') {
    await form.locator(`[name="${name}"][value="${value}"]`).check();
    return;
  }
  await field.fill(value);
}

async function submit(form: Locator): Promise<void> {
  await form.evaluate((element) => (element as HTMLFormElement).requestSubmit());
}

/** A fresh phone: register a rider with a pony, land on home. */
async function register(page: Page, riderName: string, ponyName: string): Promise<void> {
  await page.goto('/');
  await expectScreen(page, 'signin');
  const form = page.locator('form[data-form="register"]');
  if (!(await form.isVisible())) {
    // A sign-in screen that shows one form at a time switches to the register form by its own link.
    const toggle = page.getByText('New rider', { exact: true });
    if ((await toggle.count()) > 0) await toggle.first().click();
  }
  await setField(form, 'riderName', riderName);
  await setField(form, 'pin', PIN);
  await setField(form, 'ponyName', ponyName);
  await setField(form, 'riderGender', 'girl');
  await setField(form, 'ponyGender', 'yegua');
  await setField(form, 'ponyCategory', 'C');
  await submit(form);
  await expectScreen(page, 'home');
}

/**
 * Records every text the HUD caption shows from now on. The caption is shared by all horses of the heat, so another
 * horse's event (the host's self-jumps, refusals, elimination) can replace a rider's caption before a check reads it;
 * the record keeps them all.
 */
async function recordCaptions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __captions: string[] }).__captions = seen;
    const read = (): void => {
      const text = document.querySelector('[data-hud-caption]')?.textContent ?? '';
      if (text !== '' && seen[seen.length - 1] !== text) seen.push(text);
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
    read();
    // Every touch on the tap control, against the take-off moment it showed (both in performance.now() time).
    const touches: { lateMs: number | null; armed: string | null }[] = [];
    (window as unknown as { __touches: typeof touches }).__touches = touches;
    document.addEventListener(
      'pointerdown',
      (event) => {
        const tap = document.querySelector('[data-control="tap"]');
        const at = Number.parseFloat(tap?.getAttribute('data-takeoff-at') ?? 'NaN');
        touches.push({ lateMs: Number.isFinite(at) ? Math.round(event.timeStamp - at) : null, armed: tap?.getAttribute('data-armed') ?? null });
      },
      { capture: true },
    );
  });
}

async function captionsShown(page: Page, pattern: RegExp): Promise<boolean> {
  return page.evaluate((source) => (window as unknown as { __captions: string[] }).__captions.some((text) => new RegExp(source).test(text)), pattern.source);
}

/**
 * One real take-off from the displayed tap control, timed by the page itself: when the horse enters the approach
 * zone the tap control is armed and carries data-takeoff-at (the device time of the take-off moment, in
 * performance.now() ms); the finger lands 20 ms after it, inside the perfect/clean tiers. The server's own word
 * is read back from the state: no faults and the next fence up — a self-jump without a tap would cost a rail
 * (4 faults), so a dropped pointerdown handler or a lost command fails here, whatever the caption says.
 */
async function tapAtFence(page: Page, fence: number, ponyName: string): Promise<void> {
  const tap = page.locator('[data-control="tap"]');
  await expect(page.locator('[data-hud-fence]')).toHaveText(`Fence ${String(fence)}`, { timeout: 60_000 });
  await expect(tap).toHaveAttribute('data-armed', 'true', { timeout: 60_000 });
  const takeoffAt = Number.parseFloat((await tap.getAttribute('data-takeoff-at')) ?? 'NaN');
  expect(Number.isFinite(takeoffAt)).toBe(true);
  // The control's box is read before the wait, so that after it only the touch itself stands between the test and
  // the take-off moment (every round trip to the browser costs real milliseconds of the ±157 ms clean window).
  const box = await tap.boundingBox();
  if (box === null) throw new Error('the tap control is not displayed');
  const now = await page.evaluate(() => performance.now());
  await page.waitForTimeout(Math.max(0, takeoffAt + 20 - now));
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); // a finger, not a mouse: the project has touch
  const judged = new RegExp(`^${ponyName}: (perfecta|cero faltas) at fence ${String(fence)}`);
  try {
    await expect.poll(() => captionsShown(page, judged), { timeout: 10_000 }).toBe(true);
  } catch (error) {
    const shown = await page.evaluate(() => (window as unknown as { __captions: string[] }).__captions);
    const touches = await page.evaluate(() => (window as unknown as { __touches: unknown[] }).__touches);
    throw new Error(`no caption ${judged.source}; captions shown since the round began: ${JSON.stringify(shown)}; touches: ${JSON.stringify(touches)}`, { cause: error });
  }
  await expect(page.locator('[data-hud-fence]')).toHaveText(`Fence ${String(fence + 1)}`, { timeout: 10_000 });
  try {
    await expect(page.locator('[data-hud-faults]')).toHaveText('0 faults');
  } catch (error) {
    const shown = await page.evaluate(() => (window as unknown as { __captions: string[] }).__captions);
    const touches = await page.evaluate(() => (window as unknown as { __touches: unknown[] }).__touches);
    throw new Error(`faults after fence ${String(fence)}; captions: ${JSON.stringify(shown)}; touches: ${JSON.stringify(touches)}`, { cause: error });
  }
  await expect(tap).not.toHaveAttribute('data-armed', 'true');
}

/**
 * The host starts the next class from the results screen. The server refuses start-class while the class is
 * still in its results phase (15 s), so the button is pressed again every two seconds until the walk is on.
 */
async function startAgain(page: Page): Promise<void> {
  const again = page.locator('[data-action="again"]');
  await expect(again).toHaveCount(1);
  await expect
    .poll(
      async () => {
        if ((await screenOf(page)) === 'walk') return 'walk';
        await again.click({ timeout: 1_500 }).catch(() => undefined);
        return screenOf(page);
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe('walk');
}

test('create → code → ring → admit → heights → walk → round with a caption → results → again', async ({ browser }) => {
  // A class can run to its 150 s limit before the results come; two classes and the doorbell fit in 200 s.
  test.setTimeout(200_000);

  const contexts: BrowserContext[] = [];
  const newPage = async (): Promise<Page> => {
    const context = await browser.newContext(contextOptions());
    contexts.push(context);
    return context.newPage();
  };

  try {
    const host = await newPage();
    const friend = await newPage();

    // Two riders on two phones, two ponies (so a caption names whose fence it is).
    await register(host, HOST_NAME, 'Dakota');
    await register(friend, FRIEND_NAME, 'Luna');
    await expect(host.locator('[data-hello]')).toHaveText(`${HOST_NAME} on Dakota`);
    await expect(friend.locator('[data-hello]')).toHaveText(`${FRIEND_NAME} on Luna`);

    // The host creates a room and reads the code off the lobby.
    await host.locator('[data-action="create-room"]').click();
    await expectScreen(host, 'lobby');
    const code = ((await host.locator('[data-code]').textContent()) ?? '').trim();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);

    // The friend rings; the host sees her at the door and lets her in.
    const ringForm = friend.locator('form[data-form="ring"]');
    await setField(ringForm, 'code', code.toLowerCase());
    await submit(ringForm);
    await expect(friend.locator('[data-status]')).toContainText('Waiting for the host', { timeout: 10_000 });
    const pendingRow = host.locator('[data-list="pending"] [data-id]').first();
    await expect(pendingRow).toContainText(`${FRIEND_NAME} on Luna`, { timeout: 15_000 });
    await host.locator('[data-action="admit"]').first().click();
    await expectScreen(friend, 'lobby', 20_000);
    // One list item per participant (the host's rows also carry a kick button with its own data-id).
    await expect(friend.locator('[data-list="participants"] > li[data-id]')).toHaveCount(2, { timeout: 10_000 });
    await expect(host.locator('[data-list="participants"] > li[data-id]')).toHaveCount(2, { timeout: 10_000 });

    // Both ride the 70 cm class; the host starts.
    await host.locator('select[data-height]').selectOption('70');
    await friend.locator('select[data-height]').selectOption('70');
    await host.locator('[data-action="start-class"]').click();
    await expectScreen(host, 'walk', 15_000);
    await expectScreen(friend, 'walk', 15_000);
    await expect(friend.locator('[data-list="fences"] li').first()).toContainText('Fence 1');
    await expectScreen(host, 'round', 30_000);
    await expectScreen(friend, 'round', 30_000);
    await recordCaptions(friend);

    // The friend's first two fences: a real tap each, timed by the page, judged clean by the server; the host
    // never taps and her horse jumps by itself (a rail each time).
    await tapAtFence(friend, 1, 'Luna');
    await tapAtFence(friend, 2, 'Luna');
    await expect(host.locator('[data-hud-faults]')).not.toHaveText('0 faults', { timeout: 30_000 });

    // The class runs to the results table with both riders. Their order is not pinned: neither presses a turn,
    // so on a club course with turns both can end up eliminated with equal faults, and the server then orders
    // them by account id — the two accepted jumps above are the proof of the input, not the places.
    await expectScreen(host, 'results', 150_000);
    await expectScreen(friend, 'results', 150_000);
    // First the heat that just ended (the results phase, CLASS_TIMING.resultsMs = 15 s even after the last heat),
    // built from the state the server published at that boundary; the class table replaces it after 'done'.
    await expect(host.locator('[data-list="heat"] > li[data-id]')).toHaveCount(2);
    await expect(host.locator('[data-list="heat"]')).toContainText(`${HOST_NAME} on Dakota`);
    await expect(host.locator('[data-list="heat"]')).toContainText(`${FRIEND_NAME} on Luna`);
    await expect(host.locator('[data-list="results"]')).toContainText(`${HOST_NAME} on Dakota`, { timeout: 30_000 });
    await expect(host.locator('[data-list="results"]')).toContainText(`${FRIEND_NAME} on Luna`);
    await expect(friend.locator('[data-list="results"] tr[data-id]')).toHaveCount(2);

    // The tab lifecycle: a visibilitychange on the friend's phone leaves her where she is.
    await friend.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await friend.waitForTimeout(500);
    expect(await screenOf(friend)).toBe('results');

    // The host switches to Spanish, then starts again: both see the next course walk, hers in Spanish.
    await host.locator('[data-action="locale"][data-locale="es"]').click();
    await expect(host.locator('[data-action="again"]')).toHaveText('¡Otra vez!');
    await startAgain(host);
    await expectScreen(friend, 'walk', 15_000);
    await expect(host.locator('[data-list="fences"] li').first()).toContainText('Salto 1');
    await expect(friend.locator('[data-list="fences"] li').first()).toContainText('Fence 1');
  } finally {
    for (const context of contexts) await context.close();
  }
});
