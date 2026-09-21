// fetch-free HTTP client for AI providers.
//
// Why this exists: Node's global fetch is powered by undici, which enforces a
// hard-wired 300-second headersTimeout/bodyTimeout. Those limits CANNOT be
// raised through fetch options (they need an undici Dispatcher, which is not
// exposed). A local model that needs more than five minutes before its first
// byte — a 16k-token prompt eval on a low-tier PC, or a cold model load —
// died with UND_ERR_HEADERS_TIMEOUT and was misread as "Could not reach
// Ollama", even while Ollama was running perfectly fine.
//
// node:http / node:https have no hidden header or body timeouts. The ONLY
// budget here is the explicit deadline the caller passes (Settings → "AI
// request timeout", default 10 minutes, up to 120), plus honoring an external
// AbortSignal. Long local generations now run as long as the user allows.
import http from 'node:http';
import https from 'node:https';

/** Error thrown when the explicit deadline is reached. */
function timeoutError(timeoutMs) {
  const err = new Error(`The request did not finish within ${Math.round(timeoutMs / 1000)}s`);
  err.code = 'PB_HTTP_TIMEOUT';
  return err;
}

/**
 * Perform one HTTP request and buffer the whole response.
 * Returns { status, ok, headers, text } — mirroring the three facts the
 * provider request() wrappers previously read off a fetch Response.
 * Socket errors are passed through with their codes intact (ECONNREFUSED,
 * ECONNRESET, ENOTFOUND, EHOSTUNREACH, …) so callers can classify them.
 */
export function httpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error(`Unsupported protocol: ${u.protocol}`));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : String(body);
    const outHeaders = { ...headers };
    if (payload !== null && !Object.keys(outHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      outHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const done = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      const err = timeoutError(timeoutMs);
      // destroy() makes the request emit 'error' with our typed error; the
      // explicit fail() call is the belt to those braces.
      try {
        req.destroy(err);
      } catch { /* already gone */ }
      fail(err);
    }, Math.max(1000, Number(timeoutMs) || 60000));

    const req = mod.request(
      u,
      { method: method || 'GET', headers: outHeaders },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          done({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('aborted', () => fail(Object.assign(new Error('The connection was cut off while the response was downloading'), { code: 'ECONNRESET' })));
        res.on('error', (err) => fail(err && err.code ? err : Object.assign(err, { code: 'ECONNRESET' })));
      },
    );
    if (signal) {
      if (signal.aborted) {
        fail(signal.reason || Object.assign(new Error('Aborted'), { code: 'ABORTED' }));
        req.destroy();
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          fail(signal.reason || Object.assign(new Error('Aborted'), { code: 'ABORTED' }));
          try {
            req.destroy();
          } catch { /* already gone */ }
        },
        { once: true },
      );
    }
    req.on('error', (err) => fail(err));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** True when the error is our deadline (as opposed to a socket failure). */
export function isTimeoutError(err) {
  return Boolean(err) && (err.code === 'PB_HTTP_TIMEOUT' || (err.cause && err.cause.code === 'PB_HTTP_TIMEOUT'));
}
