# Playwright Posting Agent

Autonomous browser agent that posts to **X (Twitter)** and **LinkedIn** — including file/image attachments — without requiring API keys.

---

## How it works

Playwright controls a real Chromium browser. It logs in to X and LinkedIn using your credentials, opens the compose dialog, types your post, attaches files, and clicks Post. Sessions are saved as cookies so you only log in manually once.

---

## Requirements

- Node.js 18 or higher
- macOS, Linux, or Windows (WSL works best on Windows)

---

## Setup

### 1. Install dependencies

```bash
cd playwright-poster
npm install
npx playwright install chromium
```

### 2. Create your .env file

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```env
X_USERNAME=your_x_handle
X_PASSWORD=your_x_password
X_EMAIL=your_email@example.com

LINKEDIN_EMAIL=your@email.com
LINKEDIN_PASSWORD=yourpassword

HEADLESS=false   # keep false until sessions are saved
SLOW_MO=80
TIMEOUT=30000
```

### 3. Save your login sessions (do this once)

This opens a visible browser. Log in normally and complete any 2FA. The session is saved for future headless runs.

```bash
# Save X session
npm run login:x

# Save LinkedIn session
npm run login:linkedin
```

After both sessions are saved, you can set `HEADLESS=true` in `.env` for silent background posting.

---

## Usage

### Interactive mode (recommended for first use)

```bash
npm run post
```

You will be prompted to:
1. Choose platform (X, LinkedIn, or both)
2. Paste your X post text
3. Paste your LinkedIn post text
4. Enter attachment filenames (optional)
5. Confirm dry run or live post

### Command-line mode

```bash
# Post to both platforms
npm run post:both

# Post to X only
npm run post:x

# Post to LinkedIn only
npm run post:linkedin

# Dry run (takes screenshot, does not post)
node src/index.js --platform both --dry-run
```

### JSON file mode (integrates with your hub app)

Create a `post.json` file (see `post.example.json`) and run:

```bash
node src/index.js --file ./post.json
```

This is how you connect the Daily Learning Hub to the agent — the hub writes a `post.json` and triggers this script.

---

## Adding attachments

Put image or video files in the `attachments/` folder. Reference them by filename in your post JSON or at the interactive prompt:

```
Attachment filenames: screenshot-day7.png, code-snippet.png
```

Supported formats: JPEG, PNG, GIF, WebP, MP4, MOV  
Max size: 15 MB per file

---

## Connecting to your Learning Hub

In your hub app, add a "Post now" button that:

1. Writes the generated posts to `post.json`
2. Copies any attachment files into `attachments/`
3. Runs `node src/index.js --file ./post.json --platform both`

Example from a Node.js backend:

```js
import { execSync } from 'child_process';
import fs from 'fs';

function triggerPost(xText, liText, attachmentPaths = []) {
  const post = { platform: 'both', dryRun: false, xText, liText, attachments: attachmentPaths };
  fs.writeFileSync('./post.json', JSON.stringify(post, null, 2));
  execSync('node src/index.js --file ./post.json', { stdio: 'inherit' });
}
```

---

## Troubleshooting

### "Could not find compose button"
- X and LinkedIn update their UI regularly. Check `logs/` for an error screenshot.
- Run with `HEADLESS=false` to watch what happens.
- The selectors in `src/agents/x.js` and `src/agents/linkedin.js` may need updating.

### "Login failed"
- Delete your session file in `sessions/` and run `npm run login:x` or `npm run login:linkedin` again.
- If 2FA is enabled, the login script waits 90 seconds for you to complete it manually.

### X character limit
- X's limit is 280 characters. The agent does not enforce this — it will submit whatever text you give it.

### LinkedIn checkpoint / CAPTCHA
- LinkedIn sometimes shows a security checkpoint after login. Run `npm run login:linkedin` with the browser visible (`HEADLESS=false`) and complete the CAPTCHA manually.

---

## File structure

```
playwright-poster/
├── src/
│   ├── agents/
│   │   ├── x.js          ← X posting agent
│   │   └── linkedin.js   ← LinkedIn posting agent
│   ├── config/
│   │   └── index.js      ← loads .env, exports config
│   ├── utils/
│   │   ├── logger.js     ← coloured terminal + file logging
│   │   ├── session.js    ← save/load browser cookies
│   │   └── files.js      ← validate and resolve attachments
│   ├── index.js          ← main entry point / CLI
│   └── login.js          ← standalone login script
├── attachments/          ← put your images/files here
├── sessions/             ← saved browser sessions (git-ignored)
├── logs/                 ← run logs + error screenshots
├── post.example.json     ← example post file
├── .env.example
└── package.json
```

---

## Important notes

Browser automation of social platforms sits in a grey area of their Terms of Service. This agent:
- Uses your own personal credentials
- Posts on your behalf (not at scale)
- Does not scrape or harvest data
- Posts once per run, not in bulk

For high-volume or commercial use, the official X API v2 and LinkedIn Share API are the correct tools.