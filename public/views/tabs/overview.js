// Overview tab (spec §56).
import { api } from '../../api.js';
import { h, card, kv, badge, button, title, when, pct, money, icon } from '../../ui.js';
import { qualityGateList, lifecycle, metricTiles, checkLines } from '../../components/common.js';

export async function render(el, ctx) {
  const { view, pb } = ctx;
  const v = view.version;
  const gate = await api.get(`/api/playbooks/${ctx.id}/quality-gate?version=${v.version}`);
  const t = pb.trigger || {};
  const lt = v.last_test;

  const nextStep = (() => {
    if (!gate.passed) return { text: 'Fix the quality gate issues, then run the tests.', action: null };
    if (!lt || (view.stale && view.stale.stale)) return { text: 'Run the test suite on this version.', action: button('Run Tests', { kind: 'primary', size: 'sm', ic: 'flask', onClick: () => ctx.go('tests', v.version, 'autorun=1') }) };
    if (v.status === 'failed') return { text: 'Tests failed. Review the failures and approve a fix.', action: button('Open Tests', { size: 'sm', onClick: () => ctx.go('tests') }) };
    if (['passed', 'warning'].includes(v.status)) return { text: 'Tests passed. Publish this version to make it runnable in production.', action: null };
    if (v.status === 'published') return { text: 'Published. Promote it to production or run it.', action: button('Run', { size: 'sm', ic: 'play', onClick: () => ctx.go('runs') }) };
    if (v.status === 'production') return { text: 'In production. Runs, schedules and webhooks use this version.', action: button('Run', { size: 'sm', ic: 'play', onClick: () => ctx.go('runs') }) };
    return { text: 'Review the workflow, then test it.', action: null };
  })();

  const intent = view.intent;
  const intentCard = intent
    ? card({
        title: 'Confirmed intent',
        icon: 'message',
        hint: 'What the user asked for',
        body: kv([
          ['Goal', intent.goal],
          ['Rules', intent.rules && intent.rules.length ? h('ul', { class: 'bullets', style: { margin: 0 } }, intent.rules.map((r) => h('li', null, r))) : null],
          ['Data', (intent.data_sources || []).join(', ')],
          ['Action', (intent.actions || []).join('; ')],
          ['Trigger', [title(intent.trigger && intent.trigger.type), intent.trigger && intent.trigger.frequency, intent.trigger && intent.trigger.day, intent.trigger && intent.trigger.time].filter(Boolean).join(' · ')],
          ['Output', intent.output ? [intent.output.format, intent.output.description].filter(Boolean).join(' — ') : null],
          ['Constraints', (intent.constraints || []).join('; ')],
        ]),
      })
    : null;

  el.append(
    h(
      'div',
      { class: 'grid sidebar-right' },
      h(
        'div',
        { class: 'stack' },
        card({
          title: 'Objective',
          icon: 'target',
          body: h('div', null, h('div', { style: { fontSize: '16px', fontWeight: 600 } }, pb.objective), pb.description ? h('p', { class: 'text-2' }, pb.description) : null, h('div', { class: 'section-label' }, 'Scope'), h('div', { class: 'text-2' }, pb.scope || '—')),
        }),
        intentCard,
        card({
          title: 'Quality gate',
          icon: 'shieldCheck',
          hint: gate.passed ? 'Production candidate' : 'Blocks publishing',
          actions: [gate.passed ? badge('pass', 'PASSED') : badge('fail', `${gate.checks.filter((c) => !c.passed).length} FAILED`)],
          body: h('div', null, qualityGateList(gate), gate.warnings.length ? h('details', { class: 'collapsible mt-2' }, h('summary', { class: 'small' }, `${gate.warnings.length} warning(s)`), h('ul', { class: 'bullets small text-2' }, gate.warnings.map((w) => h('li', null, w.message)))) : null, h('div', { class: 'xsmall muted mt-2' }, `Deterministic coverage: ${gate.stats.machine_executable_steps} of ${gate.stats.steps} steps are machine-executable (${pct(gate.stats.deterministic_coverage)}).`)),
        }),
      ),
      h(
        'div',
        { class: 'stack' },
        card({
          title: 'Status',
          icon: 'flag',
          body: h(
            'div',
            null,
            kv([
              ['Status', h('span', { class: 'row' }, badge(v.status), v.immutable ? h('span', { class: 'xsmall muted' }, 'immutable') : null)],
              ['Version', `v${v.version}${v.revision > 1 ? ` (revision ${v.revision})` : ''}`],
              ['AI', pb.ai && pb.ai.model ? (pb.ai.connection_id && pb.ai.connection_id.startsWith('conn_local') ? 'Local AI (on this computer)' : 'Cloud provider') : h('span', { class: 'muted' }, 'Not set — deterministic runs only')],
              ['Model', pb.ai && pb.ai.model ? h('code', { class: 'inline' }, pb.ai.model) : '—'],
              ['Trigger', [title(t.type), t.frequency, t.day, t.time].filter(Boolean).join(' · ')],
              ['Workflow', `${pb.steps.length} steps · ${pb.decision_rules.length} rules · ${pb.tools.length} tools`],
              ['Tests', `${view.suite.count} test cases`],
              ['Workspace', view.workspace ? h('a', { href: `#/playbooks/${view.id}/files` }, `📁 ${view.workspace.folder}`) : h('span', { class: 'muted' }, 'Being prepared…')],
              ['Source', `${title(v.source)}${v.change_note ? ` — ${v.change_note}` : ''}`],
              ['Updated', when(v.updated_at)],
              v.published_at ? ['Published', when(v.published_at)] : null,
            ]),
            h('div', { class: 'mt-3' }, lifecycle(v.status)),
            h('div', { class: 'banner accent mt-3', style: { marginBottom: 0 } }, icon('info'), h('div', { class: 'banner-body small' }, nextStep.text), nextStep.action),
          ),
        }),
        card({
          title: 'Latest test',
          icon: 'flask',
          actions: lt ? [button('Details', { size: 'sm', kind: 'ghost', href: `#/test-runs/${lt.test_run_id}` })] : [],
          body: lt
            ? h('div', { class: 'stack' }, h('div', { class: 'row between' }, badge(lt.status, null, 'lg'), h('span', { class: 'small muted' }, `${lt.mode === 'ai' ? 'AI Execution' : 'Deterministic'} · ${when(lt.at)}`)), checkLines(lt.counts), metricTiles(lt.metrics, { compact: true }), view.stale && view.stale.stale ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, '⚠ Changed since this run') : null)
            : h('div', { class: 'stack' }, h('div', { class: 'muted' }, view.stale && view.stale.stale ? `Not tested yet — v${view.stale.since_version} was tested.` : 'Not tested yet.'), button('Run Tests', { kind: 'primary', ic: 'flask', onClick: () => ctx.go('tests', v.version, 'autorun=1') })),
        }),
        view.generation
          ? card({
              title: 'Generation',
              icon: 'sparkles',
              body: kv([
                ['Model', h('code', { class: 'inline' }, view.generation.model || '—')],
                ['Compiler passes', String(view.generation.attempts || 1)],
                ['Tokens', view.generation.usage ? view.generation.usage.total_tokens.toLocaleString() : '—'],
                ['Cost', h('span', { class: 'cost' }, view.generation.usage ? money(view.generation.usage.cost) : '—')],
              ]),
            })
          : null,
      ),
    ),
  );
}
