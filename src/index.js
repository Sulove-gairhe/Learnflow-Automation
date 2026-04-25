import fs from 'fs';
import fsPromises from 'fs/promises';
import prompts from 'prompts';
import { postToX } from './agents/x.js';
import { postToLinkedIn } from './agents/linkedin.js';
import { resolveAttachments } from './utils/files.js';
import { log } from './utils/logger.js';
import { config } from './config/index.js';

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
  await fsPromises.appendFile('debug-6d4f91.log', `${JSON.stringify(payload)}\n`).catch(() => {});
  // #endregion
}

function getArg(flag, fallback = undefined) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Could not read JSON file ${filePath}: ${e.message}`);
  }
}

async function getInteractivePayload() {
  const answers = await prompts([
    {
      type: 'select',
      name: 'platform',
      message: 'Choose platform',
      choices: [
        { title: 'X', value: 'x' },
        { title: 'LinkedIn', value: 'linkedin' },
        { title: 'Both', value: 'both' },
      ],
      initial: 2,
    },
    {
      type: prev => (prev === 'linkedin' ? null : 'text'),
      name: 'xText',
      message: 'X post text',
      validate: v => (String(v || '').trim() ? true : 'Required'),
    },
    {
      type: prev => (prev === 'x' ? null : 'text'),
      name: 'liText',
      message: 'LinkedIn post text',
      validate: v => (String(v || '').trim() ? true : 'Required'),
    },
    {
      type: 'text',
      name: 'attachmentsRaw',
      message: 'Attachment filenames/paths (comma separated, optional)',
    },
    {
      type: 'toggle',
      name: 'dryRun',
      message: 'Dry run only?',
      initial: true,
      active: 'yes',
      inactive: 'no',
    },
  ], {
    onCancel: () => {
      throw new Error('Cancelled by user');
    },
  });

  const attachments = String(answers.attachmentsRaw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return {
    platform: answers.platform,
    xText: answers.xText || '',
    liText: answers.liText || '',
    attachments,
    dryRun: Boolean(answers.dryRun),
  };
}

async function run() {
  fs.mkdirSync(config.paths.sessions, { recursive: true });
  fs.mkdirSync(config.paths.logs, { recursive: true });

  const argPlatform = getArg('--platform');
  const argFile = getArg('--file');
  const dryRunFlag = process.argv.includes('--dry-run');

  const payload = argFile
    ? readJsonFile(argFile)
    : (argPlatform ? { platform: argPlatform, dryRun: dryRunFlag } : await getInteractivePayload());

  const platform = argPlatform || payload.platform || 'both';
  const dryRun = Boolean(payload.dryRun || dryRunFlag);
  await dbgLog('src/index.js:resolved', 'Resolved runtime mode', {
    argPlatform,
    payloadPlatform: payload?.platform,
    platform,
    dryRun,
  }, 'H9');

  const attachments = resolveAttachments(payload.attachments || []);

  if (!['x', 'linkedin', 'both'].includes(platform)) {
    throw new Error('Invalid platform. Use x, linkedin, or both.');
  }

  if (platform === 'x' || platform === 'both') {
    const text = payload.xText || payload.text || (dryRun ? 'TEST — dry run only' : '');
    if (!text.trim()) throw new Error('Missing X text (xText or text).');
    await postToX({ text, attachments, dryRun });
  }

  if (platform === 'linkedin' || platform === 'both') {
    const text = payload.liText || payload.linkedinText || payload.text || (dryRun ? 'TEST — dry run only' : '');
    if (!text.trim()) throw new Error('Missing LinkedIn text (liText or linkedinText/text).');
    await postToLinkedIn({ text, attachments, dryRun });
  }

  log.success(`Run complete (${platform}${dryRun ? ', dry run' : ''}).`);
}

run().catch((e) => {
  // #region agent log
  dbgLog('src/index.js:catch', 'Top-level run failure', {
    name: e?.name,
    message: e?.message,
  }, 'H12').catch(() => {});
  // #endregion
  log.error(e.message);
  process.exit(1);
});