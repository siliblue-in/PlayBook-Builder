// AI Connections (spec §50–§51): connect a local server or a cloud API —
// Anthropic (native Messages API), OpenRouter, NVIDIA NIM, AMD Developer
// Cloud, Google AI (Gemini), Groq, Together, DeepInfra, Fireworks, Mistral,
// Cerebras, xAI, GitHub Models or any custom OpenAI-compatible endpoint. Keys
// are encrypted locally and never shown again.
import { api } from '../api.js';
import { h, icon, clear, pageHead, card, button, badge, banner, kv, modal, toast, errorMessage, confirmDialog, when, empty } from '../ui.js';
import { localStatusCard } from '../components/local-setup.js';

function perMillion(p) {
  if (!p) return 'free';
  const v = p * 1e6;
  return `$${v < 0.1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(0)}`;
}

/** Add Connection → Local AI or a cloud API aggregator (spec v2 §2). */
function addChooser(onDone, { locals = [], clouds = [], localOnly = false } = {}) {
  const choice = (mark, title, text, action, kind) =>
    h('button', { class: 'choice-card', type: 'button', onClick: action }, h('span', { class: 'choice-mark' }, mark), h('span', null, h('span', { class: 'choice-title' }, title, kind ? badge('', kind, 'outline') : null), h('span', { class: 'choice-text' }, text)), icon('chevronRight'));
  const cloudNames = clouds.map((c) => c.label).slice(0, 6).join(' · ');
  const m = modal({
    title: 'Add AI connection',
    body: h(
      'div',
      { class: 'stack' },
      choice('🦙', 'Local AI', `Run models on this computer with ${locals.map((l) => l.label).slice(0, 3).join(', ')}. Free, private, no API key.`, () => {
        m.close();
        location.hash = '#/connections/local';
      }, 'Recommended for privacy'),
      localOnly
        ? h('div', { class: 'small muted' }, 'Privacy Mode is set to Local Only, so cloud providers cannot be added. Change it in Settings to use a cloud provider.')
        : choice('☁️', 'Cloud API key', `One key from an API aggregator: ${cloudNames}${clouds.length > 6 ? ` · +${clouds.length - 6} more` : ''}.`, () => {
            m.close();
            cloudDialog(onDone, clouds);
          }),
    ),
    actions: [{ label: 'Cancel', onClick: (c) => c() }],
  });
}

