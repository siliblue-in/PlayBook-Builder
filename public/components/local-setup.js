// Local AI building blocks (feature spec v2 §23). Everything here is driven by
// the provider's own `setup` block from /api/meta, so adding another local
// adapter on the server adds its setup box here for free.
import { h, icon, button, badge, card, copyText, toast } from '../ui.js';

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];

/** A copyable command line (§6). */
export function copyCommand(command, { label = null, size = '' } = {}) {
  if (!command) return null;
  const btn = button('Copy', {
    size: 'sm',
    ic: 'copy',
    onClick: async () => {
      await copyText(command, 'Copied');
      btn.replaceChildren(icon('check'), document.createTextNode('Copied'));
      setTimeout(() => btn.replaceChildren(icon('copy'), document.createTextNode('Copy')), 1800);
    },
  });
  return h('div', { class: `cmd-row ${size}` }, label ? h('div', { class: 'cmd-label' }, label) : null, h('code', { class: 'cmd' }, command), btn);
}

/** ▸ Need detailed instructions? (§5) */
export function detailedInstructions(setup, { open = false, summary = 'Need detailed instructions?' } = {}) {
  const body = h(
    'div',
    { class: 'setup-detail' },
    (setup.detailed || []).map((s) =>
      h(
        'div',
        { class: 'setup-detail-step' },
        h('div', { class: 'bold small' }, s.title),
        h('div', { class: 'small text-2' }, s.body),
        s.command ? copyCommand(s.command, { size: 'sm' }) : null,
        s.link ? h('a', { class: 'small', href: s.link, target: '_blank', rel: 'noopener' }, s.link_label || s.link, icon('external')) : null,
      ),
    ),
  );
  const det = h('details', { class: 'setup-more' }, h('summary', null, summary), body);
  if (open) det.open = true;
  return det;
}

/**
 * The compact setup box (§3). Stays visible while detecting; the primary
 * action label changes instead (§4).
 */
export function setupCard(provider, { server, detecting = false, onDetect, onOpen, note = null } = {}) {
  const setup = provider.setup || {};
  const steps = setup.steps || [];
  const shownServer = server || setup.server;
  return h(
    'div',
    { class: 'setup-card' },
    h('div', { class: 'setup-head' }, h('span', { class: 'setup-mark' }, setup.mark || '💻'), h('div', { class: 'setup-title' }, setup.title || `Set up ${provider.label}`)),
    h(
      'ol',
      { class: 'setup-steps' },
      steps.map((s, i) =>
        h(
          'li',
          null,
          h('span', { class: 'setup-num' }, CIRCLED[i] || `${i + 1}.`),
          h('span', null, s),
          setup.command && setup.command_step === i + 1 ? copyCommand(setup.command, { size: 'sm' }) : null,
        ),
      ),
    ),
    setup.hint ? h('div', { class: 'small text-2 mt-1' }, setup.hint) : null,
    note,
    h('div', { class: 'setup-server' }, h('span', { class: 'xsmall muted' }, 'Server'), h('code', { class: 'inline' }, shownServer)),
    h(
      'div',
      { class: 'setup-actions' },
      setup.install_url ? button(`Open ${provider.label}`, { ic: 'external', onClick: onOpen }) : null,
      button(detecting ? 'Detecting models…' : 'Detect Models', { kind: 'primary', ic: detecting ? null : 'search', disabled: detecting, onClick: onDetect }),
    ),
    detailedInstructions(setup),
  );
}

/** ✓ Connected (§4). */
export function connectedCard({ provider, server, model, roles = null, onTest, onChange, testing = false }) {
  return h(
    'div',
    { class: 'setup-card ok' },
    h('div', { class: 'setup-head' }, h('span', { class: 'setup-mark' }, icon('circleCheck')), h('div', { class: 'setup-title' }, `${provider} Connected`)),
    h('div', { class: 'kv-lines' }, h('div', null, h('span', null, 'Server'), h('code', { class: 'inline' }, server)), h('div', null, h('span', null, 'Model'), h('code', { class: 'inline' }, model || '—'))),
    roles,
    h('div', { class: 'small mt-1' }, 'Local AI is ready.'),
    h('div', { class: 'setup-actions' }, button(testing ? 'Testing…' : 'Test AI', { ic: 'zap', disabled: testing, onClick: onTest }), button('Change Model', { ic: 'refresh', onClick: onChange })),
  );
}

/** ⚠ Can't connect (§4, §16). */
export function troubleCard({ provider, server, message, command, onRetry, onInstructions, checklist = true }) {
  return h(
    'div',
    { class: 'setup-card bad' },
    h('div', { class: 'setup-head' }, h('span', { class: 'setup-mark' }, icon('alert')), h('div', { class: 'setup-title' }, `Can't connect to ${provider}`)),
    h('div', { class: 'small' }, message || `Check that ${provider} is running and that the server address is correct.`),
    checklist
      ? h(
          'div',
          { class: 'mt-1' },
          h('div', { class: 'xsmall muted' }, 'Check:'),
          h(
            'ul',
            { class: 'check-list small todo' },
            [`${provider} is installed`, `${provider} is running`, 'Server URL is correct', 'At least one model is installed'].map((t) => h('li', null, icon('check'), t)),
          ),
        )
      : null,
    command ? copyCommand(command, { label: 'Model installation', size: 'sm' }) : null,
    h('div', { class: 'setup-server' }, h('span', { class: 'xsmall muted' }, 'Server'), h('code', { class: 'inline' }, server)),
    h('div', { class: 'setup-actions' }, button('Retry', { kind: 'primary', ic: 'refresh', onClick: onRetry }), button('Setup Instructions', { ic: 'book', onClick: onInstructions })),
  );
}

