// JSON-file document store. One file per document, cached in memory,
// written atomically (temp file + rename) so a crash never leaves half a file.
import fs from 'node:fs';
import path from 'node:path';
import { deepClone } from './util.js';

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  // Write + fsync the temp file so a crash never leaves a truncated document.
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch { /* some filesystems refuse fsync; the rename is still atomic */ }
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows can briefly lock files (antivirus, indexer). Retry, then fall back.
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt === 4) {
        try {
          fs.writeFileSync(file, text, 'utf8');
          fs.rmSync(tmp, { force: true });
          return;
        } catch {
          throw err;
        }
      }
      const until = Date.now() + 25 * (attempt + 1);
      while (Date.now() < until) { /* brief spin; files are small */ }
    }
  }
}

export class Collection {
  constructor(dir) {
    this.dir = dir;
    this.docs = new Map();
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (doc && doc.id) this.docs.set(doc.id, doc);
      } catch (err) {
        console.warn(`[store] Skipping unreadable file ${file}: ${err.message}`);
      }
    }
  }

  fileFor(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid document id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  get(id) {
    const doc = this.docs.get(id);
    return doc ? deepClone(doc) : null;
  }

  /** Direct (uncloned) access for hot paths that do not mutate. */
  peek(id) {
    return this.docs.get(id) || null;
  }

  has(id) {
    return this.docs.has(id);
  }

  list(filter) {
    const out = [];
    for (const doc of this.docs.values()) {
      if (!filter || filter(doc)) out.push(deepClone(doc));
    }
    return out;
  }

  count(filter) {
    let n = 0;
    for (const doc of this.docs.values()) if (!filter || filter(doc)) n++;
    return n;
  }

  put(doc) {
    if (!doc || !doc.id) throw new Error('Document requires an id.');
    const copy = deepClone(doc);
    writeFileAtomic(this.fileFor(doc.id), JSON.stringify(copy, null, 2));
    this.docs.set(doc.id, copy);
    this.notify('onPut', copy);
    return deepClone(copy);
  }

  /** Observers (the playbook workspaces) never break a write. */
  notify(hook, doc) {
    if (typeof this[hook] !== 'function') return;
    try {
      this[hook](doc);
    } catch (err) {
      console.warn(`[store] ${hook} observer failed: ${err.message}`);
    }
  }

  /** Iterate without cloning (read-only callers). */
  forEachRaw(fn) {
    for (const doc of this.docs.values()) fn(doc);
  }

  /** Read-modify-write helper. `fn` receives a copy and returns the updated doc (or mutates it). */
  update(id, fn) {
    const current = this.get(id);
    if (!current) return null;
    const next = fn(current) || current;
    return this.put(next);
  }

  delete(id) {
    const doc = this.docs.get(id);
    this.docs.delete(id);
    if (doc) this.notify('onDelete', doc);
    try {
      fs.rmSync(this.fileFor(id), { force: true });
    } catch { /* ignore */ }
  }
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.playbooks = new Collection(path.join(dataDir, 'playbooks'));
    this.sessions = new Collection(path.join(dataDir, 'discovery-sessions'));
    this.testRuns = new Collection(path.join(dataDir, 'test-runs'));
    this.runs = new Collection(path.join(dataDir, 'runs'));
    this.connections = new Collection(path.join(dataDir, 'connections'));
    this.metaFile = path.join(dataDir, 'settings.json');
  }

  readSettings() {
    try {
      return JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
    } catch {
      return null;
    }
  }

  writeSettings(value) {
    writeFileAtomic(this.metaFile, JSON.stringify(value, null, 2));
  }
}