function cloudDialog(onDone, clouds) {
  const list = clouds.length ? clouds : [];
  const presetOf = (id) => list.find((p) => p.id === id) || list[0];
  let current = presetOf(list[0] && list[0].id);

  const provider = h('select', { class: 'input' }, list.map((p) => h('option', { value: p.id, selected: p.id === current.id }, p.label)));
  const name = h('input', { class: 'input', value: current.label });
  const keyLabel = h('label', null, 'API key');
  const key = h('input', { class: 'input', type: 'password', placeholder: current.key_hint || 'API key', autocomplete: 'off', spellcheck: 'false' });
  const show = button('', { ic: 'eye', size: 'sm', title: 'Show / hide key', onClick: () => (key.type = key.type === 'password' ? 'text' : 'password') });
  const baseUrl = h('input', { class: 'input', value: (current.defaults && current.defaults.base_url) || '', placeholder: 'https://…/v1', spellcheck: 'false' });
  const presetInfo = h('div', { class: 'small text-2' });
  const keyHelp = h('div', { class: 'help' });
  const urlHelp = h('div', { class: 'help' });
  const status = h('div', { class: 'small' });

  const paintPreset = () => {
    const p = current;
    name.value = name.value && name.dataset.touched ? name.value : p.label;
    keyLabel.textContent = p.allow_no_key ? 'API key (optional)' : 'API key';
    key.placeholder = p.key_hint || 'API key';
    baseUrl.value = (p.defaults && p.defaults.base_url) || '';
    clear(presetInfo).append(p.description || '');
    clear(keyHelp);
    if (p.docs_url) keyHelp.append('Create a key at ', h('a', { href: p.docs_url, target: '_blank', rel: 'noopener' }, p.docs_url.replace(/^https?:\/\//, '')), '. ');
    keyHelp.append(p.allow_no_key ? 'The key is optional for this endpoint.' : 'It is encrypted on this computer and only a masked form is ever shown.');
    clear(urlHelp).append(p.requires_base_url ? 'Required — the OpenAI-compatible base URL of the service (it usually ends in /v1).' : 'Pre-filled from the provider. Change it only for a custom gateway or proxy.');
    if (p.note) urlHelp.append(' ', h('span', { class: 'muted' }, p.note));
  };
  paintPreset();

  provider.addEventListener('change', () => {
    current = presetOf(provider.value);
    name.value = current.label;
    name.dataset.touched = '';
    key.value = '';
    paintPreset();
  });
  name.addEventListener('input', () => (name.dataset.touched = '1'));

  modal({
    title: 'Add cloud API connection',
    body: h(
      'div',
      null,
      h('div', { class: 'field' }, h('label', null, 'Provider'), provider, h('div', { class: 'help mt-1' }, presetInfo)),
      h('div', { class: 'field mt-3' }, h('label', null, 'Connection name'), name),
      h('div', { class: 'field' }, keyLabel, h('div', { class: 'row nowrap' }, key, show), keyHelp),
      h('div', { class: 'field' }, h('label', null, 'Service base URL'), baseUrl, urlHelp),
      status,
    ),
    actions: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: 'Save & test',
        kind: 'primary',
        icon: 'check',
        onClick: async (close) => {
          if (!key.value.trim() && !current.allow_no_key) {
            key.focus();
            return;
          }
          if (!baseUrl.value.trim()) {
            baseUrl.focus();
            return;
          }
          status.replaceChildren(h('span', { class: 'row' }, h('span', { class: 'spinner' }), `Saving and testing the ${current.label} key…`));
          let conn;
          let created = null;
          try {
            // Pressing "Save & test" again after a failed test must re-test the
            // connection that was already created, not create a second one.
            conn = created || (await api.post('/api/connections', { provider: current.id, name: name.value, api_key: key.value.trim(), base_url: baseUrl.value.trim() }));
            created = conn;
            conn = await api.post(`/api/connections/${conn.id}/test`);
          } catch (err) {
            status.replaceChildren(h('span', { style: { color: 'var(--fail)' } }, errorMessage(err)));
            return;
          }
          if (conn.status !== 'ok') {
            status.replaceChildren(h('span', { style: { color: 'var(--fail)' } }, `Saved, but the test failed: ${conn.last_error}`, h('div', { class: 'xsmall muted mt-1' }, 'Press “Save & test” to try the key again, or Cancel to keep it.')));
            onDone();
            return;
          }
          status.replaceChildren(h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Key works. Loading models…'));
          try {
            await api.get(`/api/connections/${conn.id}/models`);
          } catch { /* models can be loaded later */ }
          close();
          toast(`Connected to ${current.label} — now choose a model for each role`);
          onDone();
        },
      },
    ],
  });
}

function connectionCard(c, roles, app, refresh) {
  const inputs = {};
  const infoLines = {};
  let models = [];
  const dl = h('datalist', { id: `models-${c.id}` });
  const modelsState = h('div', { class: 'small muted' }, c.models_cached ? `${c.models_cached} models loaded ${c.models_fetched_at ? when(c.models_fetched_at) : ''}` : 'Models not loaded yet');

  const describe = (role) => {
    const m = models.find((x) => x.id === inputs[role].value.trim());
    const price = m && (m.pricing.prompt > 0 || m.pricing.completion > 0) ? ` · ${perMillion(m.pricing.prompt)} / M in · ${perMillion(m.pricing.completion)} / M out` : '';
    infoLines[role].textContent = !inputs[role].value.trim() ? 'Not selected' : m ? `${m.name} · ${m.context_length ? `${Math.round(m.context_length / 1000)}k context` : 'context not reported'}${price}${m.supports.tools ? ' · tools' : ''}${m.supports.json ? ' · JSON mode' : ''}` : models.length ? 'Not in the loaded model list' : '';
    infoLines[role].style.color = inputs[role].value.trim() && models.length && !m ? 'var(--warn)' : '';
  };

  const loadModels = async (refreshList) => {
    modelsState.replaceChildren(h('span', { class: 'row' }, h('span', { class: 'spinner' }), 'Loading models…'));
    try {
      const r = await api.get(`/api/connections/${c.id}/models${refreshList ? '?refresh=1' : ''}`);
      models = r.models;
      clear(dl).append(...models.map((m) => h('option', { value: m.id }, m.pricing.prompt > 0 || m.pricing.completion > 0 ? `${m.name} · ${perMillion(m.pricing.prompt)}/M in` : m.name)));
      modelsState.textContent = `${models.length} models available`;
      for (const role of roles) describe(role.id);
    } catch (err) {
      modelsState.replaceChildren(h('span', { style: { color: 'var(--fail)' } }, errorMessage(err)));
    }
  };

  const roleRows = roles.map((r) => {
    inputs[r.id] = h('input', { class: 'input sm', list: `models-${c.id}`, value: (c.models && c.models[r.id]) || '', placeholder: 'Type to search models, e.g. openai/gpt-4o-mini', spellcheck: 'false' });
    infoLines[r.id] = h('div', { class: 'xsmall muted mt-1' });
    inputs[r.id].addEventListener('input', () => describe(r.id));
    const help = {
      clarification: 'Asks the short discovery questions.',
      generation: 'Compiles the playbook JSON — use your strongest model.',
      execution: 'Runs playbooks in AI Execution mode.',
      testing: 'Runs AI Execution tests and writes AI test cases.',
      evaluation: 'Scores task alignment and suggests repairs.',
    }[r.id];
    return h('div', { class: 'model-select' }, h('div', null, h('div', { class: 'bold small' }, r.label), h('div', { class: 'xsmall muted' }, help)), h('div', null, inputs[r.id], infoLines[r.id]));
  });

  const allInput = h('input', { class: 'input sm', list: `models-${c.id}`, placeholder: 'Apply one model to every role…', style: { maxWidth: '360px' } });
  const saveModels = button('Save models', {
    kind: 'primary',
    size: 'sm',
    ic: 'check',
    onClick: async () => {
      const m = {};
      for (const r of roles) m[r.id] = inputs[r.id].value.trim() || null;
      try {
        await api.put(`/api/connections/${c.id}`, { models: m });
        toast('Models saved');
        await app.refreshStatus();
        refresh();
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
  });

  const testBtn = button('Test connection', {
    size: 'sm',
    ic: 'refresh',
    onClick: async () => {
      testBtn.disabled = true;
      try {
        const r = await api.post(`/api/connections/${c.id}/test`);
        toast(r.status === 'ok' ? 'Connection OK' : `Test failed: ${r.last_error}`, r.status === 'ok' ? 'ok' : 'error');
        await app.refreshStatus();
        refresh();
      } catch (err) {
        toast(errorMessage(err), 'error');
        testBtn.disabled = false;
      }
    },
  });

  const replaceKey = () => {
    const key = h('input', { class: 'input', type: 'password', placeholder: 'New API key', autocomplete: 'off' });
    modal({
      title: `Replace key · ${c.name}`,
      body: h('div', { class: 'field' }, h('label', null, 'API key'), key),
      actions: [
        { label: 'Cancel', onClick: (x) => x() },
        {
          label: 'Save',
          kind: 'primary',
          onClick: async (close) => {
            try {
              await api.put(`/api/connections/${c.id}`, { api_key: key.value.trim() });
              await api.post(`/api/connections/${c.id}/test`);
              close();
              toast('Key replaced');
              refresh();
            } catch (err) {
              toast(errorMessage(err), 'error');
            }
          },
        },
      ],
    });
  };

  const acct = c.account || {};
  const el = card({
    title: c.name,
    icon: 'plug',
    actions: [badge('', c.provider_label, 'outline'), badge(c.status === 'ok' ? 'ok' : c.status === 'error' ? 'error' : 'untested', c.status === 'ok' ? 'Connected' : c.status === 'error' ? 'Error' : 'Untested'), c.allowed === false ? badge('fail', 'Blocked by Privacy Mode') : null, c.is_default ? badge('', 'Default', 'accent') : null].filter(Boolean),
    body: h(
      'div',
      null,
      c.allowed === false ? banner('warn', 'Blocked by Privacy Mode', 'Privacy Mode is set to Local Only, so this cloud connection cannot be used or tested. Change it in Settings → Privacy.') : null,
      c.status === 'error' ? banner('fail', 'Connection test failed', c.last_error) : null,
      h(
        'div',
        { class: 'grid two' },
        kv([
          ['Connection ID', h('code', { class: 'inline' }, c.id)],
          ['API key', h('code', { class: 'inline' }, c.api_key_masked)],
          ['Last tested', c.last_tested_at ? when(c.last_tested_at) : 'Never'],
        ]),
        kv([
          ['Key label', acct.label || '—'],
          ['Credit limit', acct.limit === null || acct.limit === undefined ? 'No limit' : `$${acct.limit}`],
          ['Remaining', acct.limit_remaining === null || acct.limit_remaining === undefined ? '—' : `$${Number(acct.limit_remaining).toFixed(2)}`],
        ]),
      ),
      h('div', { class: 'row mt-2' }, testBtn, button('Load models', { size: 'sm', ic: 'download', onClick: () => loadModels(true) }), button('Replace key', { size: 'sm', ic: 'key', onClick: replaceKey }), c.is_default ? null : button('Make default', { size: 'sm', onClick: async () => { await api.put(`/api/connections/${c.id}`, { is_default: true }); await app.refreshStatus(); refresh(); } }), h('span', { class: 'spacer' }), button('Delete', { size: 'sm', kind: 'danger', ic: 'trash', onClick: async () => { if (!(await confirmDialog({ title: `Delete ${c.name}?`, text: 'The encrypted key is removed from this computer. Playbooks that reference this connection fall back to the default connection.', confirm: 'Delete', danger: true }))) return; await api.del(`/api/connections/${c.id}`); toast('Connection deleted'); await app.refreshStatus(); refresh(); } })),
      h('hr', { class: 'sep' }),
      h('div', { class: 'row between' }, h('div', null, h('div', { class: 'bold' }, 'Models per role'), modelsState), h('div', { class: 'row nowrap' }, allInput, button('Apply to all', { size: 'sm', onClick: () => { if (!allInput.value.trim()) return; for (const r of roles) { inputs[r.id].value = allInput.value.trim(); describe(r.id); } } }))),
      dl,
      h('div', { class: 'mt-2' }, roleRows),
      h('div', { class: 'row mt-2', style: { justifyContent: 'flex-end' } }, saveModels),
    ),
  });
  for (const r of roles) describe(r.id);
  if (c.models_cached || c.status === 'ok') loadModels(false);
  return el;
}

/** A local connection shows its server, model and status (spec v2 §15). */
function localCard(c, roles, app, refresh) {
  let busy = false;
  const wrap = h('div');
  const paintCard = () => {
    clear(wrap).append(
      localStatusCard(c, {
        busy,
        onTest: async () => {
          busy = true;
          paintCard();
          try {
            const r = await api.post(`/api/connections/${c.id}/test`, {});
            toast(r.state === 'connected' ? 'Connection OK' : `Test failed: ${r.last_error}`, r.state === 'connected' ? 'ok' : 'error');
            await app.refreshStatus();
            refresh();
          } catch (err) {
            toast(errorMessage(err), 'error');
            busy = false;
            paintCard();
          }
        },
        onChange: () => {
          location.hash = `#/connections/local?provider=${c.provider}&id=${c.id}`;
        },
        onDisconnect: async () => {
          if (!(await confirmDialog({ title: `Disconnect ${c.name}?`, text: 'The connection is removed from Playbook Builder. Nothing is uninstalled and no model is deleted.', confirm: 'Disconnect', danger: true }))) return;
          await api.del(`/api/connections/${c.id}`);
          await app.refreshStatus();
          toast('Disconnected');
          refresh();
        },
      }),
    );
    const roleLines = roles.map((r) => h('div', null, h('span', null, r.label), h('code', { class: 'inline' }, (c.models && c.models[r.id]) || c.default_model || '—')));
    wrap.firstChild.querySelector('.card-body').append(h('hr', { class: 'sep' }), h('div', { class: 'row between mb-1' }, h('div', { class: 'bold small' }, 'Models per role'), c.is_default ? badge('', 'Used by new playbooks', 'outline') : button('Make default', { size: 'sm', onClick: async () => { await api.put(`/api/connections/${c.id}`, { is_default: true }); await app.refreshStatus(); refresh(); } })), h('div', { class: 'kv-lines' }, roleLines));
  };
  paintCard();
  return wrap;
}

export async function render(el, { app }) {
  const host = h('div');
  const locals = (app.meta.providers || []).filter((p) => p.type === 'local');
  const clouds = (app.meta.providers || []).filter((p) => p.type === 'cloud');
  let localOnly = false;
  el.append(
    pageHead({
      title: 'AI Connections',
      subtitle: 'Connect providers here — no .env files. Local models need no key at all; cloud keys are encrypted on this computer and referenced by connection_id.',
      actions: [button('Add Connection', { kind: 'primary', ic: 'plus', onClick: () => addChooser(paint, { locals, clouds, localOnly }) })],
    }),
    host,
  );
  async function paint() {
    const data = await api.get('/api/connections');
    localOnly = data.status.privacy_mode === 'local_only';
    clear(host);
    if (localOnly) host.append(banner('info', 'Privacy Mode: Local Only', 'Only local models can be used. Cloud connections are blocked until Privacy Mode changes in Settings.'));
    if (data.status.privacy_mode === 'local_preferred') host.append(banner('info', 'Privacy Mode: Local Preferred', 'A working local connection is used before any cloud connection.'));
    if (!data.connections.length) {
      host.append(
        card({
          body: empty(
            'plug',
            'No AI connection yet',
            'Connect a model to enable intent discovery, playbook generation, AI execution, AI tests and AI evaluation. Deterministic testing and the built-in example work without one.',
            h('div', { class: 'row', style: { justifyContent: 'center' } }, button('Connect Local AI (Ollama)', { kind: 'primary', ic: 'cpu', href: '#/connections/local' }), localOnly ? null : button('Add a cloud provider', { ic: 'key', onClick: () => cloudDialog(paint, clouds) })),
          ),
        }),
      );
      return;
    }
    host.append(h('div', { class: 'stack' }, data.connections.map((c) => (c.is_local ? localCard(c, data.roles, app, paint) : connectionCard(c, data.roles, app, paint)))));
    host.append(h('div', { class: 'small muted mt-3' }, 'Every provider is implemented behind the AIProvider interface — Anthropic through its native Messages API, OpenRouter, NVIDIA NIM, AMD, Google, Groq and the other OpenAI-compatible aggregators in the cloud, Ollama and OpenAI-compatible servers locally — so playbooks never change when you switch.'));
  }
  await paint();
}
