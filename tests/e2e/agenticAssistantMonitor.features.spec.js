'use strict';
// Feature coverage for the Agentic Assistant Monitor, driven entirely on the local
// harness with a network-level connector mock (_monitorMock.js). The real
// service, controller and template are all in the loop -- only the box is faked.
//
//   make test-e2e-spec SPEC=widgets-src/agenticAssistantMonitor/tests/e2e/agenticAssistantMonitor.features.spec.js
//
// Every `defect:` test below corresponds to a bug found in the 1.0.7 build and
// fixed in 1.0.8. The rest are the tab-by-tab feature sweep.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');
const { installMonitorMock, lastCall, calls, ADMIN_IRI, withEscalation } = require('./_monitorMock');

const CONFIG = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 600 };

// Mount the EXACT source build, never the bare name.
//
// `widget-packages/` holds every previously packaged agenticAssistantMonitor
// (1.0.1 … 1.0.7) and the harness mounts each as a separate widget that
// re-uses the same `name`. `mountWidget` resolves with
// `widgets.find(w => w.name === name)`, so which build you get depends on
// directory-enumeration order. Landing on a packaged one made lint block
// bootstrap ([edit-config-inject]) and the widget never left its loading
// state -- surfacing as a *different* test failing on roughly one run in
// three. Pinning the versioned id from info.json removes the ambiguity.
const WIDGET_ID = 'agenticAssistantMonitor-' + require('../../widget/info.json').version;

// Seed the harness's widget selection BEFORE the first paint.
//
// Each Playwright test gets a fresh context, so `localStorage['harness.widget']`
// is empty and index.html falls back to `widgets[0]` -- which is `counter`.
// `counter` currently fails lint ([edit-config-inject]), so the harness renders
// a lint-blocked banner; `mountWidget`'s settle check counts that banner as
// "terminal content" and returns before our widget is up. If the select has not
// been populated yet when mountWidget dispatches its change event, the empty
// value is persisted and the reload lands back on `counter` for good.
//
// Seeding the id up front makes the very first load mount the widget under
// test, so none of that race is reachable. (The underlying mountWidget race is
// shared-infra and still worth fixing.)
async function seedSelection(page, config) {
  await page.addInitScript(([id, cfg]) => {
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness:config:' + id, JSON.stringify(cfg));
  }, [WIDGET_ID, config]);
}

// `startTab` is where the spec begins: the older specs cover the Usage tab
// (the former Overview), so they start there; the queue spec starts on the
// default tab.
async function mount(page, config = CONFIG, mockOpts = {}, startTab = 'overview') {
  await installMonitorMock(page, mockOpts);
  await seedSelection(page, config);
  const w = await mountWidget(page, WIDGET_ID, { config });
  // Wait for the initial $q.all to resolve -- loading spinner gone, cards up.
  try {
    await page.locator('[data-testid=sm-queue]').waitFor({ timeout: 15000 });
    if (startTab === 'overview') {
      await page.locator('[data-testid=sm-tab-overview]').click();
      await page.locator('[data-testid=sm-card-turns]').waitFor({ timeout: 15000 });
    }
  } catch (e) {
    // Don't report "element never appeared" and leave the cause unknown: dump
    // the controller's own view of why it is still loading, plus the wire calls
    // the mock actually served.
    const diag = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=soc-monitor-root]');
      if (!el) return { mounted: false, html: document.querySelector('#widget-host')?.innerHTML?.slice(0, 400) };
      const sc = window.angular.element(el).scope();
      return { mounted: true, initialLoading: sc.initialLoading, error: sc.error,
               usage: (sc.usage || []).length, summary: (sc.summary || []).length };
    }).catch((err) => ({ evaluateFailed: String(err) }));
    const served = await calls(page);
    const listed = await page.request.get('/_fsr/widgets').then((r) => r.json())
      .then((j) => (j.widgets || []).filter((x) => x.name === 'agenticAssistantMonitor')
        .map((x) => ({ id: x.id, dir: x.dir, errs: (x.lint && x.lint.errors || []).map((z) => z.code) })))
      .catch((err) => String(err));
    throw new Error(
      `monitor never left loading. wanted=${WIDGET_ID} controller=${JSON.stringify(diag)} ` +
      `served=${JSON.stringify(served.map((c) => c.operation))} ` +
      `listed=${JSON.stringify(listed)}\noriginal: ${e.message}`
    );
  }
  return w;
}

const root = (page) => page.locator('[data-testid=soc-monitor-root]');
const tab = (page, name) => page.locator(`[data-testid=sm-tab-${name}]`);

