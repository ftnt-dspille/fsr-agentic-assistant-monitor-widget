'use strict';
// Monitor revamp phase B: the handled-cases queue (M1) as the default tab, the
// outcome tiles (M2) and right/wrong feedback (M3), against the connector mock
// (_monitorMock.js answers monitor_cases / monitor_feedback with the live
// contract). The real service, controller and templates are in the loop.
//
//   make test-e2e-spec SPEC=agenticAssistantMonitor.queue

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');
const { installMonitorMock, calls, lastCall, CASES, failFeedback, withEscalation } = require('./_monitorMock');

const CONFIG = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 600 };
const WIDGET_ID = 'agenticAssistantMonitor-' + require('../../widget/info.json').version;

async function mount(page, { width, handle } = {}) {
  if (width) await page.setViewportSize({ width, height: 900 });
  await installMonitorMock(page, handle ? { handle } : {});
  await page.addInitScript(([id, cfg]) => {
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness:config:' + id, JSON.stringify(cfg));
  }, [WIDGET_ID, CONFIG]);
  await mountWidget(page, WIDGET_ID, { config: CONFIG });
  await page.locator('[data-testid=sm-queue]').waitFor({ timeout: 15000 });
}

const row = (page, name) => page.locator('[data-testid=sm-queue-row]').filter({ hasText: name });
const rowsOf = (keys) => CASES.filter((c) => keys.includes(c.key));
const T = (page, id) => page.locator(`[data-testid=${id}]`);

// What a row must show for a fixture case, word for word.
async function expectRow(page, c) {
  const r = row(page, c.record_name);
  await expect(r).toHaveCount(1);
  await expect(r.locator('[data-testid=sm-queue-case]')).toHaveText(c.record_name);
  await expect(r.locator('[data-testid=sm-queue-verdict]')).toHaveText(c.verdict);
  await expect(r.locator('[data-testid=sm-queue-conf]')).toHaveText(c.confidence == null ? '-' : Math.round(c.confidence * 100) + '%');
  await expect(r.locator('[data-testid=sm-queue-sources]')).toHaveText(c.sources.join(', '));
  await expect(r.locator('[data-testid=sm-queue-action]')).toHaveText(c.action);
  await expect(r.locator('[data-testid=sm-queue-kind]')).toHaveText(
    { taken: 'Done', would_have: 'Not run (shadow mode)', escalated: 'Waiting for you', none: 'No action' }[c.action_kind]);
  const uuid = c.record_iri.split('/').pop();
  await expect(r.locator('a[data-testid=sm-queue-case]')).toHaveAttribute('href', `#/main/modules/${c.record_module}/${uuid}`);
  if (c.group_size > 1) await expect(r.locator('[data-testid=sm-queue-group]')).toHaveText(`, +${c.group_size - 1} related`);
  else await expect(r.locator('[data-testid=sm-queue-group]')).toHaveCount(0);
}

