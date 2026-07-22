/**
 * Dumb file store over frontend/public/data for the ingest app - the one process with
 * filesystem access. All ingestion logic (signatures, versioning, ordering, transforms)
 * lives in the Angular app; this server must never grow any.
 *
 * REST surface: a file is /api/data/{path} (GET/PUT/DELETE), a directory listing is
 * /api/dirs/{path} (GET). PUT bodies are stored verbatim - the Angular HttpClient
 * already serializes minified JSON, so the server never parses the payload.
 */
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = 3000;
const DATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/data');
// Position payloads reach tens of MB; express's default 100kb body cap would reject them.
const BODY_LIMIT = '200mb';

// The ingest app (ng serve) is the only legitimate caller; a wildcard origin would let any
// site open in the dev's browser drive this unauthenticated, write-capable store.
const ALLOWED_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];
// Reject any other Host so a rebound DNS name resolving to loopback cannot reach the store.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

// Monotonic suffix so two concurrent writes to the same path never collide on the temp name.
let tempWriteCounter = 0;

// A crafted path must never read or write outside the data root.
function resolveContained(segments) {
  const relPath = (segments ?? []).join('/');
  if (relPath.length === 0) return null;
  const full = path.resolve(DATA_ROOT, relPath);
  if (full !== DATA_ROOT && !full.startsWith(DATA_ROOT + path.sep)) return null;
  return full;
}

const app = express();
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return res.status(403).end();
  next();
});
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.text({ type: 'application/json', limit: BODY_LIMIT }));

app.put('/api/data/*path', async (req, res) => {
  const full = resolveContained(req.params.path);
  if (!full || typeof req.body !== 'string' || req.body.length === 0) {
    return res.status(400).json({ error: 'a contained path and a JSON body are required' });
  }
  try {
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    // Temp-then-rename so a kill mid-write leaves the previous complete file.
    const tmp = `${full}.${process.pid}.${tempWriteCounter++}.tmp`;
    try {
      await fs.promises.writeFile(tmp, req.body + '\n');
      await fs.promises.rename(tmp, full);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/data/*path', async (req, res) => {
  const full = resolveContained(req.params.path);
  if (!full) return res.status(400).json({ error: 'a contained path is required' });
  try {
    const content = await fs.promises.readFile(full, 'utf8');
    res.type('application/json').send(content);
  } catch (err) {
    // An exact 404 is the contract: the transport maps it to the `missing` load state.
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: String(err) });
  }
});

app.delete('/api/data/*path', async (req, res) => {
  const full = resolveContained(req.params.path);
  if (!full) return res.status(400).json({ error: 'a contained path is required' });
  try {
    await fs.promises.rm(full, { force: true });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/dirs/*path', async (req, res) => {
  const full = resolveContained(req.params.path);
  if (!full) return res.status(400).json({ error: 'a contained path is required' });
  try {
    res.json((await fs.promises.readdir(full)).sort());
  } catch (err) {
    // An absent directory is a legitimate empty listing (first run of a spec).
    if (err.code === 'ENOENT') return res.json([]);
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[ingest-server] file store for ${DATA_ROOT} listening on http://localhost:${PORT}`);
});
