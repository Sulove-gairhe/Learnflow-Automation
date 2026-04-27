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
const FEED_URL = 'https://www.linkedin.com/feed';
const LOGIN_URL = 'https://www.linkedin.com/login';

// ─── Selectors ────────────────────────────────────────────────────────────────
const SEL = {
  // ── Login ──
  emailInput: '#username',
  passwordInput: '#password',
  loginBtn: 'button[type="submit"]',

  // ── Feed: "Start a post" button (from user-provided DOM) ─────────────────
  // div[role="button"] with aria-label="Start a post"
  startPostBtn:
    'div[role="button"][aria-label="Start a post"], ' +
    'button[aria-label="Start a post"]',

  // ── Feed: Quick-action buttons (below "Start a post") ────────────────────
  // Photo button — contains svg#image-medium and text "Photo"
  feedPhotoBtn:
    'div[role="button"]:has(svg#image-medium), ' +
    'div[role="button"]:has-text("Photo"):not(:has-text("Video"))',

  // Video button — contains svg#video-medium and text "Video"
  feedVideoBtn:
    'div[role="button"]:has(svg#video-medium), ' +
    'div[role="button"]:has-text("Video")',

  // ── Composer modal ───────────────────────────────────────────────────────
  // Must be visible and NOT aria-hidden — avoids matching vjs-modal-dialog and other hidden dialogs
  composerModal:
    '[role="dialog"]:not([aria-hidden="true"]):not(.vjs-modal-dialog)',

  // Text editor inside the modal
  composerEditor:
    '[role="dialog"]:not([aria-hidden="true"]) div[role="textbox"], ' +
    '[role="dialog"]:not([aria-hidden="true"]) [contenteditable="true"], ' +
    '[role="dialog"]:not([aria-hidden="true"]) .ql-editor',

  // Media / image button inside the composer toolbar
  composerMediaBtn:
    '[role="dialog"]:not([aria-hidden="true"]) button[aria-label="Add media"], ' +
    '[role="dialog"]:not([aria-hidden="true"]) button[aria-label="Add a photo"], ' +
    '[role="dialog"]:not([aria-hidden="true"]) button:has(svg#image-medium), ' +
    '[role="dialog"]:not([aria-hidden="true"]) [aria-label="Add media"]',

  // Photo quick-action button on the feed (pre-modal, opens composer + file chooser)
  // Identified from user-provided DOM: role="button" containing svg#image-medium and <p>Photo</p>
  // NOTE: componentkey changes per session — don't rely on it as primary selector
  feedPhotoQuickBtn:
    'div[role="button"]:has(svg[id="image-medium"]), ' +
    'div[role="button"]:has(svg[id*="image"]):has(p)',

  // Hidden file input (for programmatic upload)
  fileInput: 'input[type="file"]',

  // Post / submit button inside the modal
  postBtn:
    '[role="dialog"]:not([aria-hidden="true"]) button:has-text("Post"), ' +
    '[role="dialog"]:not([aria-hidden="true"]) button.share-actions__primary-action, ' +
    'button.share-actions__primary-action:has-text("Post")',
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

// ─── Open the feed post composer modal ────────────────────────────────────────
// Clicks "Start a post" on the feed and waits for the composer dialog to open.
async function openComposer(page) {
  log.step('Opening post composer from feed…');

  // Give the feed time to fully render
  await page.waitForTimeout(3000);

  // ── Probe the DOM to find the "Start a post" element ───────────────────────
  const probe = await page.evaluate(() => {
    const results = {};

    // Check aria-label selectors
    const ariaBtn = document.querySelector('div[role="button"][aria-label="Start a post"]');
    results.ariaLabel = ariaBtn ? {
      tag: ariaBtn.tagName,
      role: ariaBtn.getAttribute('role'),
      ariaLabel: ariaBtn.getAttribute('aria-label'),
      classes: ariaBtn.className.slice(0, 120),
      visible: ariaBtn.offsetParent !== null,
    } : null;

    // Check for any element with "Start a post" text
    const allButtons = document.querySelectorAll('div[role="button"]');
    const textMatches = [];
    allButtons.forEach(btn => {
      const txt = btn.textContent?.trim();
      if (txt && txt.toLowerCase().includes('start a post')) {
        textMatches.push({
          tag: btn.tagName,
          role: btn.getAttribute('role'),
          ariaLabel: btn.getAttribute('aria-label'),
          text: txt.slice(0, 80),
          componentkey: btn.getAttribute('componentkey'),
          visible: btn.offsetParent !== null,
        });
      }
    });
    results.textMatches = textMatches;

    // Check for the share-box placeholder input
    const placeholder = document.querySelector('[placeholder*="post" i], [placeholder*="talk about" i]');
    results.placeholder = placeholder ? {
      tag: placeholder.tagName,
      placeholder: placeholder.getAttribute('placeholder'),
      role: placeholder.getAttribute('role'),
    } : null;

    // Check for any element with text "Start a post" (broader search)
    const allEls = document.querySelectorAll('*');
    const broadMatches = [];
    allEls.forEach(el => {
      if (el.childElementCount === 0 && el.textContent?.trim() === 'Start a post') {
        broadMatches.push({
          tag: el.tagName,
          parentTag: el.parentElement?.tagName,
          parentRole: el.parentElement?.getAttribute('role'),
          parentAriaLabel: el.parentElement?.getAttribute('aria-label'),
          classes: el.className?.toString().slice(0, 80),
        });
      }
    });
    results.broadTextMatches = broadMatches.slice(0, 5);

    return results;
  });

  await dbgLog('linkedin.js:openComposer:probe', 'DOM probe results', probe, 'H17');
  log.dim(`DOM probe: ariaLabel=${!!probe.ariaLabel}, textMatches=${probe.textMatches.length}, broadText=${probe.broadTextMatches.length}`);

  // ── Try multiple selector strategies in order ──────────────────────────────
  let clicked = false;

  // Strategy 1: aria-label based (from user-provided DOM)
  if (!clicked) {
    const sel1 = page.locator('div[role="button"][aria-label="Start a post"]').first();
    if (await sel1.isVisible().catch(() => false)) {
      log.dim('Using selector: div[role="button"][aria-label="Start a post"]');
      await sel1.scrollIntoViewIfNeeded();
      await sel1.click({ force: true });
      clicked = true;
    }
  }

  // Strategy 2: Playwright getByRole with accessible name
  if (!clicked) {
    const sel2 = page.getByRole('button', { name: /start a post/i }).first();
    if (await sel2.isVisible().catch(() => false)) {
      log.dim('Using selector: getByRole("button", { name: /start a post/i })');
      await sel2.scrollIntoViewIfNeeded();
      await sel2.click({ force: true });
      clicked = true;
    }
  }

  // Strategy 3: Text-based selector
  if (!clicked) {
    const sel3 = page.locator('div[role="button"]:has-text("Start a post")').first();
    if (await sel3.isVisible().catch(() => false)) {
      log.dim('Using selector: div[role="button"]:has-text("Start a post")');
      await sel3.scrollIntoViewIfNeeded();
      await sel3.click({ force: true });
      clicked = true;
    }
  }

  // Strategy 4: Playwright getByText
  if (!clicked) {
    const sel4 = page.getByText('Start a post', { exact: true }).first();
    if (await sel4.isVisible().catch(() => false)) {
      log.dim('Using selector: getByText("Start a post")');
      await sel4.scrollIntoViewIfNeeded();
      await sel4.click({ force: true });
      clicked = true;
    }
  }

  // Strategy 5: JS dispatchEvent — bypasses any overlay intercepting pointer events
  if (!clicked) {
    const dispatched = await page.evaluate(() => {
      const candidates = [
        document.querySelector('div[role="button"][aria-label="Start a post"]'),
        ...Array.from(document.querySelectorAll('div[role="button"]')).filter(
          el => el.textContent?.trim().toLowerCase().includes('start a post')
        ),
      ].filter(Boolean);
      const el = candidates[0];
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    });
    if (dispatched) {
      log.dim('Using strategy: JS dispatchEvent click');
      clicked = true;
    }
  }

  // Strategy 6: componentkey text match (legacy fallback)
  if (!clicked) {
    const sel6 = page.locator('div[componentkey] >> text=Start a post').first();
    if (await sel6.isVisible().catch(() => false)) {
      log.dim('Using selector: componentkey text match');
      await sel6.scrollIntoViewIfNeeded();
      await sel6.click({ force: true });
      clicked = true;
    }
  }

  if (!clicked) {
    // Take a screenshot for debugging before failing
    const ssPath = path.join(config.paths.logs, `linkedin-startpost-debug-${Date.now()}.png`);
    await page.screenshot({ path: ssPath, fullPage: false });
    log.error(`Debug screenshot: ${ssPath}`);
    throw new Error('Could not find or click the "Start a post" button on the feed.');
  }

  log.success('"Start a post" clicked');

  // Wait for the composer dialog to appear
  await page.waitForSelector(SEL.composerModal, { state: 'visible', timeout: 20_000 });
  log.success('Post composer modal opened');
  await dbgLog('linkedin.js:openComposer', 'Composer modal visible', { url: page.url() }, 'H17');

  // Short pause for the editor to fully hydrate
  await page.waitForTimeout(1500);
}

// ─── Upload media inside the composer modal ──────────────────────────────────
async function uploadMedia(page, attachments) {
  if (!attachments.length) return;

  log.step(`Uploading ${attachments.length} file(s)…`);

  let chooserOpened = false;

  // ── Strategy 1: In-modal media/image button (composer toolbar) ─────────────
  // LinkedIn's composer toolbar has a button with svg#image-medium or aria-label
  try {
    const mediaBtn = page.locator(SEL.composerMediaBtn).first();
    const mediaBtnVisible = await mediaBtn.isVisible().catch(() => false);
    await dbgLog('linkedin.js:uploadMedia', 'Composer media button visibility', { mediaBtnVisible }, 'H18');

    if (mediaBtnVisible) {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10_000 }),
        mediaBtn.click(),
      ]);
      await chooser.setFiles(attachments.map(a => a.path));
      chooserOpened = true;
      log.dim('Strategy 1 (composer media button) succeeded');
    }
  } catch (e) {
    await dbgLog('linkedin.js:uploadMedia', 'Strategy 1 failed', { error: e.message }, 'H18');
  }

  // ── Strategy 2: Feed "Photo" quick-action button (from user-provided DOM) ──
  // The feed has a div[role="button"] containing svg#image-medium and text "Photo".
  // Clicking it opens the composer AND triggers the file chooser in one shot.
  // We only try this if the modal is not yet open (i.e., we haven't entered via openComposer).
  if (!chooserOpened) {
    try {
      // Check if the feed photo button is accessible (modal may already be open)
      const feedPhotoBtn = page.locator(SEL.feedPhotoQuickBtn).first();
      const feedPhotoBtnVisible = await feedPhotoBtn.isVisible().catch(() => false);
      await dbgLog('linkedin.js:uploadMedia', 'Feed photo quick-action button visibility', { feedPhotoBtnVisible }, 'H18');

      if (feedPhotoBtnVisible) {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10_000 }),
          feedPhotoBtn.click(),
        ]);
        await chooser.setFiles(attachments.map(a => a.path));
        chooserOpened = true;
        log.dim('Strategy 2 (feed Photo quick-action button) succeeded');

        // Wait for the composer modal to appear after the feed button click
        await page.waitForSelector(SEL.composerModal, { state: 'visible', timeout: 20_000 });
        await page.waitForTimeout(1500);
      }
    } catch (e) {
      await dbgLog('linkedin.js:uploadMedia', 'Strategy 2 failed', { error: e.message }, 'H18');
    }
  }

  // ── Strategy 3: Probe all buttons inside the modal for any image-related one ─
  // Broader search: any button/div inside the dialog that has svg#image-medium
  if (!chooserOpened) {
    try {
      const broadMediaBtn = page.locator(
        '[role="dialog"] div[role="button"]:has(svg#image-medium), ' +
        '[role="dialog"] button:has(svg#image-medium), ' +
        '[role="dialog"] [aria-label*="photo" i], ' +
        '[role="dialog"] [aria-label*="image" i], ' +
        '[role="dialog"] [aria-label*="media" i]'
      ).first();
      const broadVisible = await broadMediaBtn.isVisible().catch(() => false);
      await dbgLog('linkedin.js:uploadMedia', 'Broad modal media button visibility', { broadVisible }, 'H18');

      if (broadVisible) {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10_000 }),
          broadMediaBtn.click(),
        ]);
        await chooser.setFiles(attachments.map(a => a.path));
        chooserOpened = true;
        log.dim('Strategy 3 (broad modal media button) succeeded');
      }
    } catch (e) {
      await dbgLog('linkedin.js:uploadMedia', 'Strategy 3 failed', { error: e.message }, 'H18');
    }
  }

  // ── Strategy 4: Directly set files on hidden input[type="file"] ────────────
  if (!chooserOpened) {
    try {
      const fileInput = page.locator(SEL.fileInput).first();
      await fileInput.setInputFiles(attachments.map(a => a.path));
      chooserOpened = true;
      log.dim('Strategy 4 (hidden file input) succeeded');
      await dbgLog('linkedin.js:uploadMedia', 'Used hidden file input', {}, 'H18');
    } catch (e) {
      await dbgLog('linkedin.js:uploadMedia', 'Strategy 4 (hidden file input) failed', { error: e.message }, 'H18');
    }
  }

  if (!chooserOpened) {
    log.warn('Could not find media upload mechanism — attachments may not be uploaded.');
    return;
  }

  // Wait for upload/preview to settle
  await page.waitForTimeout(3500);
  log.success(`${attachments.length} file(s) attached`);
}