test.describe('agenticAssistantMonitor -- handled cases queue', () => {
  test('the queue is the default tab, on the handled bucket for the last 24 hours', async ({ page }) => {
    await mount(page);
    await expect(T(page, 'sm-tab-queue')).toHaveClass(/active/);
    await expect(T(page, 'sm-queue-tab-handled')).toHaveClass(/active/);
    await expect(T(page, 'sm-queue-window')).toHaveValue('number:24');
    const list = (await calls(page, 'monitor_cases')).filter((c) => c.params.view === 'list');
    expect(list[0].params).toEqual({ view: 'list', bucket: 'handled', hours: 24, limit: 50 });
    // The old usage chart lives on its own tab now.
    await expect(T(page, 'sm-overview-chart')).toHaveCount(0);
    await T(page, 'sm-tab-overview').click();
    await expect(T(page, 'sm-overview-chart')).toBeVisible();
  });

  test('bucket tabs carry whole-window counts and each lists exactly its cases, newest first', async ({ page }) => {
    await mount(page);
    await expect(T(page, 'sm-queue-tab-handled')).toHaveText('Handled for you (3)');
    await expect(T(page, 'sm-queue-tab-needs_you')).toHaveText('Needs you (2)');
    await expect(T(page, 'sm-queue-tab-reopened')).toHaveText('Reopened (1)');
    await expect(T(page, 'sm-tab-queue')).toContainText('2'); // the Cases tab flags what needs you

    for (const [bucket, keys] of [['handled', ['H1', 'H2', 'H3']], ['needs_you', ['N1', 'N2']], ['reopened', ['R1']]]) {
      await T(page, `sm-queue-tab-${bucket}`).click();
      await expect(T(page, `sm-queue-tab-${bucket}`)).toHaveClass(/active/);
      await expect(T(page, 'sm-queue-row')).toHaveCount(keys.length);
      // newest first
      await expect(T(page, 'sm-queue-case')).toHaveText(rowsOf(keys).map((c) => c.record_name));
      for (const c of rowsOf(keys)) await expectRow(page, c);
      expect((await calls(page, 'monitor_cases')).filter((c) => c.params.view === 'list').pop().params)
        .toEqual({ view: 'list', bucket, hours: 24, limit: 50 });
      // counts stay put while another bucket is on screen
      await expect(T(page, 'sm-queue-tab-handled')).toHaveText('Handled for you (3)');
    }
  });

  test('a row says when it happened, what it shows when confidence is missing, and why', async ({ page }) => {
    await mount(page);
    await expect(row(page, 'Outbound beacon').locator('[data-testid=sm-queue-when]')).toHaveText('5m ago');
    await expect(row(page, 'Login burst').locator('[data-testid=sm-queue-when]')).toHaveText('2h ago');
    await T(page, 'sm-queue-tab-needs_you').click();
    await expect(row(page, 'Phish report').locator('[data-testid=sm-queue-conf]')).toHaveText('-');
    await row(page, 'Phish report').locator('[data-testid=sm-queue-more]').click();
    await expect(row(page, 'Phish report').locator('[data-testid=sm-queue-reason]')).toHaveText(['The mail gateway was not checked.']);
    await T(page, 'sm-queue-tab-handled').click();
    await row(page, 'Outbound beacon').locator('[data-testid=sm-queue-more]').click();
    await expect(row(page, 'Outbound beacon').locator('[data-testid=sm-queue-reason]')).toHaveText(CASES[0].reasons);
  });

  test('the time window reaches the list and the tiles, and widens the queue', async ({ page }) => {
    await mount(page);
    await expect(row(page, 'Nightly backup warning')).toHaveCount(0);
    await T(page, 'sm-queue-window').selectOption({ label: 'Last 3 days' });
    await expect(row(page, 'Nightly backup warning')).toHaveCount(1);
    await expectRow(page, CASES.find((c) => c.key === 'H4'));
    await expect(T(page, 'sm-queue-tab-handled')).toHaveText('Handled for you (4)');
    await expect(T(page, 'sm-kpi-handled-value')).toHaveText('4');
    await expect(T(page, 'sm-kpi-handled')).toContainText('last 3 days');
    expect((await lastCall(page, 'monitor_cases')).params.hours).toBe(72);
    const kpiCalls = (await calls(page, 'monitor_cases')).filter((c) => c.params.view === 'kpis');
    expect(kpiCalls[kpiCalls.length - 1].params).toEqual({ view: 'kpis', hours: 72 });
  });

  test('empty and failed buckets say so instead of showing a blank list', async ({ page }) => {
    await mount(page, { handle: (op, params, base) => {
      if (op === 'monitor_cases' && params.view === 'list' && params.bucket === 'reopened') {
        return { ok: true, view: 'list', hours: 24, bucket: 'reopened', total: 0, counts: { handled: 3, needs_you: 2, reopened: 0 }, rows: [] };
      }
      if (op === 'monitor_cases' && params.view === 'list' && params.bucket === 'needs_you') {
        return { ok: false, error: { code: 'bad_bucket' } };
      }
      return base(op, params);
    } });
    await T(page, 'sm-queue-tab-reopened').click();
    await expect(T(page, 'sm-queue-empty')).toHaveText('No handled case was reopened in this window');
    await T(page, 'sm-queue-tab-needs_you').click();
    await expect(T(page, 'sm-queue-failed')).toContainText('The handled cases could not be loaded.');
    await expect(T(page, 'sm-queue-empty')).toHaveCount(0);
  });
});

