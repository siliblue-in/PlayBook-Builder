// PC Performance Tiers for Local LLMs (release line v1.1).
//
// One question every local user must answer is "how much can this computer
// take?" — context window, test-suite size and wait time all follow from the
// hardware. Instead of guessing, the Local AI connection stores a tier:
//
//   low    — CPU-only or tiny GPU; small models; generation finishes slowly
//   medium — 6–8 GB GPU; 7–9B models; the balanced default
//   high   — 12 GB+ GPU; large models; the fastest, fullest runs
//
// The tier does three things:
//   1. suggests a context window (num_ctx) on the connection form,
//   2. caps how many AI test cases one generation may write,
//   3. documents the hardware requirements and the trade-offs right in the UI.
// "Custom" (no tier) keeps the old behaviour: no test cap, context window set
// by hand.
export const PC_TIERS = {
  low: {
    id: 'low',
    label: 'Low-Tier PC',
    context_window: 4096,
    test_cases: 4,
    requirements: {
      gpu: 'No GPU needed (CPU-only works) or a small GPU with up to 4 GB VRAM',
      ram: 'Minimum 8 GB RAM (16 GB recommended)',
      model: 'Small models: 1–4B parameters at Q4 (e.g. llama3.2:3b, qwen3.5:2b–4b)',
      disk: 'About 2–5 GB free disk for a model',
    },
    expect: 'Slow: roughly 3–25 minutes per AI step on CPU, or 30–90 seconds on a small GPU. Keep the PC plugged in and idle while it works.',
    tradeoffs: 'Fewer test cases (up to 4) and a 4096-token context window. Playbooks must be shorter and simpler, and each run covers less ground — the point is that generation actually finishes instead of timing out. Close other heavy apps; if `ollama ps` shows the model spilling out of VRAM, step down to an even smaller model.',
    tips: 'Leave the AI request timeout at 10 minutes or higher. Turn thinking/reasoning off (Playbook Builder does this automatically). Consider the smaller model first — a 2B model that finishes beats a 9B model that times out.',
  },
  medium: {
    id: 'medium',
    label: 'Mid-Range PC',
    context_window: 8192,
    test_cases: 8,
    requirements: {
      gpu: 'Gaming or workstation GPU with 6–8 GB VRAM (e.g. RTX 3050/3060/4060), or Apple silicon with 16 GB unified memory',
      ram: 'Minimum 16 GB RAM',
      model: 'Mid-size models: 7–9B parameters at Q4 (e.g. qwen3.5:8b, llama3.1:8b)',
      disk: 'About 5–8 GB free disk for a model',
    },
    expect: 'Roughly 1–4 minutes per AI step with the model fully in VRAM.',
    tradeoffs: 'Balanced coverage: up to 8 test cases and an 8192-token context window. Pushing to a larger model or a much bigger context can spill out of VRAM — everything then slows to CPU speed. Check `ollama ps` shows about 100% GPU for the model.',
    tips: 'This tier fits most laptops with a dedicated GPU. Keep the context window at 8k–16k; if a stage regularly takes longer than 5 minutes, the model is probably not fitting in VRAM.',
  },
  high: {
    id: 'high',
    label: 'High-End PC',
    context_window: 16384,
    test_cases: 16,
    requirements: {
      gpu: 'GPU with 12–24 GB+ VRAM (e.g. RTX 3080/4070 Ti/4080 or better), or Apple silicon with 24 GB+ unified memory',
      ram: 'Minimum 32 GB RAM recommended',
      model: 'Large instruct models: 9–14B+ parameters at Q4/Q5, or separate models per role',
      disk: 'About 8–20 GB free disk for models',
    },
    expect: 'Fast: seconds to about 2 minutes per AI step, with a 16384-token context window or larger.',
    tradeoffs: 'Best coverage: up to 16 test cases and 16k+ context. Very large context windows raise memory use sharply on some models — if the PC starts swapping or the fan never settles, step down one tier rather than fighting it.',
    tips: 'Ideal for 9B–14B models like qwen3.5:9b at 16k context. If you raise num_ctx above the model default, make sure the model actually supports it (`ollama show <model>`).',
  },
};

/** Test-case caps per tier — "how many test cases it will run". */
export const TIER_TEST_CAPS = { low: 4, medium: 8, high: 16 };

/** Accept only the three known tiers; anything else means "Custom / no cap". */
export function normalizeTier(v) {
  const s = String(v || '').toLowerCase();
  return PC_TIERS[s] ? s : null;
}

/** Tier id stored on a connection (null = Custom). */
export function tierOf(connection) {
  return normalizeTier(connection && connection.tier);
}

/** How many AI test cases the tier allows (null = uncapped). */
export function tierTestCap(tier) {
  const t = normalizeTier(tier);
  return t ? TIER_TEST_CAPS[t] : null;
}

/** Client-facing tier catalog (meta.tiers) — the UI renders requirements from it. */
export function tierCatalog() {
  return Object.values(PC_TIERS).map((t) => ({ ...t }));
}
