import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../');

export const config = {
  x: {
    username: process.env.X_USERNAME,
    password: process.env.X_PASSWORD,
    email:    process.env.X_EMAIL,
    loginUrl: 'https://x.com/login',
    homeUrl:  'https://x.com/home',
    sessionFile: path.join(root, 'sessions', 'x-session.json'),
  },
  linkedin: {
    email:    process.env.LINKEDIN_EMAIL,
    password: process.env.LINKEDIN_PASSWORD,
    loginUrl: 'https://www.linkedin.com/login',
    homeUrl:  'https://www.linkedin.com/feed',
    sessionFile: path.join(root, 'sessions', 'linkedin-session.json'),
  },
  browser: {
    headless: process.env.HEADLESS !== 'false',
    slowMo:   parseInt(process.env.SLOW_MO  || '80'),
    timeout:  parseInt(process.env.TIMEOUT  || '60000'),
    channel:  process.env.BROWSER_CHANNEL || 'chrome',
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || '',
    profileDir: process.env.BROWSER_PROFILE_DIR || path.join(root, 'profiles', 'default'),
  },
  paths: {
    sessions:    path.join(root, 'sessions'),
    attachments: path.join(root, 'attachments'),
    logs:        path.join(root, 'logs'),
  },
};