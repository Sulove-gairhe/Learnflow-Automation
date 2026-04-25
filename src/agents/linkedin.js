import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config/index.js';
import { log } from '../utils/logger.js';
import { saveSession, sessionExists, loadStorageState } from '../utils/session.js';

async function dbgLog(location, message, data, hypothesisId, runId = 'verify-li') {
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
  }).catch(() => { });
  // #endregion
  // #region agent log
  await fs.appendFile('debug-6d4f91.log', `${JSON.stringify(payload)}\n`).catch(() => { });
  // #endregion
}

// ─── URLs ─────────────────────────────────────────────────────────────────────
const ARTICLE_URL = 'https://www.linkedin.com/post/new/';
const FEED_URL    = 'https://www.linkedin.com/feed';
const LOGIN_URL   = 'https://www.linkedin.com/login';

// ─── Selectors ────────────────────────────────────────────────────────────────
const SEL = {
  // ── Login ──
  emailInput:      '#username',
  passwordInput:   '#password',
  loginBtn:        'button[type="submit"]',

  // ── Article editor (from provided DOM) ──────────────────────────────────────
  // Cover-image upload button inside .article-editor-cover-media
  coverUploadBtn:
    'button[aria-label="Upload from computer"], ' +
    '.article-editor-cover-media_placeholder-fieldset button',

  // Title textarea
  articleTitle:
    'textarea#article-editor-headline_textarea, ' +
    'textarea.article-editor-headline_textarea',

  // Body — LinkedIn wraps Quill/ProseMirror inside this div
  articleBody:
    '.article-editor-content [contenteditable="true"], ' +
    '.article-editor-content .ql-editor, ' +
    '.article-editor-content',

  // Publish / Done button (top-right of article editor)
  publishBtn:
    'button:has-text("Publish"), ' +
    'button:has-text("Done"), ' +
    'button[data-test-article-header-cta-btn]',
};

// ─── Robust goto ─────────────────────────────────────────────────────────────
// Tries domcontentloaded first; if that times out falls back to commit event.
async function robustGoto(page, url) {
  const NAV_TIMEOUT = 90_000;
  log.dim(`Navigating to ${url} …`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch {
    log.warn(`domcontentloaded timed out for ${url}, retrying with commit event…`);
    await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT });
    // Give JS a moment to hydrate after commit
    await page.waitForTimeout(4000);
  }
  await dbgLog('linkedin.js:robustGoto', 'Navigation settled', { url: page.url(), target: url }, 'H15');
}

// ─── Login ───────────────────────────────────────────────────────────────────
async function login(page) {
  log.step('Logging in to LinkedIn…');
  await robustGoto(page, LOGIN_URL);

  const usernameCount = await page.locator(SEL.emailInput).count().catch(() => -1);
  await dbgLog('linkedin.js:login:username-count', 'Username input count', { usernameCount }, 'H16');

  if (usernameCount > 0) {
    await page.waitForSelector(SEL.emailInput, { timeout: 30_000 });
    await page.fill(SEL.emailInput, config.linkedin.email);
    await page.fill(SEL.passwordInput, config.linkedin.password);
    await page.click(SEL.loginBtn);
  }

  // Wait for feed or checkpoint
  await Promise.race([
    page.waitForURL('**/feed/**', { timeout: 90_000 }),
    page.waitForURL('**/checkpoint/**', { timeout: 90_000 }),
  ]).catch(() => { });

  if (page.url().includes('/checkpoint')) {
    log.warn('LinkedIn checkpoint detected. Complete it in the browser window, then press Enter.');
    await page.waitForURL('**/feed/**', { timeout: 120_000 }).catch(() => { });
  }

  const isFeed = page.url().includes('/feed');
  await dbgLog('linkedin.js:login:done', 'Login result', { url: page.url(), isFeed }, 'H16');
  if (!isFeed) {
    throw new Error('LinkedIn login did not reach feed. Check credentials or checkpoint.');
  }
  log.success('Logged in to LinkedIn');
}

// ─── Ensure authenticated ─────────────────────────────────────────────────────
// Navigates to the feed; if redirected to login, performs the login flow.
async function ensureLoggedIn(page) {
  await robustGoto(page, FEED_URL);

  const url = page.url();
  await dbgLog('linkedin.js:ensureLoggedIn', 'Feed navigation result', { url }, 'H15');

  if (url.includes('/login') || url.includes('/authwall')) {
    await login(page);
  } else {
    log.success('Resumed LinkedIn session from saved cookies');
  }
}

// ─── Type text into LinkedIn article body (contenteditable) ──────────────────
async function typeIntoArticleBody(page, text) {
  log.step('Typing article body text…');

  // The article body editor may take a moment to activate
  await page.waitForSelector(SEL.articleBody, { state: 'visible', timeout: 20_000 });
  const editor = page.locator(SEL.articleBody).first();

  await editor.scrollIntoViewIfNeeded();
  await editor.click();
  await editor.focus();

  // 1) Clipboard paste (fastest, preserves newlines)
  let pasted = false;
  try {
    await page.evaluate(async (txt) => { await navigator.clipboard.writeText(txt); }, text);
    await editor.press('Control+v');
    await page.waitForTimeout(600);
    const content = await editor.innerText().catch(() => '');
    if (content.trim()) pasted = true;
  } catch { }

  // 2) execCommand insertText
  if (!pasted) {
    await page.evaluate((txt) => {
      const el = document.querySelector(
        '.article-editor-content [contenteditable="true"], ' +
        '.article-editor-content .ql-editor, ' +
        '.article-editor-content'
      );
      if (el) {
        el.focus();
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, txt);
      }
    }, text);
    await page.waitForTimeout(400);
    const content = await editor.innerText().catch(() => '');
    if (content.trim()) pasted = true;
  }

  // 3) Key-by-key fallback
  if (!pasted) {
    await editor.pressSequentially(text, { delay: 10 });
  }

  log.success('Article body text entered');
}

