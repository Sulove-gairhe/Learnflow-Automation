import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';

const logFile = path.join(
  config.paths.logs,
  `poster-${new Date().toISOString().split('T')[0]}.log`
);

function write(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}

export const log = {
  info:    (m) => { console.log(chalk.cyan('ℹ'), m);             write('INFO',    m); },

  success: (m) => { console.log(chalk.green('✔'), m);            write('SUCCESS', m); },

  warn:    (m) => { console.log(chalk.yellow('⚠'), m);           write('WARN',    m); },

  error:   (m) => { console.log(chalk.red('✖'), m);              write('ERROR',   m); },

  step:    (m) => { console.log(chalk.magenta('→'), chalk.bold(m)); write('STEP', m); },
  
  dim:     (m) => { console.log(chalk.dim(m));                    write('DEBUG',   m); },
};