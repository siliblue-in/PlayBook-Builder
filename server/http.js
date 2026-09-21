// Minimal HTTP toolkit: router, JSON bodies, static files, uniform errors.
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found.`);
export const badRequest = (message, details) => new HttpError(400, 'bad_request', message, details);
export const conflict = (message, details) => new HttpError(409, 'conflict', message, details);
export const forbidden = (code, message, details) => new HttpError(403, code, message, details);

/** A raw (non-JSON) response returned by a handler. */
export function raw(body, { status = 200, contentType = 'text/plain; charset=utf-8', headers = {} } = {}) {
  return { __raw: true, status, body, headers: { 'Content-Type': contentType, ...headers } };
}

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, handler, options = {}) => {
    const keys = [];
    const source = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    routes.push({ method, regex: new RegExp('^' + source + '/?$'), keys, handler, bodyLimit: options.bodyLimit });
  };
  function match(method, pathname) {
    let pathMatched = false;
    let hadBadParam = false;
    for (const r of routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      let badParam = false;
      r.keys.forEach((k, i) => {
        // Malformed percent-encoding (…/%zz) must be a 404, not a 500.
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          badParam = true;
        }
      });
      if (badParam) {
        hadBadParam = true;
        continue;
      }
      return { handler: r.handler, params, bodyLimit: r.bodyLimit };
    }
    if (hadBadParam) return null;
    return pathMatched ? { methodNotAllowed: true } : null;
  }
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    match,
  };
}

export function readJsonBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > limitBytes) {
        // Drain the rest of the body instead of destroying the socket, so the
        // 413 response can still be written and delivered to the client.
        chunks.length = 0;
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.resume();
        finish(reject, new HttpError(413, 'payload_too_large', 'Request body is too large.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      if (!chunks.length) return finish(resolve, {});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return finish(resolve, {});
      try {
        finish(resolve, JSON.parse(text));
      } catch {
        finish(reject, new HttpError(400, 'invalid_json', 'Request body is not valid JSON.'));
      }
    });
    req.on('error', (err) => finish(reject, err));
  });
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** Serve a file from `root` for the URL path, guarding against traversal. Returns true if served. */
export function serveStatic(req, res, root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  if (rel.includes('\0')) return false;
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(path.normalize(root + path.sep)) && full !== path.normalize(root)) return false;
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  // A file that disappears or locks between statSync and the open (a race that
  // really happens on Windows with antivirus/indexers) must not crash the
  // process with an unhandled stream error.
  const stream = fs.createReadStream(full);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      res.end('Not found');
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
  return true;
}

export function errorBody(err) {
  return {
    response_type: 'error',
    status: 'error',
    error: {
      code: err.code || 'internal_error',
      message: err.message || 'Unexpected error.',
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
}
