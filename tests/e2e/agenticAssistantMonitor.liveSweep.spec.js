'use strict';
// ───────────────────────────────────────────────────────────────────────────
// LIVE sweep for the Agentic Assistant Monitor: the source widget in the local
// harness, its connector calls proxied to the box in SWEEP_ENV. This is the
// live gate `make ship-verify WIDGET=agenticAssistantMonitor` runs.
//
// Read-only by default. Rows 1-3 load the real data and check it renders the
// way a reviewer reads it; they never click Approve, Reject or Resolve, because
// every item in a real queue is someone's real decision.
//
// Row 4 is opt-in (ESCALATION=1) because it writes and spends: it installs the
// auto-triage trigger filtered to its own test source, creates one alert (one
// LLM triage turn), resolves the escalation in the UI, reads the decision back
// on the box, then disables the trigger and deletes the alert.
//
//   make test-live-sweep WIDGET=agenticAssistantMonitor [SWEEP_ENV=.env.81] [ESCALATION=1]
//
// Each row prints one  [[SWEEP]] {json}  line; a box that is down or has no
// connector prints [[SWEEP-ENV-SKIP]] and grades nothing.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');
const { makeClient } = require('../../../../fortisoar-widget-harness/tests/live/lib/soarClient');

const LIVE = process.env.FSRPB_LIVE_UI === '1';
const ESCALATION = process.env.ESCALATION === '1';
const d = LIVE ? test.describe : test.describe.skip;

// The source build, never a packaged copy with the same name (see the
// features spec for why the bare name is ambiguous).
const WIDGET_ID = 'agenticAssistantMonitor-' + require('../../widget/info.json').version;
const CONFIG = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 600 };
const TEST_SOURCE = 'monitor-sweep';

let SOAR = null;
let ENV_OK = true;
let ENV_MSG = '';

test.beforeAll(async () => {
  if (!LIVE) return;
  try {
    SOAR = await makeClient();
    const h = await SOAR.exec('health_check', {}, { timeoutMs: 30000 });
    if (!h || h.ok === false) {
      ENV_OK = false;
      ENV_MSG = 'connector health_check not ok: ' + JSON.stringify(h).slice(0, 200);
    }
  } catch (e) {
    ENV_OK = false;
    ENV_MSG = String((e && e.message) || e).slice(0, 200);
  }
  if (!ENV_OK) console.warn('[[SWEEP-ENV-SKIP]] ' + ENV_MSG);
});

test.beforeEach(() => {
  test.skip(LIVE && !ENV_OK, 'ENV: connector unavailable -- ' + ENV_MSG);
});

function attachCapture(page) {
  const cap = { consoleErrors: [], pageErrors: [], apiFailures: [] };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (/favicon|ResizeObserver loop/i.test(t)) return;
    cap.consoleErrors.push(t.slice(0, 400));
  });
  page.on('pageerror', (err) => cap.pageErrors.push(String((err && err.message) || err).slice(0, 400)));
  // A request that never answered (the proxy dropped it) logs only a bare
  // "Failed to load resource"; name the URL so a panel showing "empty" can be
  // told apart from a panel whose fetch died.
  page.on('requestfailed', (req) => {
    cap.apiFailures.push('FAILED ' + ((req.failure() && req.failure().errorText) || '') + ' '
      + req.method() + ' ' + req.url().replace(/https?:\/\/[^/]+/, '').slice(0, 160)
      + ' ' + ((req.postData() || '').match(/"operation":"([a-z_]+)"/) || [])[1]);
  });
  page.on('response', (resp) => {
    try {
      if (resp.status() >= 400 && /\/api\//.test(resp.url())) {
        cap.apiFailures.push(resp.status() + ' ' + resp.url().replace(/https?:\/\/[^/]+/, '').slice(0, 160));
      }
    } catch (_) { /* ignore */ }
  });
  return cap;
}

function report(label, cap, extra) {
  const summary = Object.assign({ scenario: label, consoleErrors: cap.consoleErrors,
    pageErrors: cap.pageErrors, apiFailures: cap.apiFailures.slice(0, 12) }, extra || {});
  console.log('[[SWEEP]] ' + JSON.stringify(summary));
  return summary;
}

async function boot(page) {
  await page.addInitScript(([id, cfg]) => {
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness:config:' + id, JSON.stringify(cfg));
  }, [WIDGET_ID, CONFIG]);
  await mountWidget(page, WIDGET_ID, { config: CONFIG });
  await page.locator('[data-testid=sm-queue]').waitFor({ timeout: 60000 });
  await page.locator('[data-testid=sm-tab-overview]').click();
  await page.locator('[data-testid=sm-card-turns]').waitFor({ timeout: 60000 });
}

const tab = (page, name) => page.locator(`[data-testid=sm-tab-${name}]`);