test.describe('agenticAssistantMonitor -- outcome tiles', () => {
  test('the tiles show the outcome numbers and the usage tiles are gone from the front', async ({ page }) => {
    await mount(page);
    await expect(T(page, 'sm-kpi-handled-value')).toHaveText('3');
    await expect(T(page, 'sm-kpi-auto-closed-value')).toHaveText('2');
    await expect(T(page, 'sm-kpi-escalated-value')).toHaveText('1');
    await expect(T(page, 'sm-kpi-escalated')).toContainText('2 still waiting');
    await expect(T(page, 'sm-kpi-reopened-value')).toHaveText('1');
    await expect(T(page, 'sm-kpi-agreement-value')).toHaveText('93% (27 rated)');
    await expect(T(page, 'sm-card-turns')).toHaveCount(0);
    await expect(T(page, 'sm-card-tokens')).toHaveCount(0);
    await expect(T(page, 'sm-card-cost')).toHaveCount(0);
    // The footer repeats agreement and reopened, and carries cost.
    await expect(T(page, 'sm-footer-agreement')).toHaveText('93% (27 rated)');
    await expect(T(page, 'sm-footer-reopened')).toHaveText('1');
    await expect(T(page, 'sm-footer-cost')).toHaveText('$0.84');
    // Usage keeps its own tiles.
    await T(page, 'sm-tab-overview').click();
    // (The turns figure itself is covered by the features spec.)
    await expect(T(page, 'sm-card-turns')).toBeVisible();
    await expect(T(page, 'sm-card-pending')).toBeVisible();
    await expect(T(page, 'sm-card-cost').locator('.sm-card-value')).toHaveText('$0.06');
  });

  test('with no ratings the agreement tile says so', async ({ page }) => {
    await mount(page, { handle: (op, params, base) => {
      const res = base(op, params);
      if (op === 'monitor_cases' && params.view === 'kpis') {
        return { ...res, kpis: { ...res.kpis, rated: 0, right: 0, wrong: 0, agreement: null, cost_today_usd: null } };
      }
      return res;
    } });
    await expect(T(page, 'sm-kpi-agreement-value')).toHaveText('No ratings yet');
    await expect(T(page, 'sm-footer-cost')).toHaveText('not available');
  });
});

