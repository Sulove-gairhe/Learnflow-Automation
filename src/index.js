import fs from 'fs';
import prompts from 'prompts';
import { postToX } from './agents/x.js';
import { postToLinkedIn } from './agents/linkedin.js';
import { resolveAttachments } from './utils/files.js';
import { log } from './utils/logger.js';
import { config } from './config/index.js';

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

  const platform = payload.platform || argPlatform || 'both';
  const dryRun = Boolean(payload.dryRun || dryRunFlag);

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
  log.error(e.message);
  process.exit(1);
});