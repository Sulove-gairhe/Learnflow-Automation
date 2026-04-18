import fs from 'fs';
import path from 'path';
import { log } from './logger.js';

export async function saveSession(context, filePath) {
  const cookies = await context.cookies();
  const storage = await context.storageState();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ cookies, storage }, null, 2));
  log.dim(`Session saved → ${filePath}`);
}

export function sessionExists(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.cookies) && data.cookies.length > 0;
  } catch {
    return false;
  }
}

export function loadStorageState(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw).storage || null;
  } catch {
    return null;
  }
}