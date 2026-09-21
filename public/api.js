// Thin API client. Errors carry the server's { code, message, details }.

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the Playbook Builder server. Is it still running?');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const e = data && data.error ? data.error : { code: 'http_error', message: `Request failed (${res.status}).` };
    throw new ApiError(res.status, e.code, e.message, e.details);
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
  text: (url) => request('GET', url),
};

/**
 * Poll `fn` until `done(result)` is true. Returns a stop() function.
 * Transient errors (laptop sleep, a Wi-Fi blip, one busy 5xx) retry with a
 * growing delay; `onError` only fires after several consecutive failures.
 */
export function poll(fn, { interval = 800, done, onUpdate, onError, maxErrors = 5 } = {}) {
  let stopped = false;
  let timer = null;
  let failures = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      const r = await fn();
      if (stopped) return;
      failures = 0;
      if (onUpdate) onUpdate(r);
      if (done && done(r)) return;
    } catch (err) {
      if (stopped) return;
      failures += 1;
      if (failures < maxErrors) {
        timer = setTimeout(tick, Math.min(interval * failures * 2, 5000));
        return;
      }
      if (onError) onError(err);
      return;
    }
    timer = setTimeout(tick, interval);
  };
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