// ─── Upload cover image ───────────────────────────────────────────────────────
async function uploadCoverImage(page, filePath) {
  log.step('Uploading cover image…');

  const btn = page.locator(SEL.coverUploadBtn).first();
  await btn.waitFor({ state: 'visible', timeout: 15_000 });

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15_000 }),
    btn.click(),
  ]);

  await chooser.setFiles(filePath);
  // Wait for preview / upload animation
  await page.waitForTimeout(3500);
  log.success(`Cover image uploaded: ${path.basename(filePath)}`);
}

// ─── Main post function ───────────────────────────────────────────────────────
export async function postToLinkedIn({ text, attachments = [], dryRun = false }) {
  if (!config.linkedin.email || !config.linkedin.password) {
    throw new Error('LINKEDIN_EMAIL and LINKEDIN_PASSWORD must be set in .env');
  }

  const hasSession = sessionExists(config.linkedin.sessionFile);
  const storageState = hasSession ? loadStorageState(config.linkedin.sessionFile) : undefined;

  const context = await chromium.launchPersistentContext(config.linkedin.profileDir, {
    headless: config.browser.headless,
    slowMo:   config.browser.slowMo,
    channel:  config.browser.executablePath ? undefined : config.browser.channel,
    executablePath: config.browser.executablePath || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
    storageState: storageState || undefined,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();
  // Use a generous per-action timeout; navigation timeouts are handled by robustGoto
  page.setDefaultTimeout(config.browser.timeout);

  try {
    // ── 1. Make sure we are logged in (via Feed check) ────────────────────────
    await ensureLoggedIn(page);

    // ── 2. Navigate to LinkedIn Article editor ────────────────────────────────
    log.step('Opening LinkedIn Article editor…');
    await robustGoto(page, ARTICLE_URL);
    await dbgLog('linkedin.js:post:article-url', 'Navigated to article editor', { url: page.url() }, 'H15');

    // Wait for the article editor scaffold to be present
    await page.waitForSelector(
      '.article-editor-container, .article-editor-headline, textarea#article-editor-headline_textarea',
      { state: 'visible', timeout: 30_000 }
    );
    log.success('Article editor loaded');

    // ── 3. Upload cover image (first attachment, if any) ──────────────────────
    if (attachments.length) {
      const coverPath = attachments[0].path;
      await uploadCoverImage(page, coverPath);

      if (attachments.length > 1) {
        log.warn(
          `Note: The LinkedIn Article editor supports only one cover image. ` +
          `${attachments.length - 1} additional attachment(s) will be skipped.`
        );
      }
    }

    // ── 4. Fill in the article title (first line of text, or a fixed label) ──
    //      We use the full text as both title prefix and body so the post is
    //      meaningful.  Adjust slicing if you want a distinct title field.
    const titleText = text.split('\n')[0].slice(0, 150); // max 150 chars per DOM
    log.step('Filling article title…');
    const titleEl = page.locator(SEL.articleTitle).first();
    await titleEl.waitFor({ state: 'visible', timeout: 15_000 });
    await titleEl.click();
    await titleEl.fill(titleText);
    log.success(`Title set: "${titleText}"`);

    // ── 5. Fill in the article body ───────────────────────────────────────────
    await typeIntoArticleBody(page, text);

    // ── 6. Dry-run: screenshot and exit WITHOUT publishing ────────────────────
    if (dryRun) {
      log.warn('DRY RUN — screenshot taken, article NOT published');
      const ssPath = path.join(config.paths.logs, `linkedin-dry-run-${Date.now()}.png`);
      await page.screenshot({ path: ssPath, fullPage: false });
      log.info(`Screenshot saved to: ${ssPath}`);
      await context.close();
      return { success: true, dryRun: true };
    }

    // ── 7. Publish ────────────────────────────────────────────────────────────
    log.step('Publishing LinkedIn article…');
    const publishBtn = page.locator(SEL.publishBtn).first();
    await publishBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await publishBtn.click();

    // LinkedIn may show a confirmation modal — click the final "Publish" there too
    await page.waitForTimeout(2000);
    const confirmBtn = page.locator('button:has-text("Publish")').last();
    const confirmVisible = await confirmBtn.isVisible().catch(() => false);
    if (confirmVisible) {
      await confirmBtn.click();
      log.dim('Confirmed publish in modal');
    }

    await page.waitForTimeout(3000);
    log.success('Article published on LinkedIn!');

    // ── 8. Save session ───────────────────────────────────────────────────────
    await saveSession(context, config.linkedin.sessionFile);

    await context.close();
    return { success: true, platform: 'linkedin' };

  } catch (err) {
    const screenshotPath = path.join(config.paths.logs, `linkedin-error-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath }).catch(() => { });
    log.error(`LinkedIn agent failed: ${err.message}`);
    log.dim(`Error screenshot: ${screenshotPath}`);
    await context.close();
    throw err;
  }
}