test.describe('agenticAssistantMonitor -- right / wrong feedback', () => {
  test('wrong sends the record and rating, the row shows the read-back, and the tile follows', async ({ page }) => {
    await mount(page);
    const h1 = row(page, 'Outbound beacon');
    await expect(h1.locator('[data-testid=sm-queue-wrong]')).toHaveAttribute('aria-pressed', 'false');
    await h1.locator('[data-testid=sm-queue-wrong]').click();
    await expect(h1.locator('[data-testid=sm-queue-wrong]')).toHaveAttribute('aria-pressed', 'true');
    // The count is the connector's read-back (mine plus a colleague's), not my own click.
    await expect(h1.locator('[data-testid=sm-queue-wrong-count]')).toHaveText('2');
    await expect(h1.locator('[data-testid=sm-queue-right]')).toHaveAttribute('aria-pressed', 'false');
    const sent = await lastCall(page, 'monitor_feedback');
    expect(sent.params).toMatchObject({ record: CASES[0].record_iri, rating: 'wrong' });
    expect(sent.params.note).toBeUndefined();
    // 25 right / 4 wrong
    await expect(T(page, 'sm-kpi-agreement-value')).toHaveText('86% (29 rated)');
    // The read-back survives a reload of the queue.
    await T(page, 'sm-refresh').click();
    await expect(row(page, 'Outbound beacon').locator('[data-testid=sm-queue-wrong]')).toHaveAttribute('aria-pressed', 'true');
    // Switching to right moves the rating, it does not add one.
    await row(page, 'Outbound beacon').locator('[data-testid=sm-queue-right]').click();
    await expect(row(page, 'Outbound beacon').locator('[data-testid=sm-queue-right]')).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page, 'Outbound beacon').locator('[data-testid=sm-queue-wrong-count]')).toHaveText('1');
    expect((await lastCall(page, 'monitor_feedback')).params).toMatchObject({ record: CASES[0].record_iri, rating: 'right' });
    await expect(T(page, 'sm-kpi-agreement-value')).toHaveText('90% (29 rated)');
    // Clicking the same button again clears it.
    await row(page, 'Outbound beacon').locator('[data-testid=sm-queue-right]').click();
    await expect(row(page, 'Outbound beacon').locator('[data-testid=sm-queue-right]')).toHaveAttribute('aria-pressed', 'false');
    expect((await lastCall(page, 'monitor_feedback')).params).toMatchObject({ record: CASES[0].record_iri, rating: '' });
    await expect(T(page, 'sm-kpi-agreement-value')).toHaveText('89% (28 rated)');
  });

  test('an earlier rating of mine and the others counts show on the row', async ({ page }) => {
    await mount(page);
    const h3 = row(page, 'New CDN host');
    await expect(h3.locator('[data-testid=sm-queue-right]')).toHaveAttribute('aria-pressed', 'true');
    await expect(h3.locator('[data-testid=sm-queue-right-count]')).toHaveText('2');
    await expect(h3.locator('[data-testid=sm-queue-wrong]')).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page, 'Login burst').locator('[data-testid=sm-queue-right]')).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page, 'Login burst').locator('[data-testid=sm-queue-right-count]')).toHaveText('1');
    await h3.locator('[data-testid=sm-queue-more]').click();
    await expect(h3.locator('[data-testid=sm-queue-note]')).toHaveValue('Matches what I saw.');
  });

  test('a note is sent with the rating and read back', async ({ page }) => {
    await mount(page);
    const h2 = row(page, 'Login burst');
    await h2.locator('[data-testid=sm-queue-more]').click();
    // Rate first: the note box is locked until then.
    await expect(h2.locator('[data-testid=sm-queue-note]')).toBeDisabled();
    await h2.locator('[data-testid=sm-queue-right]').click();
    await expect(h2.locator('[data-testid=sm-queue-note]')).toBeEnabled();
    await h2.locator('[data-testid=sm-queue-note]').fill('Same address as last week.');
    await h2.locator('[data-testid=sm-queue-note-save]').click();
    await expect(h2.locator('[data-testid=sm-queue-note-saved]')).toHaveText('Saved');
    expect((await lastCall(page, 'monitor_feedback')).params)
      .toMatchObject({ record: CASES[1].record_iri, rating: 'right', note: 'Same address as last week.' });
    await T(page, 'sm-refresh').click();
    await row(page, 'Login burst').locator('[data-testid=sm-queue-more]').click();
    await expect(row(page, 'Login burst').locator('[data-testid=sm-queue-note]')).toHaveValue('Same address as last week.');
  });

  test('a refused write reverts the row and says so in plain words', async ({ page }) => {
    await mount(page);
    failFeedback('no_analyst');
    const h2 = row(page, 'Login burst');
    await h2.locator('[data-testid=sm-queue-wrong]').click();
    await expect(h2.locator('[data-testid=sm-queue-feedback-error]'))
      .toHaveText('Your account is not set up to rate decisions, so nothing was saved.');
    await expect(h2.locator('[data-testid=sm-queue-wrong]')).toHaveAttribute('aria-pressed', 'false');
    await expect(h2.locator('[data-testid=sm-queue-wrong-count]')).toHaveCount(0);
    await expect(h2.locator('[data-testid=sm-queue-right-count]')).toHaveText('1');
    await expect(T(page, 'sm-kpi-agreement-value')).toHaveText('93% (27 rated)');
    // A later success clears the message.
    failFeedback(null);
    await h2.locator('[data-testid=sm-queue-wrong]').click();
    await expect(h2.locator('[data-testid=sm-queue-wrong]')).toHaveAttribute('aria-pressed', 'true');
    await expect(h2.locator('[data-testid=sm-queue-feedback-error]')).toHaveCount(0);
  });

  test('a dropped connection reverts the row with a try-again message', async ({ page }) => {
    await mount(page);
    await page.route('**/api/integration/execute/**', async (route) => {
      if (/monitor_feedback/.test(route.request().postData() || '')) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return route.fallback();
    });
    const h1 = row(page, 'Outbound beacon');
    await h1.locator('[data-testid=sm-queue-right]').click();
    await expect(h1.locator('[data-testid=sm-queue-feedback-error]')).toContainText('could not be saved');
    await expect(h1.locator('[data-testid=sm-queue-right]')).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('agenticAssistantMonitor -- undo from the queue', () => {
  test('only an undoable action offers undo, and it sends the session and action card', async ({ page }) => {
    await mount(page);
    await expect(T(page, 'sm-queue-undo')).toHaveCount(1);
    await expect(row(page, 'Outbound beacon').locator('[data-testid=sm-queue-undo]')).toBeVisible();
    await row(page, 'Outbound beacon').locator('[data-testid=sm-queue-undo]').click();
    await expect.poll(async () => (await lastCall(page, 'undo_action')) || null).toMatchObject({ params: { session_id: 'auto:alerts:a1', card_id: 'card-a1' } });
    await expect(T(page, 'sm-queue-undo')).toHaveCount(0);
  });
});

test.describe('agenticAssistantMonitor -- queue at phone width', () => {
  test('rows stack and the page never scrolls sideways at 360px', async ({ page }) => {
    await mount(page, { width: 360 });
    for (const bucket of ['handled', 'needs_you', 'reopened']) {
      await T(page, `sm-queue-tab-${bucket}`).click();
      await expect(T(page, 'sm-queue-row').first()).toBeVisible();
      await T(page, 'sm-queue-more').first().click();
      const over = await page.evaluate(() => {
        const r = document.querySelector('[data-testid=soc-monitor-root]');
        const rr = r.getBoundingClientRect();
        const poking = [...r.querySelectorAll('*')].filter((n) => n.getBoundingClientRect().width > 0
          && n.getBoundingClientRect().right > rr.right + 1).length;
        return { past: Math.max(0, Math.round(rr.right - window.innerWidth)), inner: r.scrollWidth - r.clientWidth, poking };
      });
      expect(over, `${bucket}: horizontal overflow`).toEqual({ past: 0, inner: 0, poking: 0 });
    }
    // The column headings fold away when rows stack, the labels sit in the rows.
    await expect(row(page, 'Odd PowerShell').locator('.sm-q-k').first()).toBeVisible();
  });
});

test.describe('agenticAssistantMonitor -- other tabs from the Cases default', () => {
  test('the Pending tab lists the escalations the moment it opens', async ({ page }) => {
    await mount(page, { handle: withEscalation });
    // Give the background fetch of the tab bodies time to land, then look at
    // the panel straight after the click, without waiting for it to fill in.
    await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /tab-pending\.html/.test(e.name)));
    await page.waitForTimeout(500);
    await T(page, 'sm-tab-pending').click();
    expect(await T(page, 'sm-esc-row').count()).toBe(1);
    expect(await T(page, 'sm-pending-row').count()).toBe(1);
    await expect(T(page, 'sm-esc-title')).toHaveText('Outbound beacon to 198.51.100.7');
    await expect(T(page, 'sm-tab-pending')).toContainText('3');
  });
});
