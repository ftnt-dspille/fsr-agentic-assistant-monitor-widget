'use strict';
// X7: the "Would help most" panel on the Cases tab. The connector ranks the
// sources that were missing or failing by the uncertain cases each would have
// helped (_monitorMock.js serves that answer); the panel shows it by value.
//
//   make test-e2e-spec SPEC=agenticAssistantMonitor.wouldHelp

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');
const { installMonitorMock, calls } = require('./_monitorMock');

const CONFIG = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 600 };
const WIDGET_ID = 'agenticAssistantMonitor-' + require('../../widget/info.json').version;
const T = (page, id) => page.locator(`[data-testid=${id}]`);

async function mount(page, { handle } = {}) {
  await installMonitorMock(page, handle ? { handle } : {});
  await page.addInitScript(([id, cfg]) => {
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness:config:' + id, JSON.stringify(cfg));
  }, [WIDGET_ID, CONFIG]);
  await mountWidget(page, WIDGET_ID, { config: CONFIG });
  await page.locator('[data-testid=sm-queue]').waitFor({ timeout: 15000 });
}

test.describe('agenticAssistantMonitor -- would help most', () => {
  test('lists the ranked sources with their counts, in the connector order', async ({ page }) => {
    await mount(page);
    await expect(T(page, 'sm-help-sub')).toContainText('9 uncertain cases');
    const items = T(page, 'sm-help-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0).locator('[data-testid=sm-help-problem]')).toHaveText('Ticket system is not connected');
    await expect(items.nth(0).locator('[data-testid=sm-help-count]')).toHaveText('Would have helped 7 uncertain cases');
    await expect(items.nth(1).locator('[data-testid=sm-help-problem]')).toHaveText('FortiSIEM returned an error');
    await expect(items.nth(1).locator('[data-testid=sm-help-count]')).toHaveText('Would have helped 2 uncertain cases');
    await expect(items.nth(2).locator('[data-testid=sm-help-problem]')).toHaveText('FortiAnalyzer was searched and returned nothing');
    await expect(items.nth(2).locator('[data-testid=sm-help-count]')).toHaveText('Would have helped 1 uncertain case');
  });

  test('a missing or failing source links to the Connectors page; an empty search does not', async ({ page }) => {
    await mount(page);
    const items = T(page, 'sm-help-item');
    await expect(items.nth(0).locator('[data-testid=sm-help-link]')).toHaveText('Set up a connector');
    await expect(items.nth(1).locator('[data-testid=sm-help-link]')).toHaveText('Check its connection');
    await expect(items.nth(2).locator('[data-testid=sm-help-link]')).toHaveCount(0);
    const href = await items.nth(0).locator('[data-testid=sm-help-link]').getAttribute('href');
    expect(href).toMatch(/^#\//);
    expect(href).toMatch(/connectors$/);
  });

  test('the panel follows the time window', async ({ page }) => {
    await mount(page);
    await T(page, 'sm-queue-window').selectOption({ label: 'Last 7 days' });
    await expect.poll(async () => (await calls(page, 'monitor_cases'))
      .filter((c) => c.params.view === 'would_help').map((c) => c.params.hours).pop()).toBe(168);
  });

  test('with no uncertain cases it says nothing is missing', async ({ page }) => {
    await mount(page, { handle: (op, params, base) =>
      (op === 'monitor_cases' && params.view === 'would_help'
        ? { ok: true, view: 'would_help', hours: 24, uncertain: 0, with_help: 0, items: [] }
        : base(op, params)) });
    await expect(T(page, 'sm-help-empty')).toHaveText('No uncertain cases in the last 24 hours, so nothing is missing.');
    await expect(T(page, 'sm-help-list')).toHaveCount(0);
  });

  test('uncertain cases with no traceable source say so', async ({ page }) => {
    await mount(page, { handle: (op, params, base) =>
      (op === 'monitor_cases' && params.view === 'would_help'
        ? { ok: true, view: 'would_help', hours: 24, uncertain: 4, with_help: 0, items: [] }
        : base(op, params)) });
    await expect(T(page, 'sm-help-none')).toHaveText('None of the uncertain cases traces back to a missing or failing source.');
  });

  test('a connector that cannot answer is stated, not hidden', async ({ page }) => {
    await mount(page, { handle: (op, params, base) =>
      (op === 'monitor_cases' && params.view === 'would_help'
        ? { ok: false, error: { code: 'bad_view' } } : base(op, params)) });
    await expect(T(page, 'sm-help-unavailable')).toHaveText('The sources that would help could not be loaded.');
  });
});