test.describe('agenticAssistantMonitor -- KPI cards + overview chart', () => {

  test('KPI cards show totals derived from the usage rows', async ({ page }) => {
    await mount(page);
    // The tiles sum the server-side summaries (uncapped), not the capped usage
    // rows. The mock scales the cost series (0.02 + 0.035 = 0.055) by 100 for
    // turns and by 10000 for tokens, so a tile read from the wrong metric shows.
    await expect(page.locator('[data-testid=sm-card-turns] .sm-card-value')).toHaveText('5.5');
    await expect(page.locator('[data-testid=sm-card-tokens] .sm-card-value')).toHaveText('550');
    await expect(page.locator('[data-testid=sm-card-cost] .sm-card-value')).toHaveText('$0.06');
    await expect(page.locator('[data-testid=sm-card-pending] .sm-card-value')).toHaveText('1');
  });

  test('defect: the chart zero-fills the whole range instead of connecting two points', async ({ page }) => {
    await mount(page);
    await expect(page.locator('[data-testid=sm-overview-chart]')).toBeVisible();

    // The mock returns only 2 populated day buckets. The rendered path must
    // still carry one vertex per day across the 7d window (8 inclusive), so the
    // five silent days are drawn as zeros rather than skipped.
    const d = await page.locator('[data-testid=sm-overview-chart] path').nth(1).getAttribute('d');
    const vertices = (d.match(/[ML]/g) || []).length;
    expect(vertices).toBe(8);

    // The five quiet days sit on the chart floor (y = padTop + innerH = 134).
    const floorPoints = (d.match(/,134\.0/g) || []).length;
    expect(floorPoints).toBeGreaterThanOrEqual(5);
  });

  test('defect: axis labels are HTML (undistorted), not stretched <text>', async ({ page }) => {
    await mount(page);
    // preserveAspectRatio="none" scales the viewBox non-uniformly, which would
    // smear any <text> inside it horizontally ("0 7 - 2 8"). There must be none.
    const svgTextCount = await page.locator('[data-testid=sm-overview-chart] svg text').count();
    expect(svgTextCount).toBe(0);

    // Frozen now = 2026-07-28T12:00Z; 7d back floors to 07-21, inclusive
    // through 07-28 = 8 day buckets.
    const labels = page.locator('[data-testid=sm-chart-axis-label]');
    await expect(labels).toHaveCount(8);
    await expect(labels.first()).toHaveText('07-21');
    await expect(labels.last()).toHaveText('07-28');
  });

  test('defect: every axis label stays inside the chart panel (no edge clipping)', async ({ page }) => {
    await mount(page);
    const panel = await page.locator('[data-testid=sm-overview-chart]').boundingBox();
    const labels = page.locator('[data-testid=sm-chart-axis-label]');
    const n = await labels.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const b = await labels.nth(i).boundingBox();
      expect(b, `label ${i} has no box`).not.toBeNull();
      // The old build placed the first at x=0 and the last at x=400 on a
      // 0..400 viewBox, so both hung half-outside the panel.
      expect(b.x, `label ${i} clipped on the left`).toBeGreaterThanOrEqual(panel.x - 0.5);
      expect(b.x + b.width, `label ${i} clipped on the right`).toBeLessThanOrEqual(panel.x + panel.width + 0.5);
    }
  });

  test('defect: labels sit over their data points (shared x scale)', async ({ page }) => {
    await mount(page);
    // Path x runs 0..1000 across 8 buckets; labels are percentages off the same
    // divisor. Assert the rendered geometry agrees rather than the maths.
    const svgBox = await page.locator('[data-testid=sm-overview-chart] svg').boundingBox();
    const labels = page.locator('[data-testid=sm-chart-axis-label]');
    const n = await labels.count();
    for (let i = 0; i < n; i++) {
      const b = await labels.nth(i).boundingBox();
      const centre = b.x + b.width / 2;
      const expected = svgBox.x + (i / (n - 1)) * svgBox.width;
      // First/last are edge-anchored (translateX 0 / -100%), so allow the label
      // half-width there; interior labels are centred on their point.
      const tol = (i === 0 || i === n - 1) ? b.width / 2 + 2 : 6;
      expect(Math.abs(centre - expected), `label ${i} off its point`).toBeLessThanOrEqual(tol);
    }
  });

  test('the chart exposes its peak value so the area has a magnitude', async ({ page }) => {
    await mount(page);
    await expect(page.locator('[data-testid=sm-chart-ymax]')).toContainText('0.035');
  });

  test('sparklines render one vertex per bucket, zero-based', async ({ page }) => {
    await mount(page);
    for (const card of ['turns', 'tokens', 'cost']) {
      const d = await page.locator(`[data-testid=sm-card-${card}] .sm-card-spark path`).first().getAttribute('d');
      expect((d.match(/[ML]/g) || []).length, `${card} sparkline`).toBe(8);
      // Quiet buckets rest on the sparkline floor (h - pad = 25).
      expect(d, `${card} sparkline not zero-based`).toContain(',25.0');
    }
  });

  test('a 24h range switches the chart to hourly buckets', async ({ page }) => {
    await mount(page, { ...CONFIG, range: '24h' });
    const call = await lastCall(page, 'get_usage_summary');
    expect(call.params.bucket).toBe('hour');
    // 24h inclusive of both endpoints = 25 hourly buckets.
    await expect(page.locator('[data-testid=sm-chart-axis-label]').first()).toHaveText(/^\d{2}:\d{2}$/);
    const d = await page.locator('[data-testid=sm-overview-chart] path').nth(1).getAttribute('d');
    expect((d.match(/[ML]/g) || []).length).toBe(25);
  });

  test('no second, hourly round-trip is made for a sparse daily range', async ({ page }) => {
    await mount(page);
    // The removed "only 1 bucket -> retry hourly" fallback masked the missing
    // zero-fill. A 7d range asks for day buckets once per metric (cost, turns,
    // tokens), never for an hourly series.
    const summaryCalls = await calls(page, 'get_usage_summary');
    expect(summaryCalls.map((c) => c.params.bucket)).toEqual(['day', 'day', 'day']);
    expect(summaryCalls.map((c) => c.params.metric).sort()).toEqual(['cost', 'tokens', 'turns']);
  });
});

