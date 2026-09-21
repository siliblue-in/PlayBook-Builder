// Run detail: status, approvals, output, validation, step trace on the
// workflow graph, logs and cost.
import { api, poll } from '../api.js';
import { h, append, icon, clear, pageHead, card, button, badge, banner, kv, jsonView, when, duration, money, title, toast, errorMessage, copyText } from '../ui.js';
import { workflowGraph } from '../components/graph.js';
import { statusMapFromTrace } from '../components/common.js';

const TL_ICON = { completed: 'check', failed: 'x', skipped: 'skip', awaiting_approval: 'clock', simulated: 'pending', unreported: 'info', running: 'pending' };

export async function render(el, { params, app }) {
  let run = (await api.get(`/api/runs/${params[0]}`)).data.run;
  let pb = null;
  try {
    pb = await api.get(`/api/playbooks/${run.playbook_id}/json?version=${run.version}`);
  } catch { /* playbook deleted */ }
  let stop = null;
  let graph = null;
  const body = h('div');
  el.append(body);

  let deciding = false;
  function approvalCard() {
    const a = run.pending_approval;
    if (!a) return null;
    const note = h('input', { class: 'input', placeholder: 'Note for the audit log (optional)', disabled: deciding });
    const decide = async (decision) => {
      if (deciding) return;
      deciding = true;
      paint();
      try {
        const r = await api.post(`/api/runs/${run.id}/approvals/${a.id}`, { decision, note: note.value });
        run = r.data.run;
        toast(decision === 'approve' ? 'Approved — run resumed' : 'Rejected');
        paint();
        // The decision resolves only after the rest of the run executes, so
        // keep the page live from here on.
        startPoll();
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
      deciding = false;
      paint();
    };
    return h(
      'div',
      { class: 'banner warn' },
      icon('shieldCheck'),
      h(
        'div',
        { class: 'banner-body' },
        h('div', { class: 'banner-title' }, 'Human approval required'),
        h('div', { class: 'small' }, a.reason),
        a.args ? h('div', { class: 'mt-1' }, jsonView(a.args, { cls: 'inline' })) : null,
        h('div', { class: 'small text-2 mt-1' }, run.environment === 'production' ? (run.policy.production_actions ? 'Approving performs the external action for real.' : 'Production Actions is OFF: approving continues the run, but the external action is simulated.') : 'Sandbox run: approving continues the run; external actions are simulated.'),
        deciding
          ? h('div', { class: 'row mt-2' }, h('span', { class: 'spinner' }), h('span', { class: 'small muted' }, 'Recorded — the rest of the run is executing…'))
          : h('div', { class: 'row mt-2' }, note, button('Approve', { kind: 'primary', ic: 'check', onClick: () => decide('approve') }), button('Reject', { kind: 'danger', ic: 'x', onClick: () => decide('reject') })),
      ),
    );
  }

  function paint() {
    if (graph) {
      graph.destroy();
      graph = null;
    }
    const s = app.settings.appearance;
    const statusMap = statusMapFromTrace(run.trace);
    if (run.pending_approval && run.pending_approval.step_id) statusMap[run.pending_approval.step_id] = 'awaiting_approval';
    if (pb) graph = workflowGraph(pb, { statusMap, height: 'auto', legend: false, interactive: false });
    const statusBanner =
      run.status === 'completed'
        ? banner('pass', 'Run completed', run.validation && run.validation.passed ? 'The output passed validation against the output contract.' : 'Completed with validation warnings.')
        : run.status === 'failed'
          ? banner('fail', `Run failed${run.error ? `: ${run.error.code}` : ''}`, run.error ? `${run.error.message}${run.error.step_id ? ` (at ${run.error.step_id})` : ''}` : '')
          : run.status === 'needs_input'
            ? banner('warn', 'Run needs input', run.error ? run.error.message : 'Required input is missing.')
            : run.status === 'running'
              ? banner('info', 'Running…', 'This page updates automatically.')
              : run.status === 'cancelled'
                ? banner('warn', 'Run cancelled', '')
                : null;

    append(clear(body), [
      pageHead({
        title: `Run · ${run.playbook_name}`,
        crumbs: h('div', { class: 'crumbs' }, h('a', { href: '#/runs' }, 'Runs'), icon('chevronRight'), h('span', null, run.id)),
        badges: [badge(run.status), run.mode === 'ai' ? badge('', 'AI Execution', 'accent') : badge('', 'Deterministic', 'outline'), badge('', run.environment, run.environment === 'production' ? 'info' : 'outline')],
        actions: [
          ['running', 'awaiting_approval'].includes(run.status) ? button('Cancel run', { kind: 'danger', ic: 'ban', onClick: async () => { run = (await api.post(`/api/runs/${run.id}/cancel`)).data.run; paint(); } }) : null,
          button('Open playbook', { ic: 'book', href: `#/playbooks/${run.playbook_id}/runs` }),
        ].filter(Boolean),
      }),
      approvalCard(),
      statusBanner,
      run.mode === 'deterministic' && (run.warnings || []).some((w) => w.code === 'SIMULATED')
        ? banner('info', 'Some steps were simulated', `${(run.warnings || []).filter((w) => w.code === 'SIMULATED').map((w) => w.step_id).join(', ')} need an AI model (they are not machine-executable). Run in AI Execution mode to perform them.`)
        : null,
      h(
        'div',
        { class: 'grid sidebar-right' },
        h(
          'div',
          { class: 'stack' },
          card({
            title: 'Output',
            icon: 'file',
            actions: run.output ? [button('Copy', { size: 'sm', ic: 'copy', onClick: () => copyText(JSON.stringify(run.output, null, 2)) })] : [],
            body: run.output !== null && run.output !== undefined ? jsonView(run.output) : h('div', { class: 'muted small' }, 'No output.'),
          }),
          run.validation && run.validation.issues && run.validation.issues.length ? card({ title: 'Validation issues', icon: 'alert', body: h('ul', { class: 'bullets small' }, run.validation.issues.map((i) => h('li', null, i))) }) : null,
          graph ? card({ title: 'Execution path', icon: 'workflow', hint: 'Taken branch highlighted', tight: true, body: graph.el }) : null,
          card({
            title: 'Step trace',
            icon: 'list',
            body: run.trace.length
              ? h(
                  'ol',
                  { class: 'timeline' },
                  run.trace.map((t) =>
                    h(
                      'li',
                      { class: t.status },
                      h('span', { class: 'tl-icon' }, icon(TL_ICON[t.status] || 'pending')),
                      h('div', null, h('div', { class: 'bold small' }, `${t.name || t.step_id}`, h('span', { class: 'muted xsmall' }, `  ${t.step_id}`)), t.message && t.message !== t.name ? h('div', { class: 'small text-2' }, t.message) : null, t.decision !== undefined ? h('div', { class: 'small' }, 'Decision: ', badge('', String(t.decision), 'violet'), t.rule_id ? h('span', { class: 'muted xsmall' }, ` via ${t.rule_id}`) : null) : null, t.error ? h('div', { class: 'small', style: { color: 'var(--fail)' } }, `${t.error.code}: ${t.error.message}`) : null),
                      h('div', { class: 'xsmall muted', style: { textAlign: 'right' } }, badge(t.status), t.duration_ms !== undefined ? h('div', null, duration(t.duration_ms)) : null, t.attempts > 1 ? h('div', null, `${t.attempts} attempts`) : null),
                    ),
                  ),
                )
              : h('div', { class: 'muted small' }, run.status === 'needs_input' ? 'Stopped before any step ran.' : 'No steps recorded yet.'),
          }),
          s.show_execution_logs
            ? card({
                title: 'Execution log',
                icon: 'code',
                body: h('div', { class: 'log-lines' }, run.logs.map((l) => h('div', { class: `lv-${l.level}` }, h('span', { class: 'ts' }, new Date(l.ts).toLocaleTimeString()), l.step_id ? `[${l.step_id}] ` : '', l.message))),
              })
            : null,
        ),
        h(
          'div',
          { class: 'stack' },
          card({
            title: 'Details',
            icon: 'info',
            body: kv([
              ['Playbook', h('a', { href: `#/playbooks/${run.playbook_id}` }, run.playbook_name)],
              ['Version', `v${run.version} (${title(run.version_status)})`],
              ['Mode', run.mode === 'ai' ? 'AI Execution' : 'Deterministic'],
              ['Environment', title(run.environment)],
              ['Trigger', title(run.trigger)],
              ['Input from', run.input_source ? h('code', { class: 'inline' }, run.input_source) : 'Entered in the app'],
              ['Saved in', run.workspace_path ? h('a', { href: `#/playbooks/${run.playbook_id}/files?path=${encodeURIComponent(run.workspace_path)}` }, `📁 ${run.workspace_path}`) : '—'],
              ['Model', run.model ? h('code', { class: 'inline' }, run.model) : '—'],
              ['Started', when(run.started_at)],
              ['Duration', duration(run.duration_ms)],
              ['Tokens', run.usage ? `${run.usage.total_tokens.toLocaleString()} (${run.usage.calls} calls)` : '—'],
              ['Cost', h('span', { class: 'cost' }, run.usage ? money(run.usage.cost) : '—')],
            ]),
          }),
          card({
            title: 'Policy at run time',
            icon: 'shield',
            body: kv([
              ['Production actions', run.policy.production_actions ? 'ON' : 'OFF (simulated)'],
              ['Human approval', run.policy.human_approval ? 'ON' : 'OFF'],
              ['Tool calling', run.policy.tool_calling ? 'ON' : 'OFF'],
              ['Validation', run.policy.require_validation ? 'Required' : 'Advisory'],
            ]),
          }),
          run.warnings && run.warnings.length ? card({ title: 'Warnings', icon: 'alert', body: h('ul', { class: 'bullets small' }, run.warnings.map((w) => h('li', null, w.message || w.code))) }) : null,
          card({ title: 'Input', icon: 'database', body: jsonView(run.input, { cls: 'short' }) }),
          run.approvals && run.approvals.length
            ? card({ title: 'Approvals', icon: 'shieldCheck', body: h('ul', { class: 'list-clean small' }, run.approvals.map((a) => h('li', null, h('div', { class: 'row between' }, h('span', null, a.reason), badge(a.status === 'approved' ? 'pass' : a.status === 'pending' ? 'warning' : 'fail', title(a.status))), a.note ? h('div', { class: 'muted' }, a.note) : null, h('div', { class: 'xsmall muted' }, when(a.decided_at || a.requested_at))))) })
            : null,
        ),
      ),
    ]);
  }
  function startPoll() {
    if (stop) stop();
    stop = null;
    if (!['running'].includes(run.status)) return;
    stop = poll(() => api.get(`/api/runs/${run.id}`), {
      onUpdate: (r) => {
        run = r.data.run;
        paint();
      },
      done: (r) => r.data.run.status !== 'running',
    });
  }
  paint();
  startPoll();
  return () => {
    if (stop) stop();
    if (graph) graph.destroy();
  };
}