/** Connected but empty (§16). */
export function noModelsCard({ provider, server, command, onDetect }) {
  return h(
    'div',
    { class: 'setup-card warn' },
    h('div', { class: 'setup-head' }, h('span', { class: 'setup-mark' }, icon('info')), h('div', { class: 'setup-title' }, `${provider} is connected, but no models were found`)),
    h('div', { class: 'small' }, 'Install a model, then detect models again.'),
    command ? copyCommand(command, { size: 'sm' }) : null,
    h('div', { class: 'setup-server' }, h('span', { class: 'xsmall muted' }, 'Server'), h('code', { class: 'inline' }, server)),
    h('div', { class: 'setup-actions' }, button('Detect Models', { kind: 'primary', ic: 'search', onClick: onDetect })),
  );
}

const CAP_ICON = { ok: 'circleCheck', fail: 'circleX', warn: 'alert', unknown: 'info' };

/** Model Compatibility (§10). */
export function capabilityCard(report, { onChoose } = {}) {
  const rows = (report.capabilities || []).map((c) =>
    h(
      'div',
      { class: `cap-row ${c.status}` },
      icon(CAP_ICON[c.status] || 'info'),
      h('div', null, h('div', { class: 'bold small' }, c.label, c.required ? null : h('span', { class: 'xsmall muted' }, '  optional')), h('div', { class: 'xsmall text-2' }, c.help)),
      badge('', c.status === 'ok' ? 'Supported' : c.status === 'fail' ? 'Missing' : c.status === 'warn' ? 'Not reported' : 'Unknown', c.status === 'ok' ? 'ok' : c.status === 'fail' ? 'fail' : 'outline'),
    ),
  );
  return card({
    title: 'Model Compatibility',
    icon: 'cpu',
    actions: [report.context_length ? badge('', `${Math.round(report.context_length / 1000)}k context`, 'outline') : null, report.details && report.details.parameter_size ? badge('', report.details.parameter_size, 'outline') : null].filter(Boolean),
    body: h(
      'div',
      null,
      h('div', { class: 'row between mb-1' }, h('code', { class: 'inline' }, report.model), report.ready ? badge('pass', 'Ready') : badge('fail', 'Not usable')),
      rows,
      report.ready
        ? null
        : h(
            'div',
            { class: 'banner fail mt-2' },
            icon('alert'),
            h('div', { class: 'banner-body' }, h('div', { class: 'banner-title' }, 'This model cannot support this playbook'), h('div', { class: 'small' }, `Missing: ${report.missing.join(', ')}.`), onChoose ? h('div', { class: 'mt-1' }, button('Choose Another Model', { size: 'sm', onClick: onChoose })) : null),
          ),
    ),
  });
}

/** 🟢 Local AI status (§15). */
export function localStatusCard(conn, { onTest, onChange, onDisconnect, busy = false } = {}) {
  const ok = conn.state === 'connected';
  return card({
    title: conn.name,
    icon: 'cpu',
    actions: [badge('', 'Local AI', 'accent'), badge(ok ? 'ok' : conn.state === 'error' ? 'error' : 'untested', ok ? 'Connected' : conn.state === 'error' ? 'Not connected' : 'Untested'), conn.is_default ? badge('', 'Default', 'outline') : null].filter(Boolean),
    body: h(
      'div',
      null,
      h(
        'div',
        { class: 'kv-lines' },
        h('div', null, h('span', null, 'Provider'), h('span', null, conn.provider_label)),
        h('div', null, h('span', null, 'Server'), h('code', { class: 'inline' }, conn.server || conn.base_url)),
        h('div', null, h('span', null, 'Model'), h('code', { class: 'inline' }, conn.default_model || (conn.models && conn.models.generation) || '—')),
        h('div', null, h('span', null, 'Status'), h('span', { class: 'row nowrap' }, h('span', { class: `dot ${ok ? 'ok' : 'err'}` }), ok ? 'Connected' : conn.last_error || 'Not tested')),
      ),
      h('div', { class: 'setup-actions' }, button(busy ? 'Testing…' : 'Test', { ic: 'zap', disabled: busy, onClick: onTest }), button('Change Model', { ic: 'refresh', onClick: onChange }), button('Disconnect', { kind: 'danger', ic: 'ban', onClick: onDisconnect })),
    ),
  });
}

/** The result of a connection test: the four checks from §11. */
export function checkList(checks) {
  if (!checks || !checks.length) return null;
  return h(
    'div',
    { class: 'check-results' },
    checks.map((c) => h('div', { class: `cap-row ${c.status}` }, icon(CAP_ICON[c.status] || 'info'), h('div', null, h('div', { class: 'bold small' }, c.label), h('div', { class: 'xsmall text-2' }, c.detail)))),
  );
}

/** Model list with radio selection (§8–9). */
export function modelPicker(models, selected, onSelect) {
  const name = `model-${Math.random().toString(36).slice(2, 8)}`;
  return h(
    'div',
    { class: 'model-list' },
    models.map((m) => {
      const input = h('input', { type: 'radio', name, value: m.id });
      input.checked = m.id === selected;
      input.addEventListener('change', () => onSelect(m.id));
      const bits = [m.parameter_size, m.quantization, m.context_length ? `${Math.round(m.context_length / 1000)}k context` : null, m.size_bytes ? `${(m.size_bytes / 1e9).toFixed(1)} GB` : null].filter(Boolean);
      return h(
        'label',
        { class: `model-option${m.id === selected ? ' selected' : ''}` },
        input,
        h('div', null, h('div', { class: 'bold small' }, m.name), bits.length ? h('div', { class: 'xsmall muted' }, bits.join(' · ')) : null),
        m.supports && m.supports.tools === true ? badge('', 'tools', 'outline') : null,
      );
    }),
  );
}

export function toastCopied() {
  toast('Copied');
}
