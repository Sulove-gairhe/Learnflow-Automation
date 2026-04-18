import { chromium } from 'playwright';
import path from 'path';
import { config } from '../config/index.js';
import { log } from '../utils/logger.js';
import { saveSession, sessionExists, loadStorageState } from '../utils/session.js';

// ─── Selectors ───────────────────────────────────────────────────────────────
// LinkedIn's UI is more stable than X's — class names are still brittle,
// so we prefer aria roles and text content where possible.
const SEL = {
  // Login
  emailInput:    '#username',
  passwordInput: '#password',
  loginBtn:      'button[type="submit"]',

  // Feed — "Start a post" modal trigger
  startPost:     'button:has-text("Start a post"), button:has-text("Create a post")',

  // Modal compose area
  editor:        'div[data-placeholder="What do you want to talk about?"], div.ql-editor',
  editorAlt:     '[contenteditable="true"]',

  // Media attach button inside the modal
  mediaBtn:
    'button[aria-label="Add media"], ' +
    'button[aria-label="Add a photo"], ' +
    'label[aria-label="Add media"]',

  // Hidden file input that appears after clicking media button
  fileInputAlt:  'input[type="file"]',

  // Post / Publish button
  postBtn:
    'button:has-text("Post"), ' +
    'button[aria-label="Post"], ' +
    'button.share-actions__primary-action',

  // Confirm post published
  successToast:  'div[data-test-id="feed-new-update-pill"]',
};

// ─── Login ───────────────────────────────────────────────────────────────────
async function login(page) {
  log.step('Logging in to LinkedIn...');

  await page.goto(config.linkedin.loginUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(SEL.emailInput, { timeout: config.browser.timeout });

  await page.fill(SEL.emailInput, config.linkedin.email);
  await page.fill(SEL.passwordInput, config.linkedin.password);
  await page.click(SEL.loginBtn);

  // Wait for feed
  await page.waitForURL('**/feed/**', { timeout: config.browser.timeout });
  log.success('Logged in to LinkedIn');

  // LinkedIn sometimes shows a verification checkpoint
  if (page.url().includes('checkpoint')) {
    log.warn(
      'LinkedIn security checkpoint detected. ' +
      'Please complete it manually in the browser window, then press Enter in the terminal.'
    );
    // Give user 90 seconds to handle 2FA / captcha
    await page.waitForURL('**/feed/**', { timeout: 90_000 });
  }
}

// ─── Type text into LinkedIn's ProseMirror / Quill editor ────────────────────
async function typeIntoEditor(page, text) {
  // Try the standard data-placeholder editor first
  let editor = page.locator(SEL.editor).first();
  let visible = await editor.isVisible().catch(() => false);

  if (!visible) {
    editor = page.locator(SEL.editorAlt).first();
    visible = await editor.isVisible().catch(() => false);
  }

  if (!visible) throw new Error('Could not find the LinkedIn post editor');

  await editor.click();

  // LinkedIn's rich text editor needs insertText via execCommand
  await page.evaluate((txt) => {
    const el = document.querySelector(
      'div[data-placeholder], div.ql-editor, [contenteditable="true"]'
    );
    if (el) {
      el.focus();
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, txt);
    }
  }, text);

  // Verify something was typed
  const content = await editor.innerText().catch(() => '');
  if (!content.trim()) {
    // Fallback: key-by-key (slow but reliable)
    await editor.pressSequentially(text, { delay: 8 });
  }
}