// ─── Type text into the composer editor ──────────────────────────────────────
async function typeIntoComposer(page, text) {
  log.step('Typing post text…');

  // Wait for the composer modal to be stable before looking for the editor.
  // After an image upload LinkedIn may re-render the modal — give it a moment.
  await page.waitForSelector(SEL.composerModal, { state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(800);

  // Wait for the text editor inside the modal
  await page.waitForSelector(SEL.composerEditor, { state: 'visible', timeout: 20_000 });
  const editor = page.locator(SEL.composerEditor).first();

  await editor.scrollIntoViewIfNeeded();
  // Use force:true to bypass any overlay that may intercept pointer events
  await editor.click({ force: true });
  await editor.focus();
  await page.waitForTimeout(300);

  // 1) Clipboard paste (fastest, preserves newlines)
  let pasted = false;
  try {
    await page.evaluate(async (txt) => { await navigator.clipboard.writeText(txt); }, text);
    await editor.press('Control+v');
    await page.waitForTimeout(600);
    const content = await editor.innerText().catch(() => '');
    if (content.trim()) pasted = true;
    await dbgLog('linkedin.js:typeIntoComposer', 'Clipboard paste result', { pasted, contentLen: content.length }, 'H19');
  } catch { }

  // 2) execCommand insertText
  if (!pasted) {
    await page.evaluate((txt) => {
      const el = document.querySelector(
        '[role="dialog"]:not([aria-hidden="true"]) div[role="textbox"], ' +
        '[role="dialog"]:not([aria-hidden="true"]) [contenteditable="true"], ' +
        '[role="dialog"]:not([aria-hidden="true"]) .ql-editor'
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
    await dbgLog('linkedin.js:typeIntoComposer', 'execCommand result', { pasted, contentLen: content.length }, 'H19');
  }

  // 3) Key-by-key fallback
  if (!pasted) {
    await dbgLog('linkedin.js:typeIntoComposer', 'Falling back to key-by-key', {}, 'H19');
    await editor.pressSequentially(text, { delay: 10 });
  }

  log.success('Post text entered');
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
    slowMo: config.browser.slowMo,
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
  // Use a generous per-action timeout; navigation timeouts are handled by robustGoto
  page.setDefaultTimeout(config.browser.timeout);

  try {
    // ── 1. Make sure we are logged in (via Feed check) ────────────────────────
    await ensureLoggedIn(page);

    // ── 2. Open the post composer from the feed ──────────────────────────────
    // If we have attachments, the feed "Photo" quick-action button opens the
    // composer AND triggers the file chooser in one shot — use that path.
    // Otherwise fall back to the regular "Start a post" button.
    if (attachments.length) {
      await page.waitForTimeout(3000); // let feed render

      const feedPhotoBtn = page.locator(SEL.feedPhotoQuickBtn).first();
      const feedPhotoBtnVisible = await feedPhotoBtn.isVisible().catch(() => false);
      await dbgLog('linkedin.js:postToLinkedIn', 'Feed photo button check', { feedPhotoBtnVisible }, 'H18');

      if (feedPhotoBtnVisible) {
        log.step('Opening composer via feed Photo button (with file chooser)…');
        try {
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 15_000 }),
            feedPhotoBtn.click(),
          ]);
          await chooser.setFiles(attachments.map(a => a.path));
          log.success('Feed Photo button clicked — file chooser handled');

          // After the file chooser is dismissed the composer modal should appear.
          // Use a poll loop instead of a hard waitForSelector so we don't throw
          // if the dialog was already in the DOM before the chooser closed.
          let modalVisible = false;
          for (let i = 0; i < 20; i++) {
            modalVisible = await page.locator(SEL.composerModal).isVisible().catch(() => false);
            if (modalVisible) break;
            await page.waitForTimeout(500);
          }

          if (!modalVisible) {
            throw new Error('Composer modal did not appear after file chooser');
          }

          log.success('Post composer modal opened');
          await page.waitForTimeout(3500); // let upload/preview settle

          // Skip the separate uploadMedia call since files are already set
          attachments = []; // clear so the uploadMedia block below is skipped
        } catch (e) {
          await dbgLog('linkedin.js:postToLinkedIn', 'Feed photo button path failed, falling back', { error: e.message }, 'H18');
          log.warn('Feed Photo button path failed — falling back to openComposer + uploadMedia');

          // Only call openComposer if the modal is NOT already open.
          // (The modal may be open but in a broken state — check first.)
          const modalAlreadyOpen = await page.locator(SEL.composerModal).isVisible().catch(() => false);
          if (!modalAlreadyOpen) {
            await openComposer(page);
          } else {
            log.dim('Modal already open — skipping openComposer, proceeding to uploadMedia');
          }
        }
      } else {
        // Feed photo button not visible — open composer normally, upload inside
        await openComposer(page);
      }
    } else {
      await openComposer(page);
    }

    // ── 3. Upload attachments (only if not already handled above) ────────────
    if (attachments.length) {
      await uploadMedia(page, attachments);
      // After upload the composer may re-render — wait for it to settle
      await page.waitForTimeout(1500);
    }

    // ── 4. Type the post content ─────────────────────────────────────────────
    await typeIntoComposer(page, text);

    // ── 5. Dry-run: screenshot and exit WITHOUT posting ──────────────────────
    if (dryRun) {
      log.warn('DRY RUN — screenshot taken, post NOT published');
      const ssPath = path.join(config.paths.logs, `linkedin-dry-run-${Date.now()}.png`);
      await page.screenshot({ path: ssPath, fullPage: false });
      log.info(`Screenshot saved to: ${ssPath}`);
      await context.close();
      return { success: true, dryRun: true };
    }

    // ── 6. Publish ───────────────────────────────────────────────────────────
    log.step('Publishing LinkedIn post…');
    const postBtn = page.locator(SEL.postBtn).first();
    await postBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await postBtn.click();

    // LinkedIn may show a confirmation — wait for dialog to close
    await page.waitForTimeout(3000);
    // Check if modal is still open (confirmation step)
    const stillOpen = await page.locator(SEL.composerModal).isVisible().catch(() => false);
    if (stillOpen) {
      const confirmBtn = page.locator('button:has-text("Post")').last();
      const confirmVisible = await confirmBtn.isVisible().catch(() => false);
      if (confirmVisible) {
        await confirmBtn.click();
        log.dim('Confirmed publish in modal');
      }
    }

    await page.waitForTimeout(3000);
    log.success('Post published on LinkedIn!');

    // ── 7. Save session ──────────────────────────────────────────────────────
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