// What a reviewer must never see: a value that failed to resolve. Read from
// the rendered text, so a binding that broke on real data (a field the
// connector returns in another shape) shows up here. Text the box holds is
// not scanned -- prompts, responses, tool params and results, verdict
// summaries, field values: on a device-automation box it is full of Jinja, and FortiOS
// itself reports an interface role as the string "undefined". Braces are not
// checked for the same reason.
async function brokenText(page) {
  const text = await page.evaluate(() => {
    const root = document.querySelector('[data-testid=soc-monitor-root]').cloneNode(true);
    root.querySelectorAll(['pre', 'code', '[data-testid=sm-turn-detail-overlay]', '.sm-sess-prompt',
      '.sm-truncate', '.sm-tool-result', '[data-testid=sm-esc-summary]', '.sm-pending-changes']
      .join(',')).forEach((n) => n.remove());
    return root.innerText || root.textContent || '';
  });
  // Each hit with the text around it, so a failure says where to look.
  return (text.match(/.{0,50}(\bundefined\b|\bNaN\b|\[object Object\]).{0,30}/g) || [])
    .map((s) => s.replace(/\s+/g, ' ').trim()).slice(0, 8);
}

// A panel has settled when its loading row is gone and it shows rows, its
// empty state, or (sessions/scheduled/audit) that its fetch failed.
async function settle(page, name) {
  await expect(page.locator(`[data-testid=sm-${name}-loading]`)).toHaveCount(0, { timeout: 45000 });
  const rows = page.locator(`[data-testid=sm-${name}-row]`);
  const empty = page.locator(`[data-testid=sm-${name}-empty]`);
  const failed = page.locator(`[data-testid=sm-${name}-failed]`);
  await expect(rows.or(empty).or(failed).first()).toBeVisible({ timeout: 45000 });
  return { rows: await rows.count(), empty: await empty.count() > 0, failed: await failed.count() > 0 };
}

