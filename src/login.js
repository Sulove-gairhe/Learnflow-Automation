/**
 * Run this once before your first automated post to save your session.
 * Usage:
 *   node src/login.js --platform x
 *   node src/login.js --platform linkedin
 *
 * This opens a visible browser, lets you complete any 2FA manually,
 * then saves the session cookies so future runs stay logged in.
 */

import { chromium } from 'playwright';
import { config } from './config/index.js';
import { saveSession } from './utils/session.js';
import { log } from './utils/logger.js';
import fs from 'fs';
import path from 'path';

const platform = process.argv.includes('--platform')
  ? process.argv[process.argv.indexOf('--platform') + 1]
  : 'x';

fs.mkdirSync(config.paths.sessions, { recursive: true });
fs.mkdirSync(config.paths.logs,     { recursive: true });

async function snap(page, label) {
  const safe = String(label).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  const file = path.join(config.paths.logs, `${safe}-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  log.dim(`Screenshot saved → ${file}`);
}

async function loginX() {
  log.step('Starting X manual login session...');

  if (!config.x.username || !config.x.password) {
    throw new Error('X_USERNAME and X_PASSWORD must be set in .env');
  }

  const context = await chromium.launchPersistentContext(config.browser.profileDir, {
    headless: false,
    slowMo: config.browser.slowMo,
    channel: config.browser.executablePath ? undefined : config.browser.channel,
    executablePath: config.browser.executablePath || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.browser.timeout);

  await page.goto(config.x.loginUrl, { waitUntil: 'domcontentloaded' });

  // Fill username
  try {
    await page.waitForSelector('input[autocomplete="username"]');
    await page.fill('input[autocomplete="username"]', config.x.username);
    await page.click('button:has-text("Next")');
  } catch (e) {
    log.error(`X login page did not load as expected: ${e.message}`);
    log.dim(`Current URL: ${page.url()}`);
    await snap(page, 'x-login-page-unexpected');
    await context.close();
    throw e;
  }

  // After "Next", X may show: password, an email/phone challenge, or a security checkpoint/captcha.
  // Wait for whichever appears first and react accordingly.
  const password = page.locator('input[type="password"]');
  const ocfInput = page.locator('input[data-testid="ocfEnterTextTextInput"]');
  const phoneEmailInput = page.locator('input[name="text"], input[autocomplete="on"]');
  const checkpointText = page.locator('text=Verify your identity, text=unusual activity, text=Something went wrong');

  try {
    await Promise.race([
      password.waitFor({ state: 'visible', timeout: config.browser.timeout }),
      ocfInput.waitFor({ state: 'visible', timeout: config.browser.timeout }),
      phoneEmailInput.waitFor({ state: 'visible', timeout: config.browser.timeout }),
      checkpointText.first().waitFor({ state: 'visible', timeout: config.browser.timeout }),
    ]);
  } catch (e) {
    log.error(`X did not reach password step: ${e.message}`);
    log.dim(`Current URL: ${page.url()}`);
    await snap(page, 'x-after-next-timeout');
    await context.close();
    throw e;
  }

  // Handle possible email verification step (X sometimes asks for email/phone/username confirmation)
  if (await ocfInput.isVisible().catch(() => false)) {
    if (!config.x.email) {
      log.warn('X asked for email verification but X_EMAIL is not set.');
      log.warn('Please complete this step manually in the browser.');
      await snap(page, 'x-email-verification-needed');
    } else {
      log.warn('X wants email verification — filling automatically...');
      await ocfInput.fill(config.x.email);
      await page.click('button:has-text("Next")');
    }
  } else if (await checkpointText.first().isVisible().catch(() => false)) {
    log.warn('X is showing a security checkpoint / access rejection.');
    log.warn('Complete it manually (captcha/verification), then the script will continue.');
    log.dim(`Current URL: ${page.url()}`);
    await snap(page, 'x-checkpoint');
  } else if (await phoneEmailInput.isVisible().catch(() => false) && !(await password.isVisible().catch(() => false))) {
    log.warn('X is asking for an additional identifier (email/phone/username).');
    log.warn('Complete this step manually, then the script will continue.');
    await snap(page, 'x-additional-identifier');
  }

  // Wait for either password entry or successful navigation after manual checkpoint.
  const reachedHomeDirectly = await Promise.race([
    page.waitForURL('**/home', { timeout: 90_000 }).then(() => true).catch(() => false),
    password.waitFor({ state: 'visible', timeout: 90_000 }).then(() => false).catch(() => false),
  ]);

  // If X still requires password, submit it; otherwise continue.
  if (!reachedHomeDirectly) {
    await password.fill(config.x.password);
    await page.click('button:has-text("Log in"), button:has-text("Log in")');
  }

  log.info('Waiting for X home feed (complete any 2FA in the browser)...');
  await page.waitForURL('**/home', { timeout: 90_000 });

  await saveSession(context, config.x.sessionFile);
  log.success(`X session saved to ${config.x.sessionFile}`);
  await context.close();
}

async function loginLinkedIn() {
  log.step('Starting LinkedIn manual login session...');

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  await page.goto(config.linkedin.loginUrl);
  await page.waitForSelector('#username');
  await page.fill('#username', config.linkedin.email);
  await page.fill('#password', config.linkedin.password);
  await page.click('button[type="submit"]');

  log.info('Waiting for LinkedIn feed (complete any 2FA / CAPTCHA in the browser)...');
  await page.waitForURL('**/feed/**', { timeout: 90_000 });

  await saveSession(context, config.linkedin.sessionFile);
  log.success(`LinkedIn session saved to ${config.linkedin.sessionFile}`);
  await browser.close();
}

if (platform === 'x') {
  loginX().catch(e => { log.error(e.message); process.exit(1); });
} else if (platform === 'linkedin') {
  loginLinkedIn().catch(e => { log.error(e.message); process.exit(1); });
} else {
  log.error('Unknown platform. Use --platform x or --platform linkedin');
  process.exit(1);
}