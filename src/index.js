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

const platform = process.argv.includes('--platform')
  ? process.argv[process.argv.indexOf('--platform') + 1]
  : 'x';

fs.mkdirSync(config.paths.sessions, { recursive: true });
fs.mkdirSync(config.paths.logs,     { recursive: true });

async function loginX() {
  log.step('Starting X manual login session...');

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  await page.goto(config.x.loginUrl);

  // Fill username
  await page.waitForSelector('input[autocomplete="username"]');
  await page.fill('input[autocomplete="username"]', config.x.username);
  await page.click('button:has-text("Next")');

  // Handle possible email verification step
  try {
    await page.waitForSelector('input[data-testid="ocfEnterTextTextInput"]', { timeout: 4000 });
    log.warn('X wants email verification — filling automatically...');
    await page.fill('input[data-testid="ocfEnterTextTextInput"]', config.x.email);
    await page.click('button:has-text("Next")');
  } catch {}

  // Fill password
  await page.waitForSelector('input[type="password"]');
  await page.fill('input[type="password"]', config.x.password);
  await page.click('button:has-text("Log in")');

  log.info('Waiting for X home feed (complete any 2FA in the browser)...');
  await page.waitForURL('**/home', { timeout: 90_000 });

  await saveSession(context, config.x.sessionFile);
  log.success(`X session saved to ${config.x.sessionFile}`);
  await browser.close();
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