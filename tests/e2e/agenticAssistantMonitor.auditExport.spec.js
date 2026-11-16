'use strict';
// X6: the Audit tab's Export audit button asks the connector for the window and
// format, and saves the returned text as a file. The connector builds and masks
// the content; the widget hands it over unchanged.
//
//   make test-e2e-spec SPEC=agenticAssistantMonitor.auditExport

const fs = require('fs');
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');
const { installMonitorMock, calls, AUDIT_CSV } = require('./_monitorMock');

const CONFIG = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 600 };
const WIDGET_ID = 'agenticAssistantMonitor-' + require('../../widget/info.json').version;
const T = (page, id) => page.locator(`[data-testid=${id}]`);

async function mount(page, opts = {}) {
  await installMonitorMock(page, opts.handle ? { handle: opts.handle } : {});
  await page.addInitScript(([id, cfg]) => {
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness:config:' + id, JSON.stringify(cfg));
  }, [WIDGET_ID, CONFIG]);
  await mountWidget(page, WIDGET_ID, { config: CONFIG });
  await page.locator('[data-testid=sm-queue]').waitFor({ timeout: 15000 });
  await T(page, 'sm-tab-audit').click();
}

test.describe('agenticAssistantMonitor -- audit export', () => {
  test('Export audit downloads the CSV the connector returned', async ({ page }) => {
    await mount(page);
    const [download] = await Promise.all([page.waitForEvent('download'), T(page, 'sm-audit-export-btn').click()]);
    expect(download.suggestedFilename()).toBe('agent-audit-test.csv');
    expect(fs.readFileSync(await download.path(), 'utf8')).toBe(AUDIT_CSV);
    expect((await calls(page, 'export_audit')).pop().params).toEqual({ hours: 24, format: 'csv' });
    await expect(T(page, 'sm-audit-export-notice')).toHaveText('Downloaded agent-audit-test.csv.');
  });

  test('the window and JSON format are sent and the JSON file is saved', async ({ page }) => {
    await mount(page);
    await T(page, 'sm-audit-export-window').selectOption({ label: 'Last 7 days' });
    await T(page, 'sm-audit-export-format').selectOption({ label: 'JSON' });
    const [download] = await Promise.all([page.waitForEvent('download'), T(page, 'sm-audit-export-btn').click()]);
    expect(download.suggestedFilename()).toBe('agent-audit-test.json');
    expect(JSON.parse(fs.readFileSync(await download.path(), 'utf8')).turns[0].session_id).toBe('auto:alerts:a1');
    expect((await calls(page, 'export_audit')).pop().params).toEqual({ hours: 168, format: 'json' });
  });

  test('a masked export says so, and a failed one is not shown as a download', async ({ page }) => {
    await mount(page, { handle: (op, params, base) => {
      if (op !== 'export_audit') return base(op, params);
      return params.format === 'json' ? { ok: false, error: { code: 'bad_window' } } : { ...base(op, params), redaction: 'standard' };
    } });
    const [download] = await Promise.all([page.waitForEvent('download'), T(page, 'sm-audit-export-btn').click()]);
    expect(download.suggestedFilename()).toBe('agent-audit-test.csv');
    await expect(T(page, 'sm-audit-export-notice')).toHaveText('Downloaded agent-audit-test.csv (sensitive values masked).');
    await T(page, 'sm-audit-export-format').selectOption({ label: 'JSON' });
    await T(page, 'sm-audit-export-btn').click();
    await expect(T(page, 'sm-audit-export-notice')).toHaveText('The audit could not be exported.');
  });
});
