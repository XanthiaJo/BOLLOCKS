// Filesystem locations — static assets and runtime upload dirs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../db.js';

export const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
export const CARDS_DIR = path.join(DATA_DIR, 'cards');
fs.mkdirSync(CARDS_DIR, { recursive: true });
export const BG_DIR = path.join(DATA_DIR, 'bg');
fs.mkdirSync(BG_DIR, { recursive: true });
