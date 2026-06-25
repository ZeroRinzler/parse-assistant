/**
 * Vitest setup for the scripts test suite: point WL_DATA_DIR at a fresh temp dir
 * before any module loads, so storage.ts resolves DATA_DIR to a throwaway path
 * (never the committed data/specs) and tests can read/write freely.
 */

import os from 'os';
import fs from 'fs';
import path from 'path';

if (!process.env['WL_DATA_DIR']) {
  process.env['WL_DATA_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-ingest-test-'));
}
