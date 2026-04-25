import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config/index.js';
import { log } from '../utils/logger.js';
import { saveSession, sessionExists, loadStorageState } from '../utils/session.js';

async function dbgLog(location, message, data, hypothesisId, runId = 'verify') {
  const payload = {
    sessionId: '6d4f91',
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  // #region agent log
  await fetch('http://127.0.0.1:7396/ingest/b5ac3ef8-24bb-43e1-91fc-81dafb3d5b4b', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '6d4f91',
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
  // #endregion
  // #region agent log
  await fs.appendFile('debug-6d4f91.log', `${JSON.stringify(payload)}\n`).catch(() => {});
  // #endregion
}

// ─── Selectors ───────────────────────────────────────────────────────────────
// These are resilient: prefer data-testid (X's own attributes) over brittle CSS paths.
const SEL = {
  // Login page
  usernameInput: 'input[autocomplete="username"], input[name="text"], input[autocomplete="on"]',
  nextBtn:       'button:has-text("Next")',
  passwordInput: 'input[type="password"]',
  loginBtn:      'button:has-text("Log in")',
  // Sometimes X asks for email verification after username
  emailInput:    'input[data-testid="ocfEnterTextTextInput"]',

  // Compose
  composeBtn:    '[data-testid="SideNav_NewTweet_Button"], [data-testid="AppTabBar_NewTweet_Button"], a[href="/compose/post"]',
  tweetBox:      '[data-testid="tweetTextarea_0"]',
  fileInput:     'input[data-testid="fileInput"]',
  mediaGroup:    '[data-testid="attachments"]',
  submitBtn:     '[data-testid="tweetButtonInline"]',

  // Confirmation that post appeared
  tweetConfirm:  '[data-testid="toast"]',
};

// ─── Login ───────────────────────────────────────────────────────────────────
async function login(page) {
  log.step('Logging in to X...');

  await page.goto(config.x.loginUrl, { waitUntil: 'domcontentloaded' });

  await page.waitForSelector(SEL.usernameInput, { timeout: config.browser.timeout });

  await page.fill(SEL.usernameInput, config.x.username);
  await page.click(SEL.nextBtn);

  // X sometimes asks for email verification before password
  try {
    await page.waitForSelector(SEL.emailInput, { timeout: 4000 });
    log.warn('X asked for email verification — filling in...');
    await page.fill(SEL.emailInput, config.x.email);
    await page.click(SEL.nextBtn);
  } catch {}

  await page.waitForSelector(SEL.passwordInput, { timeout: config.browser.timeout });
  await page.fill(SEL.passwordInput, config.x.password);
  await page.click(SEL.loginBtn);

  // Wait until we land on home feed
  await page.waitForURL('**/home', { timeout: config.browser.timeout });
  log.success('Logged in to X');
}

// ─── Upload attachments ───────────────────────────────────────────────────────
async function uploadFiles(page, attachments) {
  if (!attachments.length) return;

  log.step(`Uploading ${attachments.length} file(s) to X...`);

  // The hidden <input type="file"> — Playwright can set files directly
  const fileInput = page.locator(SEL.fileInput).first();
  await fileInput.setInputFiles(attachments.map(a => a.path));

  // Wait for at least one media preview to appear
  await page.waitForSelector(SEL.mediaGroup, {
    timeout: config.browser.timeout,
    state: 'attached',
  });

  log.success('Files attached');
}

async function resolveActiveTweetBox(page) {
  const dialogBox = page.locator('[role="dialog"] [data-testid="tweetTextarea_0"]').first();
  const primaryBox = page.locator('[data-testid="primaryColumn"] [data-testid="tweetTextarea_0"]').first();
  const anyBox = page.locator(SEL.tweetBox).first();

  if (await dialogBox.isVisible().catch(() => false)) return { locator: dialogBox, scope: 'dialog' };
  if (await primaryBox.isVisible().catch(() => false)) return { locator: primaryBox, scope: 'primaryColumn' };
  return { locator: anyBox, scope: 'fallbackAny' };
}

// ─── Post ─────────────────────────────────────────────────────────────────────
export async function postToX({ text, attachments = [], dryRun = false }) {
  if (!config.x.username || !config.x.password) {
    throw new Error('X_USERNAME and X_PASSWORD must be set in .env');
  }

  const hasSession = sessionExists(config.x.sessionFile);
  const storageState = hasSession ? loadStorageState(config.x.sessionFile) : undefined;
  const context = await chromium.launchPersistentContext(config.browser.profileDir, {
    headless: config.browser.headless,
    slowMo:   config.browser.slowMo,
    channel: config.browser.executablePath ? undefined : config.browser.channel,
    executablePath: config.browser.executablePath || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
    storageState: storageState || undefined,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(config.browser.timeout);

  try {
    // ── 1. Go to home; login if session doesn't work ──────────────────────────
    await page.goto(config.x.homeUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForLoadState('domcontentloaded');
    const isLoggedIn = await page.locator(SEL.composeBtn).first().isVisible().catch(() => false);
    const isTweetBoxVisible = await page.locator(SEL.tweetBox).first().isVisible().catch(() => false);
    const inLoginFlowByUrl = /\/i\/flow\/login|\/login/.test(page.url());
    const loginInputsPresent = await page.locator(SEL.usernameInput).count().catch(() => 0);

    const seemsLoggedIn = isLoggedIn || isTweetBoxVisible;
    if (!seemsLoggedIn && (inLoginFlowByUrl || loginInputsPresent > 0)) {
      await login(page);
    } else {
      log.success('Resumed X session from saved cookies');
    }
    await dbgLog('src/agents/x.js:auth-branch', 'Resolved X auth branch', {
      seemsLoggedIn,
      inLoginFlowByUrl,
      loginInputsPresent,
      pageUrl: page.url(),
    }, 'H10');

    // ── 2. Click "Post" / compose button ─────────────────────────────────────
    log.step('Opening compose dialog...');
    await page.click(SEL.composeBtn);
    await page.waitForSelector(SEL.tweetBox, { state: 'visible' });

    // ── 3. Attach files first (upload clears the box if done after typing) ────
    if (attachments.length) {
      await uploadFiles(page, attachments);
      // After upload X re-renders the compose area — wait for it to settle
      await page.waitForTimeout(1500);
    }

    // ── 4. Type the post content ──────────────────────────────────────────────
    log.step('Typing post content...');
    const activeTweetBox = await resolveActiveTweetBox(page);
    await dbgLog('src/agents/x.js:active-box', 'Selected active tweet box', {
      scope: activeTweetBox.scope,
    }, 'H11');
    const mask = page.locator('[data-testid="mask"]').first();
    const maskVisibleBefore = await mask.isVisible().catch(() => false);
    await dbgLog('src/agents/x.js:mask-before-focus', 'Mask visibility before focusing editor', {
      maskVisibleBefore,
    }, 'H14');
    if (maskVisibleBefore) {
      await mask.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    }
    await activeTweetBox.locator.click();
    await activeTweetBox.locator.focus();

    // Try clipboard paste first (most reliable for X's draft editor)
    let typed = false;
    try {
      await page.evaluate(async (txt) => {
        await navigator.clipboard.writeText(txt);
      }, text);
      await activeTweetBox.locator.press('Control+v');
      await page.waitForTimeout(500);
      const afterPaste = await activeTweetBox.locator.innerText().catch(() => '');
      if (afterPaste.trim()) typed = true;
    } catch {}

    // Fallback: execCommand insertText
    if (!typed) {
      await activeTweetBox.locator.evaluate((el, txt) => {
        if (el) {
          el.focus();
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, txt);
        }
      }, text);
      await page.waitForTimeout(300);
      const afterExec = await activeTweetBox.locator.innerText().catch(() => '');
      if (afterExec.trim()) typed = true;
    }

    // Final fallback: key-by-key
    if (!typed) {
      await activeTweetBox.locator.pressSequentially(text, { delay: 15 });
    }

    log.success('Text entered');

    if (dryRun) {
      log.warn('DRY RUN — skipping actual post submission');
      await page.screenshot({
        path: path.join(config.paths.logs, `x-dry-run-${Date.now()}.png`),
      });
      log.info('Screenshot saved to logs/');
      await context.close();
      return { success: true, dryRun: true };
    }

    // ── 5. Click "Post" ───────────────────────────────────────────────────────
    log.step('Submitting post...');
    const submitBtn = page.locator(SEL.submitBtn);
    await submitBtn.waitFor({ state: 'visible' });
    await submitBtn.click();

    // ── 6. Wait for success toast ─────────────────────────────────────────────
    try {
      await page.waitForSelector(SEL.tweetConfirm, { timeout: 15000 });
      log.success('Post published on X!');
    } catch {
      log.warn('Could not confirm toast — post may still have succeeded. Check your profile.');
    }

    // ── 7. Save session for next run ──────────────────────────────────────────
    await saveSession(context, config.x.sessionFile);

    await context.close();
    return { success: true, platform: 'x' };

  } catch (err) {
    // #region agent log
    await dbgLog('src/agents/x.js:catch', 'X agent catch', {
      name: err?.name,
      message: err?.message,
      pageUrl: page.url(),
    }, 'H13');
    // #endregion
    const screenshotPath = path.join(config.paths.logs, `x-error-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    log.error(`X agent failed: ${err.message}`);
    log.dim(`Screenshot saved: ${screenshotPath}`);
    await context.close();
    throw err;
  }
}