test.describe('agenticAssistantMonitor -- every tab renders its data', () => {

  test('Sessions lists live sessions with derived status pips', async ({ page }) => {
    await mount(page);
    await tab(page, 'sessions').click();
    await expect(page.locator('[data-testid=sm-sessions-table]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-sessions-row]')).toHaveCount(3);
    const statuses = await page.locator('[data-testid=sm-sessions-status]').allTextContents();
    expect(statuses.map((s) => s.trim())).toEqual(['streaming', 'waiting', 'idle']);
  });

  test('Pending says what each approval asks: action, record, field changes, who and how long', async ({ page }) => {
    await mount(page);
    await tab(page, 'pending').click();
    await expect(page.locator('[data-testid=sm-pending-table]')).toBeVisible();
    const row = page.locator('[data-testid=sm-pending-row]').first();
    await expect(row.locator('[data-testid=sm-pending-title]')).toHaveText('Update the template description');
    await expect(row.locator('[data-testid=sm-pending-target]')).toHaveText('On Create Next Test Loopback Interface');
    const change = row.locator('[data-testid=sm-pending-changes] tr').first();
    await expect(change).toContainText('description');
    await expect(change.locator('.sm-pending-before')).toHaveText('Loopback helper');
    await expect(change.locator('.sm-pending-after')).toHaveText('Creates the next free loopback');
    await expect(row).toContainText('CS Admin');
    await expect(row).toContainText('1.5h');
    await expect(row).not.toContainText('sess-wait-1');
    await expect(page.locator('[data-testid=sm-pending-open]')).toBeVisible();
  });

  test('Approve answers the card from the queue with the chat drawer\'s own resume', async ({ page }) => {
    await mount(page);
    await tab(page, 'pending').click();
    await page.locator('[data-testid=sm-pending-approve]').click();
    await expect(page.locator('[data-testid=sm-pending-row]')).toHaveCount(0);
    const sent = await lastCall(page, 'chat_resume');
    expect(sent.params).toMatchObject({ session_id: 'sess-wait-1', card_id: 'apr-1', decision: 'approve' });
    expect(sent.params.approval_id).toBeUndefined();
    await expect(tab(page, 'pending').locator('.sm-tab-count')).toHaveCount(0);
  });

  test('Reject sends a reject for that card', async ({ page }) => {
    await mount(page);
    await tab(page, 'pending').click();
    await page.locator('[data-testid=sm-pending-reject]').click();
    await expect.poll(async () => (await lastCall(page, 'chat_resume') || {}).params)
      .toMatchObject({ card_id: 'apr-1', decision: 'reject' });
  });

  test('Open in chat on a pending row hands its session to the chat drawer', async ({ page }) => {
    await mount(page);
    await tab(page, 'pending').click();
    await page.locator('[data-testid=sm-pending-open]').click();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('fsrPbOpenSession')))
      .toBe('sess-wait-1');
  });

  test('a card already answered in the chat says who answered it and cannot be approved again', async ({ page }) => {
    const msg = 'This card was already approved by Lead Analyst; it runs at most once.';
    await mount(page, CONFIG, { handle: (op, params, base) => op === 'chat_resume'
      ? { ok: false, error: { code: 'already_decided', message: msg } } : base(op, params) });
    await tab(page, 'pending').click();
    await page.locator('[data-testid=sm-pending-approve]').click();
    await expect(page.locator('[data-testid=sm-pending-note]')).toHaveText(msg);
    await expect(page.locator('[data-testid=sm-pending-approve]')).toBeDisabled();
    await expect(page.locator('[data-testid=sm-pending-row]')).toHaveCount(1);
  });

  test('the Pending tab count badge matches the pending rows', async ({ page }) => {
    await mount(page);
    await expect(tab(page, 'pending').locator('.sm-tab-count')).toHaveText('1');
  });

  test('Users rolls up per user with turns, tokens, cost and share', async ({ page }) => {
    await mount(page);
    await tab(page, 'users').click();
    await expect(page.locator('[data-testid=sm-users-table]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-users-row]')).toHaveCount(2);
    const names = await page.locator('[data-testid=sm-users-name]').allTextContents();
    expect(names.map((s) => s.trim())).toEqual(['CS Admin', '(unknown)']);
    // CS Admin: 2 turns, 3600 tokens, $0.05 of $0.055 = 91%.
    await expect(page.locator('[data-testid=sm-users-row]').first()).toContainText('3,600');
    await expect(page.locator('[data-testid=sm-users-row]').first()).toContainText('91%');
  });

  test('Scheduled lists tasks with cron, status and a run control', async ({ page }) => {
    await mount(page);
    await tab(page, 'scheduled').click();
    await expect(page.locator('[data-testid=sm-scheduled-table]')).toBeVisible();
    const row = page.locator('[data-testid=sm-scheduled-row]').first();
    await expect(row).toContainText('Daily alert review');
    await expect(row).toContainText('0 9 * * 1');
    await expect(row).toContainText('never');
    await expect(row).toContainText('enabled');
  });

  test('Scheduled "Run" dispatches run_scheduled_task_now and reloads', async ({ page }) => {
    await mount(page);
    await tab(page, 'scheduled').click();
    await page.locator('[data-testid=sm-scheduled-run]').first().click();
    await expect.poll(async () => (await calls(page, 'run_scheduled_task_now')).length).toBeGreaterThan(0);
    const call = await lastCall(page, 'run_scheduled_task_now');
    expect(call.params.name).toBe('Daily alert review');
  });

  test('a failed Run shows in its row and does not raise the page banner', async ({ page }) => {
    await mount(page, CONFIG, { handle: (op, params, base) => (op === 'run_scheduled_task_now'
      ? { ok: false, error: { message: 'The scheduler refused the trigger.' } } : base(op, params)) });
    await tab(page, 'scheduled').click();
    await page.locator('[data-testid=sm-scheduled-run]').click();
    await expect(page.locator('[data-testid=sm-scheduled-run-result]')).toHaveText('Failed');
    await expect(page.locator('[data-testid=sm-error]')).toHaveCount(0);
  });

  test('Audit Trail lists LLM calls with model, intent, tokens and status', async ({ page }) => {
    await mount(page);
    await tab(page, 'audit').click();
    await expect(page.locator('[data-testid=sm-audit-table]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-audit-row]')).toHaveCount(3);
    const first = page.locator('[data-testid=sm-audit-row]').first();
    await expect(first).toContainText('gpt-4.1-mini');
    await expect(first).toContainText('triage');
    await expect(first).toContainText('1,200');
  });

  test('defect: a panel whose fetch failed says so instead of "nothing here"', async ({ page }) => {
    await mount(page);
    // Registered after the mock, so it answers first; everything else falls through.
    await page.route('**/api/integration/execute/**', (route) => {
      const op = (JSON.parse(route.request().postData() || '{}') || {}).operation;
      return op === 'list_active_sessions'
        ? route.fulfill({ status: 502, contentType: 'application/json', body: '{"message":"Bad gateway"}' })
        : route.fallback();
    });
    await tab(page, 'sessions').click();
    await expect(page.locator('[data-testid=sm-sessions-failed]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-sessions-empty]')).toHaveCount(0);
  });

  test('an empty panel shows its empty state rather than a bare table', async ({ page }) => {
    await installMonitorMock(page, {
      handle: (op, params, base) => (op === 'list_scheduled_tasks' ? { tasks: [] } : base(op, params)),
    });
    await seedSelection(page, CONFIG);
    const w = await mountWidget(page, WIDGET_ID, { config: CONFIG });
    await page.locator('[data-testid=sm-queue]').waitFor({ timeout: 15000 });
    await tab(page, 'scheduled').click();
    await expect(page.locator('[data-testid=sm-scheduled-empty]')).toBeVisible();
    expect(await w.visible('[data-testid=sm-scheduled-table]')).toBe(false);
  });
});

