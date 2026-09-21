// Robust extraction of a JSON object from model output (code fences, prose
// around the JSON, trailing commas).

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function repair(text) {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
}

/** Scan for balanced {...} candidates, respecting strings. */
function candidates(text) {
  const out = [];
  for (let start = text.indexOf('{'); start !== -1 && out.length < 6; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
    if (out.length && out[out.length - 1].length > text.length * 0.5) break;
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * Extract the first JSON object from text.
 * @returns {{ ok: true, value } | { ok: false, error }}
 */
export function extractJson(text) {
  // Reasoning models (Qwen 3.x, DeepSeek-R1, …) often answer inside a
  // <think>…</think> block first. That block routinely contains balanced JSON
  // examples that would otherwise win the candidate scan, so drop it up front.
  const raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!raw) return { ok: false, error: 'The model returned an empty response.' };
  let r = tryParse(raw);
  if (r.ok && r.value && typeof r.value === 'object') return r;
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(raw);
  if (fence) {
    r = tryParse(fence[1].trim());
    if (r.ok) return r;
    r = tryParse(repair(fence[1].trim()));
    if (r.ok) return r;
  }
  for (const c of candidates(raw)) {
    r = tryParse(c);
    if (r.ok) return r;
    r = tryParse(repair(c));
    if (r.ok) return r;
  }
  return { ok: false, error: 'The response did not contain a valid JSON object.' };
}