d('LIVE Agentic Assistant Monitor sweep', () => {
  test.describe.configure({ mode: 'serial' });

  test('1 overview loads the box\'s real usage with no error', async ({ page }) => {
    const cap = attachCapture(page);
    await boot(page);
    const banner = await page.locator('[data-testid=sm-error]').count();
    const cards = {};
    for (const k of ['turns', 'tokens', 'cost', 'pending']) {
      cards[k] = (await page.locator(`[data-testid=sm-card-${k}] .sm-card-value`).innerText()).trim();
    }
    const broken = await brokenText(page);
    const r = report('1-overview', cap, { banner, cards, broken });
    expect.soft(banner, 'no error banner').toBe(0);
    for (const [k, v] of Object.entries(cards)) expect.soft(v, `${k} card shows a number`).toMatch(/\d/);
    expect.soft(broken, 'no unresolved text').toEqual([]);
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
  });

  test('2 every tab renders its real rows or an honest empty state', async ({ page }) => {
    const cap = attachCapture(page);
    await boot(page);
    const panels = {};
    for (const name of ['sessions', 'users', 'scheduled', 'audit']) {
      await tab(page, name).click();
      panels[name] = await settle(page, name);
    }
    // A real audit row opens its turn detail (read-only).
    let detailOpened = null;
    if (panels.audit.rows > 0) {
      await tab(page, 'audit').click();
      await page.locator('[data-testid=sm-audit-detail-btn]').first().click();
      detailOpened = await page.locator('[data-testid=sm-turn-detail-overlay]').count() > 0;
    }
    const broken = await brokenText(page);
    const r = report('2-tabs', cap, { panels, detailOpened, broken });
    for (const [name, p] of Object.entries(panels)) expect.soft(p.failed, `${name} loaded`).toBe(false);
    expect.soft(broken, 'no unresolved text').toEqual([]);
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    if (detailOpened !== null) expect.soft(detailOpened, 'an audit row opens its turn detail').toBe(true);
  });

  test('3 the Pending tab shows the box\'s real queue as a reviewer reads it', async ({ page }) => {
    const cap = attachCapture(page);
    const truth = await SOAR.exec('list_pending', {}, { timeoutMs: 60000 });
    const escalations = (truth && truth.escalations) || [];
    const pending = (truth && truth.pending) || [];
    const escalated = new Set(escalations.map((e) => e.session_id));
    const plain = pending.filter((p) => !escalated.has(p.session_id));
    await boot(page);
    await tab(page, 'pending').click();
    const escRows = page.locator('[data-testid=sm-esc-row]');
    const approvalRows = page.locator('[data-testid=sm-pending-row]');
    // Both lists come from the same call, so the queue can only move between
    // the read above and the render; a mismatch on a quiet box is a bug.
    const shown = { escalations: await escRows.count(), approvals: await approvalRows.count() };
    const blankTitles = [];
    for (const t of await page.locator('[data-testid=sm-esc-title], [data-testid=sm-pending-title]').allInnerTexts()) {
      if (!t.trim()) blankTitles.push(t);
    }
    const priorities = await page.locator('[data-testid=sm-esc-priority]').allInnerTexts();
    const empty = await page.locator('[data-testid=sm-pending-empty]').count() > 0;
    const broken = await brokenText(page);
    const r = report('3-pending', cap, { onBox: { escalations: escalations.length, approvals: plain.length },
      shown, priorities, empty, blankTitles, broken });
    expect.soft(shown.escalations, 'every open escalation is listed').toBe(escalations.length);
    expect.soft(shown.approvals, 'every approval not under an escalation is listed').toBe(plain.length);
    expect.soft(empty, 'the empty state shows only when nothing is queued')
      .toBe(escalations.length === 0 && pending.length === 0);
    for (const p of priorities) expect.soft(p, 'priority reads P1..P4').toMatch(/^P[1-4]$/);
    expect.soft(blankTitles, 'every row says what it is').toEqual([]);
    expect.soft(broken, 'no unresolved text').toEqual([]);
    expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
  });

  test('4 a reviewer resolves a fresh auto-triage escalation (ESCALATION=1)', async ({ page }) => {
    test.skip(!ESCALATION, 'opt-in: writes an alert and spends one triage turn (ESCALATION=1)');
    test.setTimeout(900000);
    const cap = attachCapture(page);
    const config = SOAR.meta.configName;
    const created = [];
    let esc = null;
    let name = '';
    try {
      const set = await SOAR.exec('set_auto_triage', { agent_config: config, sources: [TEST_SOURCE] },
        { timeoutMs: 180000 });
      expect(set && set.ok, 'auto-triage trigger installed').toBe(true);
      const sev = await SOAR.get('/api/3/picklist_names?name=Severity&$relationships=true');
      const high = (((sev['hydra:member'] || [])[0] || {}).picklists || []).find((p) => p.itemValue === 'High');
      expect(high, 'the box has a High severity').toBeTruthy();
      // Two tries: a turn that reaches a clear verdict on its own needs nobody.
      for (let attempt = 1; attempt <= 2 && !esc; attempt++) {
        name = `Outbound beacon from 198.51.100.3${attempt} to 203.0.113.7${attempt} (monitor sweep)`;
        const rec = await SOAR.post('/api/3/alerts', { name, severity: high['@id'], source: TEST_SOURCE,
          sourceIp: `203.0.113.7${attempt}`, description: 'Seeded by the Monitor live sweep.' });
        expect(rec.status, 'test alert created').toBeLessThan(300);
        created.push(rec.json['@id']);
        const sid = 'auto:alerts:' + rec.json.uuid;
        const until = Date.now() + 300000;
        while (Date.now() < until && !esc) {
          await page.waitForTimeout(15000);
          const q = await SOAR.exec('list_pending', {}, { timeoutMs: 60000 });
          esc = ((q && q.escalations) || []).find((e) => e.session_id === sid) || null;
          if (!esc) {
            const h = await SOAR.exec('chat_history', { session_id: sid }, { timeoutMs: 60000 });
            const finished = ((h && h.turns) || []).some((t) => t.transcript);
            if (finished && Date.now() > until - 240000) break;
          }
        }
      }
      expect(esc, 'a seeded alert was escalated').toBeTruthy();

      await boot(page);
      await tab(page, 'pending').click();
      const row = page.locator('[data-testid=sm-esc-row]', { hasText: name });
      await expect(row).toHaveCount(1);
      await expect(row.locator('[data-testid=sm-esc-priority]')).toHaveText(esc.priority);
      await expect(row.locator('[data-testid=sm-esc-reasons] li')).toHaveText(esc.reasons);
      const resolved = page.waitForResponse((r) => r.url().includes('/api/integration/execute')
        && (r.request().postData() || '').includes('resolve_escalation'));
      await row.locator('[data-testid=sm-esc-handled]').click();
      const body = await (await resolved).json();
      await expect(row).toHaveCount(0);

      const after = await SOAR.exec('list_pending', {}, { timeoutMs: 60000 });
      const stillQueued = ((after && after.escalations) || []).some((e) => e.card_id === esc.card_id);
      const again = await SOAR.exec('resolve_escalation', { session_id: esc.session_id, card_id: esc.card_id,
        outcome: 'dismissed' }, { timeoutMs: 60000 });
      const r = report('4-escalation', cap, { priority: esc.priority, reasons: esc.reasons,
        resolve: body && body.data, stillQueued, second: again && again.error && again.error.code });
      expect.soft(body && body.data && body.data.ok, 'the UI resolve was accepted').toBe(true);
      expect.soft(stillQueued, 'the box no longer queues it').toBe(false);
      expect.soft(again && again.error && again.error.code, 'a second answer is refused').toBe('already_decided');
      expect.soft(r.pageErrors, 'no uncaught JS').toEqual([]);
    } finally {
      await SOAR.exec('set_auto_triage', { agent_config: config, sources: [TEST_SOURCE], enabled: false },
        { timeoutMs: 180000 }).catch(() => {});
      for (const iri of created) await SOAR.del(iri).catch(() => {});
    }
  });
});