test.describe('agenticAssistantMonitor -- escalations (auto-triage)', () => {

  test('an escalation says what was triaged, what the assistant concluded and why it stopped', async ({ page }) => {
    await mount(page, CONFIG, { handle: withEscalation });
    await tab(page, 'pending').click();
    const row = page.locator('[data-testid=sm-esc-row]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-testid=sm-esc-priority]')).toHaveText('P1');
    await expect(row.locator('[data-testid=sm-esc-title]')).toHaveText('Outbound beacon to 198.51.100.7');
    await expect(row.locator('[data-testid=sm-esc-verdict]')).toHaveText('True positive, 92% confident · High severity');
    await expect(row.locator('[data-testid=sm-esc-summary]')).toHaveText('Known command-and-control address.');
    await expect(row.locator('[data-testid=sm-esc-reasons] li')).toHaveText(['1 action waiting for approval.']);
    await expect(row.locator('[data-testid=sm-esc-age]')).toHaveText('2h');
  });

  test('its waiting action is decided under it and not listed twice', async ({ page }) => {
    await mount(page, CONFIG, { handle: withEscalation });
    await tab(page, 'pending').click();
    const nested = page.locator('[data-testid=sm-esc-approval]');
    await expect(nested.locator('[data-testid=sm-esc-approval-title]'))
      .toHaveText('Block 198.51.100.7 on FortiGate on Outbound beacon to 198.51.100.7');
    // The plain table keeps only the analyst's own approval.
    await expect(page.locator('[data-testid=sm-pending-row]')).toHaveCount(1);
    await expect(page.locator('[data-testid=sm-pending-title]')).toHaveText('Update the template description');
    await expect(tab(page, 'pending').locator('.sm-tab-count')).toHaveText('3');

    await nested.locator('[data-testid=sm-esc-approve]').click();
    await expect(nested).toHaveCount(0);
    const sent = await lastCall(page, 'chat_resume');
    expect(sent.params).toMatchObject({ session_id: 'auto:alerts:u9', card_id: 'apr-9', decision: 'approve' });
    // Approving the action does not close the escalation; a reviewer does.
    await expect(page.locator('[data-testid=sm-esc-row]')).toHaveCount(1);
  });

  test('Mark handled resolves it as the reviewer and takes it off the queue', async ({ page }) => {
    await mount(page, CONFIG, { handle: withEscalation });
    await tab(page, 'pending').click();
    await page.locator('[data-testid=sm-esc-handled]').click();
    await expect(page.locator('[data-testid=sm-esc-row]')).toHaveCount(0);
    const sent = await lastCall(page, 'resolve_escalation');
    expect(sent.params).toMatchObject({ session_id: 'auto:alerts:u9', card_id: 'esc_u9', outcome: 'handled' });
    // Its undecided action now stands on its own in the approvals table.
    await expect(page.locator('[data-testid=sm-pending-row]')).toHaveCount(2);
  });

  test('Dismiss sends dismissed', async ({ page }) => {
    await mount(page, CONFIG, { handle: withEscalation });
    await tab(page, 'pending').click();
    await page.locator('[data-testid=sm-esc-dismiss]').click();
    await expect.poll(async () => (await lastCall(page, 'resolve_escalation') || {}).params)
      .toMatchObject({ card_id: 'esc_u9', outcome: 'dismissed' });
  });

  test('an escalation another reviewer resolved says who and cannot be resolved again', async ({ page }) => {
    const msg = 'This escalation was already dismissed by Lead B.';
    await mount(page, CONFIG, { handle: (op, params, base) => op === 'resolve_escalation'
      ? { ok: false, error: { code: 'already_decided', message: msg } } : withEscalation(op, params, base) });
    await tab(page, 'pending').click();
    await page.locator('[data-testid=sm-esc-handled]').click();
    await expect(page.locator('[data-testid=sm-esc-note]')).toHaveText(msg);
    await expect(page.locator('[data-testid=sm-esc-handled]')).toBeDisabled();
    await expect(page.locator('[data-testid=sm-esc-dismiss]')).toBeDisabled();
  });

  test('an empty queue still says nothing is waiting', async ({ page }) => {
    await mount(page, CONFIG, { handle: (op, params, base) => op === 'list_pending'
      ? { pending: [], escalations: [] } : base(op, params) });
    await tab(page, 'pending').click();
    await expect(page.locator('[data-testid=sm-pending-empty]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-esc-section]')).toHaveCount(0);
  });
});

test.describe('agenticAssistantMonitor -- one pending queue', () => {

  test('the KPI tile and the Pending badge count the same queue, escalations included', async ({ page }) => {
    await mount(page, CONFIG, { handle: withEscalation });
    await expect(page.locator('[data-testid=sm-card-pending] .sm-card-value')).toHaveText('3');
    await expect(tab(page, 'pending').locator('.sm-tab-count')).toHaveText('3');
  });

  test('a plain pending row names its target once, even when its title already does', async ({ page }) => {
    const row = {
      approval_id: 'apr-7', card_id: 'apr-7', session_id: 'sess-7', intent: 'triage',
      age_seconds: 5400, user: { name: 'CS Admin' },
      card: { type: 'action_card', tool: 'run_op', title: 'Block 198.51.100.7 on FortiGate',
              target: { name: 'FortiGate' } },
    };
    await mount(page, CONFIG, { handle: (op, params, base) =>
      (op === 'list_pending' ? { pending: [row] } : base(op, params)) });
    await tab(page, 'pending').click();
    const r = page.locator('[data-testid=sm-pending-row]').first();
    await expect(r.locator('[data-testid=sm-pending-title]')).toHaveText('Block 198.51.100.7 on FortiGate');
    await expect(r.locator('[data-testid=sm-pending-target]')).toHaveCount(0);
    await expect(r).toContainText('1.5h');
  });
});

test.describe('agenticAssistantMonitor -- audit drill-down', () => {

  test('the tool-call chain expands and shows per-call params, status and latency', async ({ page }) => {
    await mount(page);
    await tab(page, 'audit').click();
    await expect(page.locator('[data-testid=sm-audit-detail]')).toHaveCount(0);
    await page.locator('[data-testid=sm-audit-expand]').first().click();
    await expect(page.locator('[data-testid=sm-audit-detail]')).toBeVisible();
    const tools = page.locator('[data-testid=sm-audit-tool]');
    await expect(tools).toHaveCount(2);
    await expect(tools.first()).toContainText('get_record');
    await expect(tools.first()).toContainText('120ms');
    await expect(tools.nth(1)).toContainText('run_op');
    await expect(tools.nth(1)).toContainText('error');
    // A null-params tool renders "--" rather than "null".
    await expect(tools.nth(1).locator('.sm-tool-params')).toHaveText('--');
  });

  test('only rows with tool calls offer an expander', async ({ page }) => {
    await mount(page);
    await tab(page, 'audit').click();
    // Row 1 has 2 tool calls; rows 2 and 3 have none.
    await expect(page.locator('[data-testid=sm-audit-expand]')).toHaveCount(1);
    await expect(page.locator('[data-testid=sm-audit-toolcount]')).toHaveCount(1);
  });

  test('the Turn Detail overlay shows the prompt, tool chain and response, and closes', async ({ page }) => {
    await mount(page);
    await tab(page, 'audit').click();
    await page.locator('[data-testid=sm-audit-detail-btn]').first().click();
    const overlay = page.locator('[data-testid=sm-turn-detail-overlay]');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('triage this alert');
    await expect(overlay).toContainText('Benign -- known-good IP.');
    await expect(overlay).toContainText('get_record');
    await page.locator('[data-testid=sm-turn-detail-close]').click();
    await expect(overlay).toHaveCount(0);
  });

  test('a turn with an approval gate surfaces the gate count', async ({ page }) => {
    await mount(page);
    await tab(page, 'audit').click();
    // Row 3 (the build turn) carries approvals_count: 1.
    await page.locator('[data-testid=sm-audit-detail-btn]').nth(2).click();
    await expect(page.locator('[data-testid=sm-turn-detail-overlay]')).toContainText('1 approval');
  });
});