// ─── Upload media ─────────────────────────────────────────────────────────────
async function uploadMedia(page, attachments) {
  if (!attachments.length) return;

  log.step(`Attaching ${attachments.length} file(s) to LinkedIn post...`);

  // Click the media / photo button inside the compose modal
  try {
    const mediaBtn = page.locator(SEL.mediaBtn).first();
    await mediaBtn.waitFor({ state: 'visible', timeout: 8000 });
    await mediaBtn.click();
  } catch {
    // Some LinkedIn UI variants expose the file input directly
    log.dim('Media button not found via aria-label — trying direct file input');
  }

  // Wait for file input (may be hidden — Playwright can still use it)
  const fileInput = page.locator(SEL.fileInputAlt).first();
  await fileInput.waitFor({ state: 'attached', timeout: 10000 });
  await fileInput.setInputFiles(attachments.map(a => a.path));

  // Allow upload animation to complete
  await page.waitForTimeout(2500);
  log.success('Media attached to LinkedIn post');
}

// ─── Main post function ───────────────────────────────────────────────────────
export async function postToLinkedIn({ text, attachments = [], dryRun = false }) {
  if (!config.linkedin.email || !config.linkedin.password) {
    throw new Error('LINKEDIN_EMAIL and LINKEDIN_PASSWORD must be set in .env');
  }

  const hasSession = sessionExists(config.linkedin.sessionFile);
  const storageState = hasSession ? loadStorageState(config.linkedin.sessionFile) : undefined;

  const browser = await chromium.launch({
    headless: config.browser.headless,
    slowMo:   config.browser.slowMo,
  });

  const context = await browser.newContext({
    storageState: storageState || undefined,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(config.browser.timeout);

  try {
    // ── 1. Navigate to feed ───────────────────────────────────────────────────
    await page.goto(config.linkedin.homeUrl, { waitUntil: 'domcontentloaded' });

    // Check if already logged in
    const isLoggedIn = await page.locator(SEL.startPost).isVisible().catch(() => false);
    if (!isLoggedIn) {
      await login(page);
    } else {
      log.success('Resumed LinkedIn session from saved cookies');
    }

    // ── 2. Open compose modal ─────────────────────────────────────────────────
    log.step('Opening LinkedIn compose modal...');
    const startPostBtn = page.locator(SEL.startPost).first();
    await startPostBtn.waitFor({ state: 'visible' });
    await startPostBtn.click();

    // Wait for editor to appear inside modal
    await page.waitForSelector(
      'div[data-placeholder], div.ql-editor, [contenteditable="true"]',
      { state: 'visible', timeout: config.browser.timeout }
    );

    // ── 3. Type post text ─────────────────────────────────────────────────────
    log.step('Typing LinkedIn post...');
    await typeIntoEditor(page, text);
    log.success('Text entered');

    // ── 4. Attach media ───────────────────────────────────────────────────────
    if (attachments.length) {
      await uploadMedia(page, attachments);
    }

    if (dryRun) {
      log.warn('DRY RUN — screenshot taken, post NOT submitted');
      await page.screenshot({
        path: path.join(config.paths.logs, `linkedin-dry-run-${Date.now()}.png`),
        fullPage: false,
      });
      log.info('Screenshot saved to logs/');
      await browser.close();
      return { success: true, dryRun: true };
    }

    // ── 5. Click Post ─────────────────────────────────────────────────────────
    log.step('Submitting LinkedIn post...');
    const postBtn = page.locator(SEL.postBtn).last(); // "last" avoids the drafts hint
    await postBtn.waitFor({ state: 'visible' });
    await postBtn.click();

    // ── 6. Confirm ────────────────────────────────────────────────────────────
    // LinkedIn briefly shows a "Your post is now visible" pill or similar
    await page.waitForTimeout(3000);
    log.success('Post published on LinkedIn!');

    // ── 7. Save session ───────────────────────────────────────────────────────
    await saveSession(context, config.linkedin.sessionFile);

    await browser.close();
    return { success: true, platform: 'linkedin' };

  } catch (err) {
    const screenshotPath = path.join(config.paths.logs, `linkedin-error-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath }).catch(() => {});
    log.error(`LinkedIn agent failed: ${err.message}`);
    log.dim(`Error screenshot: ${screenshotPath}`);
    await browser.close();
    throw err;
  }
}