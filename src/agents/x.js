import { chromium } from 'playwright';
import path from 'path';
import { config } from '../config/index.js';
import { log } from '../utils/logger.js';
import { saveSession, sessionExists, loadStorageState } from '../utils/session.js';

// ─── Selectors ───────────────────────────────────────────────────────────────
// These are resilient: prefer data-testid (X's own attributes) over brittle CSS paths.
const SEL = {
  // Login page
  usernameInput: 'input[autocomplete="username"]',
  nextBtn:       'button:has-text("Next")',
  passwordInput: 'input[type="password"]',
  loginBtn:      'button:has-text("Log in")',
  // Sometimes X asks for email verification after username
  emailInput:    'input[data-testid="ocfEnterTextTextInput"]',

  // Compose
  composeBtn:    '[data-testid="SideNav_NewTweet_Button"]',
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

    const isLoggedIn = await page.locator(SEL.composeBtn).isVisible().catch(() => false);
    if (!isLoggedIn) {
      await login(page);
    } else {
      log.success('Resumed X session from saved cookies');
    }

    // ── 2. Click "Post" / compose button ─────────────────────────────────────
    log.step('Opening compose dialog...');
    await page.click(SEL.composeBtn);
    await page.waitForSelector(SEL.tweetBox, { state: 'visible' });

    // ── 3. Type the post content ──────────────────────────────────────────────
    log.step('Typing post content...');
    await page.click(SEL.tweetBox);

    // Use keyboard to type — more human-like than fill()
    // For long text, clipboard paste is more reliable
    await page.evaluate((txt) => {
      const el = document.querySelector('[data-testid="tweetTextarea_0"] div[contenteditable]');
      if (el) {
        el.focus();
        document.execCommand('insertText', false, txt);
      }
    }, text);

    // Fallback if execCommand didn't work
    const boxContent = await page.locator('[data-testid="tweetTextarea_0"]').innerText();
    if (!boxContent.trim()) {
      await page.locator(SEL.tweetBox).pressSequentially(text, { delay: 10 });
    }

    log.success('Text entered');

    // ── 4. Attach files ───────────────────────────────────────────────────────
    if (attachments.length) {
      await uploadFiles(page, attachments);
    }

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
    const screenshotPath = path.join(config.paths.logs, `x-error-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    log.error(`X agent failed: ${err.message}`);
    log.dim(`Screenshot saved: ${screenshotPath}`);
    await context.close();
    throw err;
  }
}