test.describe('agenticAssistantMonitor -- interactive filters', () => {

  test('defect: the Pending HITL card forwards its status filter to the sessions op', async ({ page }) => {
    await mount(page);
    await page.locator('[data-testid=sm-card-pending]').click();
    await expect(tab(page, 'sessions')).toHaveClass(/active/);

    // The wire call must carry the status. The 1.0.7 build sent a bare
    // {limit: 50}, so the list came back unfiltered under a filter chip.
    await expect.poll(async () => (await lastCall(page, 'list_active_sessions'))?.params?.status)
      .toBe('waiting_approval');

    // ...and the rendered list must actually be narrowed.
    await expect(page.locator('[data-testid=sm-sessions-row]')).toHaveCount(1);
    await expect(page.locator('[data-testid=sm-sessions-status]')).toHaveText('waiting');
  });

  test('defect: a session-status filter never leaks into the audit query', async ({ page }) => {
    await mount(page);
    await page.locator('[data-testid=sm-card-pending]').click();
    await expect(page.locator('[data-testid=sm-sessions-row]')).toHaveCount(1);

    await tab(page, 'audit').click();
    // `waiting_approval` is not a value any LLM call's status can take. Sending
    // it emptied the audit trail; the audit query must not receive it at all.
    await expect.poll(async () => (await lastCall(page, 'get_audit_trail'))?.params?.status)
      .toBeUndefined();
    await expect(page.locator('[data-testid=sm-audit-row]')).toHaveCount(3);
  });

  test('defect: chips only render on panels that honour them', async ({ page }) => {
    await mount(page);
    await page.locator('[data-testid=sm-card-pending]').click();
    await expect(page.locator('[data-testid=sm-filter-chip]')).toHaveCount(1);

    // Overview, Users, Pending and Scheduled all ignore filters -- a chip there
    // would claim to explain a list it has no effect on.
    for (const name of ['overview', 'users', 'pending', 'scheduled']) {
      await tab(page, name).click();
      await expect(page.locator('[data-testid=sm-filter-bar]'), `${name} shows a chip`).toHaveCount(0);
    }
    // Returning to Sessions brings the still-active filter back into view.
    await tab(page, 'sessions').click();
    await expect(page.locator('[data-testid=sm-filter-chip]')).toHaveCount(1);
  });

  test('defect: the user drill-down sends the IRI while the chip shows the name', async ({ page }) => {
    await mount(page);
    await tab(page, 'users').click();
    await page.locator('[data-testid=sm-users-name]').first().click();

    await expect(tab(page, 'audit')).toHaveClass(/active/);
    // The 1.0.7 build sent the display name into the IRI-keyed param, which
    // matched nothing and rendered "No LLM calls recorded yet" over real turns.
    await expect.poll(async () => (await lastCall(page, 'get_audit_trail'))?.params?.user_iri)
      .toBe(ADMIN_IRI);
    await expect(page.locator('[data-testid=sm-audit-row]')).toHaveCount(2);
    await expect(page.locator('[data-testid=sm-audit-empty]')).toHaveCount(0);
    // Chip stays human-readable.
    await expect(page.locator('[data-testid=sm-filter-chip]')).toContainText('CS Admin');
  });

  test('defect: a user with no IRI is not drillable', async ({ page }) => {
    await mount(page);
    await tab(page, 'users').click();
    const unknown = page.locator('[data-testid=sm-users-name]').nth(1);
    await expect(unknown).toHaveText('(unknown)');
    await expect(unknown).not.toHaveClass(/sm-cell-clickable/);
    await unknown.click();
    // Still on Users, no filter applied.
    await expect(tab(page, 'users')).toHaveClass(/active/);
    await expect(page.locator('[data-testid=sm-filter-bar]')).toHaveCount(0);
  });

  test('clicking an audit status badge filters the audit trail', async ({ page }) => {
    await mount(page);
    await tab(page, 'audit').click();
    await page.locator('[data-testid=sm-audit-status]').nth(2).click(); // "error"
    await expect.poll(async () => (await lastCall(page, 'get_audit_trail'))?.params?.status).toBe('error');
    await expect(page.locator('[data-testid=sm-audit-row]')).toHaveCount(1);
  });

  test('a chip clears on click and the panel reloads unfiltered', async ({ page }) => {
    await mount(page);
    await tab(page, 'audit').click();
    await page.locator('[data-testid=sm-audit-status]').nth(2).click();
    await expect(page.locator('[data-testid=sm-audit-row]')).toHaveCount(1);
    await page.locator('[data-testid=sm-filter-chip]').first().click();
    await expect(page.locator('[data-testid=sm-filter-bar]')).toHaveCount(0);
    await expect(page.locator('[data-testid=sm-audit-row]')).toHaveCount(3);
  });

  test('"Clear all" drops every filter at once', async ({ page }) => {
    await mount(page);
    await tab(page, 'audit').click();
    await page.locator('[data-testid=sm-audit-status]').nth(2).click();
    await page.locator('[data-testid=sm-audit-intent]').first().click();
    await expect(page.locator('[data-testid=sm-filter-chip]')).toHaveCount(2);
    await page.locator('[data-testid=sm-filter-clear]').click();
    await expect(page.locator('[data-testid=sm-filter-bar]')).toHaveCount(0);
    await expect(page.locator('[data-testid=sm-audit-row]')).toHaveCount(3);
  });
});

// What the 60s poll does: the controller's own refresh(), run in a digest.
async function pollRefresh(page) {
  await page.evaluate(() => {
    const sc = window.angular.element(document.querySelector('[data-testid=soc-monitor-root]')).scope();
    sc.$apply(() => sc.refresh());
  });
}

