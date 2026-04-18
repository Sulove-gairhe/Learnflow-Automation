import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import { config } from '../config/index.js';
import { log } from './logger.js';

const SUPPORTED_IMAGE = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const SUPPORTED_VIDEO = ['video/mp4', 'video/quicktime'];
const MAX_SIZE_MB = 15;

export function resolveAttachments(rawPaths = []) {
  const resolved = [];

  for (const raw of rawPaths) {
    // Support both absolute paths and filenames inside ./attachments/
    const candidates = [
      raw,
      path.join(config.paths.attachments, raw),
      path.resolve(raw),
    ];

    let found = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { found = c; break; }
    }

    if (!found) {
      log.warn(`Attachment not found: ${raw} — skipping`);
      continue;
    }

    const stat = fs.statSync(found);
    const sizeMB = stat.size / (1024 * 1024);
    if (sizeMB > MAX_SIZE_MB) {
      log.warn(`${path.basename(found)} is ${sizeMB.toFixed(1)} MB — exceeds ${MAX_SIZE_MB} MB limit, skipping`);
      continue;
    }

    const type = mime.lookup(found) || 'application/octet-stream';
    if (![...SUPPORTED_IMAGE, ...SUPPORTED_VIDEO].includes(type)) {
      log.warn(`${path.basename(found)} has unsupported type ${type} — skipping`);
      continue;
    }

    resolved.push({ path: found, type, name: path.basename(found) });
    log.dim(`Attachment ready: ${path.basename(found)} (${type}, ${sizeMB.toFixed(2)} MB)`);
  }

  return resolved;
}