test.describe('agenticAssistantMonitor -- background refresh keeps the page', () => {

  test('a refresh keeps the outcome tiles, the open policy builder and its focus', async ({ page }) => {
    await mount(page);
    await tab(page, 'autonomy').click();
    await page.locator('[data-testid=sm-autonomy-edit]').click();
    // The structured builder is open; add a rule and edit its name.
    await page.locator('[data-testid=sm-autonomy-addrule]').click();
    const id = page.locator('[data-testid=sm-autonomy-rule-id]').last();
    await id.fill('close-false-positive');
    await id.focus();
    await page.evaluate(() => {
      document.querySelector('[data-testid=sm-autonomy-rule-id]').dataset.keep = 'yes';
      document.querySelector('[data-testid=sm-kpi-handled]').dataset.keep = 'yes';
    });
    const before = (await calls(page, 'list_usage')).length;
    await pollRefresh(page);
    await expect.poll(async () => (await calls(page, 'list_usage')).length).toBeGreaterThan(before);
    await page.waitForFunction(() => !document.querySelector('[data-testid=sm-refreshing]'));
    const kept = await page.evaluate(() => ({
      card: document.querySelector('[data-testid=sm-kpi-handled]')?.dataset.keep === 'yes',
      builder: document.querySelector('[data-testid=sm-autonomy-rule-id]')?.dataset.keep === 'yes',
      focused: document.activeElement?.dataset.testid === 'sm-autonomy-rule-id',
      value: document.querySelector('[data-testid=sm-autonomy-rule-id]')?.value,
    }));
    expect(kept).toEqual({ card: true, builder: true, focused: true,
      value: 'close-false-positive' });
  });

  test('an audit row the reviewer opened stays open across a refresh', async ({ page }) => {
    await mount(page);
    await tab(page, 'audit').click();
    await page.locator('[data-testid=sm-audit-expand]').first().click();
    await expect(page.locator('[data-testid=sm-audit-detail]')).toBeVisible();
    const before = (await calls(page, 'get_audit_trail')).length;
    await pollRefresh(page);
    await expect.poll(async () => (await calls(page, 'get_audit_trail')).length).toBeGreaterThan(before);
    await page.waitForFunction(() => !document.querySelector('[data-testid=sm-refreshing]'));
    await expect(page.locator('[data-testid=sm-audit-detail]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-audit-tool]')).toHaveCount(2);
  });

  test('while a refresh is in flight the header says Updating and the cards stay up', async ({ page }) => {
    await mount(page);
    // Registered after the mock: hold the overview fetch, then let the mock answer.
    await page.route('**/api/integration/execute/**', async (route) => {
      const op = (JSON.parse(route.request().postData() || '{}') || {}).operation;
      if (op === 'list_usage') await new Promise((r) => setTimeout(r, 1500));
      return route.fallback();
    });
    await pollRefresh(page);
    await expect(page.locator('[data-testid=sm-refreshing]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-card-turns]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-refreshing]')).toHaveCount(0, { timeout: 10000 });
  });
});

test.describe('agenticAssistantMonitor -- chrome', () => {

  test('Refresh re-issues the overview calls', async ({ page }) => {
    await mount(page);
    const before = (await calls(page, 'list_usage')).length;
    await page.locator('[data-testid=sm-refresh]').click();
    await expect.poll(async () => (await calls(page, 'list_usage')).length).toBeGreaterThan(before);
  });

  test('a connector failure surfaces the error banner, not a blank panel', async ({ page }) => {
    await page.route('**/api/integration/connectors/**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await seedSelection(page, CONFIG);
    await mountWidget(page, WIDGET_ID, { config: CONFIG });
    await expect(root(page).locator('[data-testid=sm-error]')).toBeVisible({ timeout: 15000 });
  });

  test('the widget body never scrolls horizontally at a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await mount(page);
    const overflow = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=soc-monitor-root]');
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

// ── Autonomy policy, shadow only ─────────────────────────────────────────────
// The go/no-go evidence for letting a rule act without a click. The column that
// matters is "would run it, rejected": it must read as a warning, and a row
// where the policy would have acted against the reviewer must stand out.
const SHADOW = {
  policy: { enabled: true, mode: 'shadow', rules: ['block-external-ip'] },
  rules: [{ rule: 'block-external-ip', would_act_approved: 3, would_act_rejected: 1,
            would_not_act_approved: 2, would_not_act_rejected: 0, undecided: 1 }],
  decisions: [
    { session_id: 's1', card_id: 'c2', at: 1785000000, summary: 'Block 203.0.113.9',
      connector: 'fortigate-firewall', operation: 'block_ip_new',
      policy: { rule: 'block-external-ip', outcome: 'would_act', failed: [] },
      human: 'reject', actor: 'lead' },
    { session_id: 's1', card_id: 'c3', at: 1784990000, summary: 'Block 198.51.100.2',
      connector: 'fortigate-firewall', operation: 'block_ip_new',
      policy: { rule: 'block-external-ip', outcome: 'would_not_act',
                failed: ['198.51.100.2 is an internal address'] },
      human: null, actor: null },
  ],
};

test.describe('agenticAssistantMonitor -- autonomy (shadow)', () => {
  // The readiness and tuning views are answered by the newer connector; with
  // them unavailable the tab keeps the shadow matrix and the raw close counts,
  // which is what these older-connector specs exercise.
  const withShadow = (shadow) => (op, params, base) => {
    if (op === 'monitor_cases' && (params.view === 'policy' || params.view === 'tuning')) {
      return { ok: false, error: { code: 'bad_view' } };
    }
    return op === 'list_shadow_decisions' ? shadow : base(op, params);
  };

  test('older connector: the shadow table pairs each rule with what reviewers decided', async ({ page }) => {
    await mount(page, CONFIG, { handle: withShadow(SHADOW) });
    await tab(page, 'autonomy').click();
    await expect(page.locator('[data-testid=sm-autonomy-policy]'))
      .toHaveText('The autonomy policy (1 rule) is recording only; every action still waits for a reviewer.');
    const rule = page.locator('[data-testid=sm-autonomy-rule]');
    await expect(rule.locator('[data-testid=sm-autonomy-rule-name]')).toHaveText('block-external-ip');
    await expect(rule.locator('[data-testid=sm-autonomy-agree]')).toHaveText('3');
    const miss = rule.locator('[data-testid=sm-autonomy-miss]');
    await expect(miss).toHaveText('1');
    await expect(miss).toHaveClass(/sm-badge-warn/);

    const rows = page.locator('[data-testid=sm-autonomy-decision]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveClass(/sm-row-warn/);
    await expect(rows.nth(0).locator('[data-testid=sm-autonomy-outcome]')).toHaveText('Would run it');
    await expect(rows.nth(0).locator('[data-testid=sm-autonomy-human]')).toHaveText('Rejected by lead');
    await expect(rows.nth(1)).not.toHaveClass(/sm-row-warn/);
    await expect(rows.nth(1).locator('[data-testid=sm-autonomy-outcome]')).toHaveText('Would ask');
    await expect(rows.nth(1).locator('[data-testid=sm-autonomy-reasons] li'))
      .toHaveText(['198.51.100.2 is an internal address']);
    await expect(rows.nth(1).locator('[data-testid=sm-autonomy-human]')).toHaveText('Not decided yet');
  });

  test('older connector: policy closes are counted per detection rule, reopens flagged', async ({ page }) => {
    const tuning = [
      { source: 'FortiSIEM', rule: 'Port scan from scanner subnet', closed: 3, reopened: 1,
        last_at: 1785000000 },
      { source: 'FortiEDR', rule: 'Suspicious Process', closed: 1, reopened: 0,
        last_at: 1784990000 },
      { source: '', rule: '', closed: 1, reopened: 0, last_at: 1784980000 },
    ];
    await mount(page, CONFIG, { handle: withShadow({ ...SHADOW, tuning }) });
    await tab(page, 'autonomy').click();
    const rows = page.locator('[data-testid=sm-autonomy-tuning-row]');
    await expect(rows).toHaveCount(3);
    const cells = (i, id) => rows.nth(i).locator(`[data-testid=sm-autonomy-tuning-${id}]`);
    const expected = [
      ['Port scan from scanner subnet', 'FortiSIEM', '3', '1', true],
      ['Suspicious Process', 'FortiEDR', '1', '0', false],
      ['Unnamed rule', 'Unknown source', '1', '0', false],
    ];
    for (const [i, [rule, source, closed, reopened, warn]] of expected.entries()) {
      await expect(cells(i, 'rule')).toHaveText(rule);
      await expect(cells(i, 'source')).toHaveText(source);
      await expect(cells(i, 'closed')).toHaveText(closed);
      await expect(cells(i, 'reopened')).toHaveText(reopened);
      if (warn) await expect(cells(i, 'reopened')).toHaveClass(/sm-badge-warn/);
      else await expect(cells(i, 'reopened')).not.toHaveClass(/sm-badge-warn/);
    }
    await expect(page.locator('[data-testid=sm-autonomy-tuning-note]')).toContainText('closed as false positives');
  });

  test('no policy closes, no tuning table', async ({ page }) => {
    await mount(page, CONFIG, { handle: withShadow(SHADOW) });
    await tab(page, 'autonomy').click();
    await expect(page.locator('[data-testid=sm-autonomy-rules]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-autonomy-tuning]')).toHaveCount(0);
  });

  test('the policy is authored with structured controls, never a JSON editor', async ({ page }) => {
    await mount(page, CONFIG, { handle: withShadow(SHADOW) });
    await tab(page, 'autonomy').click();
    await page.locator('[data-testid=sm-autonomy-edit]').click();
    // The policy-wide controls and a rule's own controls are plain form fields.
    await expect(page.locator('[data-testid=sm-autonomy-killswitch]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-autonomy-mode]')).toBeVisible();
    await page.locator('[data-testid=sm-autonomy-addrule]').click();
    await expect(page.locator('[data-testid=sm-autonomy-rule-action]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-autonomy-rule-confidence]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-autonomy-rule-disp]').first()).toBeVisible();
    await expect(page.locator('[data-testid=sm-autonomy-save]')).toBeVisible();
    // The old free-form JSON editor is gone.
    await expect(page.locator('[data-testid=sm-autonomy-editor-text]')).toHaveCount(0);
    await expect(page.locator('textarea.sm-policy-text')).toHaveCount(0);
  });

  test('with no policy it says every action waits for a reviewer', async ({ page }) => {
    await mount(page, CONFIG, { handle: withShadow({ rules: [], decisions: [], policy: null }) });
    await tab(page, 'autonomy').click();
    await expect(page.locator('[data-testid=sm-autonomy-policy]'))
      .toHaveText('No autonomy policy is set. Every action waits for a reviewer.');
    await expect(page.locator('[data-testid=sm-autonomy-empty]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-autonomy-rules]')).toHaveCount(0);
  });

  test('a policy that cannot be read says it is ignored', async ({ page }) => {
    await mount(page, CONFIG, { handle: withShadow({ rules: [], decisions: [],
      policy: { error: 'fsr_autonomy_policy is not valid JSON' } }) });
    await tab(page, 'autonomy').click();
    await expect(page.locator('[data-testid=sm-autonomy-policy]'))
      .toContainText('could not be read, so it is ignored');
  });

  test('Undo reverses an approved action that ran, once, and says who', async ({ page }) => {
    const ran = { session_id: 's1', card_id: 'c4', at: 1785000500, summary: 'Block 203.0.113.9',
      connector: 'fortigate-firewall', operation: 'block_ip_new',
      policy: { rule: 'block-external-ip', outcome: 'would_act', failed: [] },
      human: 'approve', actor: 'lead', executed: true, undone_at: null, undone_by: null,
      undo: { connector: 'fortigate-firewall', op: 'unblock_ip' } };
    const undoCalls = [];
    await mount(page, CONFIG, { handle: (op, params, base) => {
      if (op === 'list_shadow_decisions') return { ...SHADOW, decisions: [ran, ...SHADOW.decisions] };
      if (op === 'undo_action') { undoCalls.push(params); return { ok: true, session_id: 's1', card_id: 'c4' }; }
      return base(op, params);
    } });
    await tab(page, 'autonomy').click();
    const rows = page.locator('[data-testid=sm-autonomy-decision]');
    await expect(rows).toHaveCount(3);
    // Only the approved action that ran offers Undo; a rejected or undecided row does not.
    await expect(rows.nth(0).locator('[data-testid=sm-autonomy-undo]')).toHaveText('Undo');
    await expect(rows.nth(1).locator('[data-testid=sm-autonomy-undo]')).toHaveCount(0);
    await expect(rows.nth(2).locator('[data-testid=sm-autonomy-undo]')).toHaveCount(0);
    await rows.nth(0).locator('[data-testid=sm-autonomy-undo]').click();
    await expect(rows.nth(0).locator('[data-testid=sm-autonomy-undone]')).toContainText('Undone');
    await expect(rows.nth(0).locator('[data-testid=sm-autonomy-undo]')).toHaveCount(0);
    expect(undoCalls.map((p) => [p.session_id, p.card_id])).toEqual([['s1', 'c4']]);
  });

  test('an action the policy ran itself reads as run by the policy, and can be undone', async ({ page }) => {
    const ran = { session_id: 'auto:alerts:u9', card_id: 'c9', at: 1785000900, summary: 'Block 198.51.100.7',
      connector: 'fortigate-firewall', operation: 'block_ip_new',
      policy: { rule: 'block-external-ip', outcome: 'would_act', mode: 'enforced', failed: [] },
      human: 'approve', actor: 'system:autonomy', executed: true, undone_at: null,
      undo: { connector: 'fortigate-firewall', op: 'unblock_ip' } };
    await mount(page, CONFIG, { handle: (op, params, base) => (op === 'list_shadow_decisions'
      ? { ...SHADOW, policy: { enabled: true, mode: 'enforce', rules: ['block-external-ip'] }, decisions: [ran] }
      : base(op, params)) });
    await tab(page, 'autonomy').click();
    await expect(page.locator('[data-testid=sm-autonomy-policy]'))
      .toHaveText('The autonomy policy (1 rule) acts on its own in unattended triage; chats still wait for a reviewer.');
    const row = page.locator('[data-testid=sm-autonomy-decision]').nth(0);
    await expect(row.locator('[data-testid=sm-autonomy-outcome]')).toHaveText('Ran it');
    await expect(row.locator('[data-testid=sm-autonomy-human]')).toHaveText('Run by the policy, no reviewer');
    await expect(row.locator('[data-testid=sm-autonomy-undo]')).toHaveText('Undo');
  });

  test('an undo that failed says why and can be tried again', async ({ page }) => {
    const ran = { session_id: 's1', card_id: 'c4', at: 1785000500, summary: 'Block 203.0.113.9',
      connector: 'fortigate-firewall', operation: 'block_ip_new',
      policy: { rule: 'block-external-ip', outcome: 'would_act', failed: [] },
      human: 'approve', actor: 'lead', executed: true, undone_at: null,
      undo: { connector: 'fortigate-firewall', op: 'unblock_ip' } };
    await mount(page, CONFIG, { handle: (op, params, base) => {
      if (op === 'list_shadow_decisions') return { ...SHADOW, decisions: [ran] };
      if (op === 'undo_action') return { ok: false, error: { code: 'undo_failed',
        message: 'The FortiGate did not answer.' } };
      return base(op, params);
    } });
    await tab(page, 'autonomy').click();
    const row = page.locator('[data-testid=sm-autonomy-decision]').nth(0);
    await row.locator('[data-testid=sm-autonomy-undo]').click();
    await expect(row.locator('[data-testid=sm-autonomy-undo-note]')).toHaveText('The FortiGate did not answer.');
    await expect(row.locator('[data-testid=sm-autonomy-undo]')).toBeEnabled();
  });

  test('a failed fetch says so instead of "nothing checked yet"', async ({ page }) => {
    await mount(page);
    await page.route('**/api/integration/execute/**', (route) => {
      const op = (JSON.parse(route.request().postData() || '{}') || {}).operation;
      return op === 'list_shadow_decisions'
        ? route.fulfill({ status: 502, contentType: 'application/json', body: '{"message":"Bad gateway"}' })
        : route.fallback();
    });
    await tab(page, 'autonomy').click();
    await expect(page.locator('[data-testid=sm-autonomy-failed]')).toBeVisible();
    await expect(page.locator('[data-testid=sm-autonomy-empty]')).toHaveCount(0);
  });

  const DOC = {
    version: 1, enabled: true, mode: 'shadow',
    rules: [{
      id: 'block-external-ip',
      action: { connector: 'fortigate-firewall', op: 'block_ip' },
      when: { verdict: { disposition: ['true_positive'], min_confidence: 0.9 },
              target: { kind: 'ip', external_only: true, not_in: 'protected_ips' } },
      limits: { per_hour: 10, per_target_per_day: 1 },
    }],
  };
  const withPolicy = (setRes) => (op, params, base) => {
    if (op === 'list_shadow_decisions') return { ...SHADOW, policy_document: DOC };
    if (op === 'get_autonomy_policy') return { ok: true, policy: DOC, valid: true };
    if (op === 'set_autonomy_policy') return setRes;
    return base(op, params);
  };

  test('the policy is shown in plain words and edited with the structured builder', async ({ page }) => {
    await mount(page, CONFIG, { handle: withPolicy({ ok: true, policy: DOC }) });
    await tab(page, 'autonomy').click();
    const def = page.locator('[data-testid=sm-autonomy-rule-def]');
    await expect(def.locator('td').nth(1)).toHaveText('Block an IP on FortiGate');
    await expect(def.locator('td').nth(2)).toContainText('verdict true positive at 90%+');
    await page.locator('[data-testid=sm-autonomy-edit]').click();
    // The stored rule loaded into the form (no JSON): its name is in the input,
    // and the unknown-to-presets block op was preserved, not dropped.
    await expect(page.locator('[data-testid=sm-autonomy-rule-id]')).toHaveValue('block-external-ip');
    await expect(page.locator('[data-testid=sm-autonomy-editor-text]')).toHaveCount(0);
    // Promote the policy to enforce and save.
    await page.locator('[data-testid=sm-autonomy-mode]').selectOption({ label: 'Enforce (act on its own)' });
    await page.locator('[data-testid=sm-autonomy-save]').click();
    await expect(page.locator('[data-testid=sm-autonomy-editor]')).toHaveCount(0);
    await expect(page.locator('[data-testid=sm-autonomy-saved]')).toBeVisible();
    const sent = await lastCall(page, 'set_autonomy_policy');
    expect(sent.params.policy.mode).toBe('enforce');
    expect(sent.params.policy.rules[0].id).toBe('block-external-ip');
    expect(sent.params.policy.rules[0].action).toEqual({ connector: 'fortigate-firewall', op: 'block_ip' });
  });

  test('a reviewer-gated refusal shows its message and keeps the editor open', async ({ page }) => {
    await mount(page, CONFIG, { handle: withPolicy(
      { ok: false, error: { code: 'not_authorized', message: 'Only reviewers can edit the autonomy policy.' } }) });
    await tab(page, 'autonomy').click();
    await page.locator('[data-testid=sm-autonomy-edit]').click();
    await page.locator('[data-testid=sm-autonomy-save]').click();
    await expect(page.locator('[data-testid=sm-autonomy-editor-error]'))
      .toHaveText('Only reviewers can edit the autonomy policy.');
    await expect(page.locator('[data-testid=sm-autonomy-editor]')).toBeVisible();
  });
});
