'use strict';
// X6: the Scheduled hunts list (create, edit, pause, run now, delete) and the
// Shift summary view (window picker, copy, export), against the connector mock
// (_monitorMock.js answers list_hunts / save_hunt / shift_summary with the live
// contract). The real service, controller and templates are in the loop.
//
//   make test-e2e-spec SPEC=agenticAssistantMonitor.huntsShift

const fs = require('fs');
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');
const { installMonitorMock, calls, HUNTS, shiftSummary } = require('./_monitorMock');

const CONFIG = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 600 };
const WIDGET_ID = 'agenticAssistantMonitor-' + require('../../widget/info.json').version;
const T = (page, id) => page.locator(`[data-testid=${id}]`);

async function mount(page, { handle, tab } = {}) {
  await installMonitorMock(page, handle ? { handle } : {});
  await page.addInitScript(([id, cfg]) => {
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness:config:' + id, JSON.stringify(cfg));
  }, [WIDGET_ID, CONFIG]);
  await mountWidget(page, WIDGET_ID, { config: CONFIG });
  await page.locator('[data-testid=sm-queue]').waitFor({ timeout: 15000 });
  if (tab) await T(page, `sm-tab-${tab}`).click();
}
const huntRow = (page, name) => T(page, 'sm-hunt-row').filter({ hasText: name });
const lastOf = async (page, op) => (await calls(page, op)).pop();

test.describe('agenticAssistantMonitor -- scheduled hunts', () => {
  test('lists every hunt with its schedule, last run, outcome and findings link', async ({ page }) => {
    await mount(page, { tab: 'hunts' });
    await expect(T(page, 'sm-tab-hunts')).toHaveText(/Scheduled hunts\s*3/);
    await expect(T(page, 'sm-hunt-row')).toHaveCount(3);

    const c2 = huntRow(page, 'c2-sweep');
    await expect(c2.locator('[data-testid=sm-hunt-row-schedule]')).toHaveText('Every hour');
    await expect(c2.locator('[data-testid=sm-hunt-row-last]')).toHaveText('30m ago');
    await expect(c2.locator('[data-testid=sm-hunt-row-outcome]')).toHaveText('Found something');
    await expect(c2.locator('[data-testid=sm-hunt-row-summary]')).toHaveText('Host h1 beaconed to a known command-and-control address.');
    await expect(c2.locator('[data-testid=sm-hunt-row-case]')).toHaveAttribute('href', '#/main/modules/alerts/f1000000-0000-4000-8000-000000000001');
    await expect(c2.locator('[data-testid=sm-hunt-row-paused]')).toHaveCount(0);
    await expect(c2.locator('[data-testid=sm-hunt-toggle]')).toHaveText('Pause');

    const dns = huntRow(page, 'dns-tunnel');
    await expect(dns.locator('[data-testid=sm-hunt-row-schedule]')).toHaveText('Every day at 06:00 UTC');
    await expect(dns.locator('[data-testid=sm-hunt-row-outcome]')).toHaveText('Quiet run');
    await expect(dns.locator('[data-testid=sm-hunt-row-paused]')).toHaveText('Paused');
    await expect(dns.locator('[data-testid=sm-hunt-row-nocase]')).toHaveText('None');
    await expect(dns.locator('[data-testid=sm-hunt-toggle]')).toHaveText('Resume');

    const fresh = huntRow(page, 'new-hunt');
    await expect(fresh.locator('[data-testid=sm-hunt-row-last]')).toHaveText('Not run yet');
    await expect(fresh.locator('[data-testid=sm-hunt-row-outcome]')).toHaveText('-');
  });

  test('a new hunt is saved with its question, schedule and case type, then listed again', async ({ page }) => {
    await mount(page, { tab: 'hunts' });
    await T(page, 'sm-hunt-new').click();
    await expect(T(page, 'sm-hunt-save')).toBeDisabled();
    await T(page, 'sm-hunt-name').fill('rare-ports');
    await T(page, 'sm-hunt-question').fill('Any server listening on a port nobody has used this month');
    await T(page, 'sm-hunt-schedule').selectOption({ label: 'Weekdays at 08:00' });
    await T(page, 'sm-hunt-module').selectOption({ label: 'An incident' });
    await expect(T(page, 'sm-hunt-save')).toBeEnabled();
    await T(page, 'sm-hunt-save').click();
    await expect(T(page, 'sm-hunt-form')).toHaveCount(0);
    expect((await lastOf(page, 'save_hunt')).params).toEqual({
      name: 'rare-ports', question: 'Any server listening on a port nobody has used this month',
      cron: '0 8 * * 1-5', module: 'incidents' });
    expect((await calls(page, 'list_hunts')).length).toBe(2);
  });

  test('a custom schedule sends the typed expression', async ({ page }) => {
    await mount(page, { tab: 'hunts' });
    await T(page, 'sm-hunt-new').click();
    await T(page, 'sm-hunt-name').fill('half-hourly');
    await T(page, 'sm-hunt-question').fill('Any new admin account');
    await T(page, 'sm-hunt-schedule').selectOption({ label: 'Custom schedule' });
    await expect(T(page, 'sm-hunt-save')).toBeDisabled();
    await T(page, 'sm-hunt-cron').fill('*/30 * * * *');
    await T(page, 'sm-hunt-save').click();
    await expect(T(page, 'sm-hunt-form')).toHaveCount(0);
    expect((await lastOf(page, 'save_hunt')).params.cron).toBe('*/30 * * * *');
  });

  test('editing starts from the hunt, keeps its name fixed and sends the changed question', async ({ page }) => {
    await mount(page, { tab: 'hunts' });
    await huntRow(page, 'c2-sweep').locator('[data-testid=sm-hunt-edit]').click();
    await expect(T(page, 'sm-hunt-name')).toHaveValue('c2-sweep');
    await expect(T(page, 'sm-hunt-name')).toBeDisabled();
    await expect(T(page, 'sm-hunt-schedule')).toHaveValue('string:hourly');
    await T(page, 'sm-hunt-question').fill('Any host talking to a known C2 address this week');
    await T(page, 'sm-hunt-save').click();
    await expect(T(page, 'sm-hunt-form')).toHaveCount(0);
    expect((await lastOf(page, 'save_hunt')).params).toEqual({
      name: 'c2-sweep', question: 'Any host talking to a known C2 address this week',
      cron: '0 * * * *', module: 'alerts' });
  });

  test('a refused save keeps the form open and says why', async ({ page }) => {
    await mount(page, { tab: 'hunts', handle: (op, params, base) => (op === 'save_hunt'
      ? { ok: false, error: { code: 'x', message: 'a hunt cannot run every 5 minutes; use at least 15' } }
      : base(op, params)) });
    await T(page, 'sm-hunt-new').click();
    await T(page, 'sm-hunt-name').fill('too-fast');
    await T(page, 'sm-hunt-question').fill('anything');
    await T(page, 'sm-hunt-schedule').selectOption({ label: 'Custom schedule' });
    await T(page, 'sm-hunt-cron').fill('*/5 * * * *');
    await T(page, 'sm-hunt-save').click();
    await expect(T(page, 'sm-hunt-error')).toHaveText('The hunt was not saved. a hunt cannot run every 5 minutes; use at least 15');
    await expect(T(page, 'sm-hunt-form')).toBeVisible();
  });

  test('pause and resume send only the name and the flipped flag', async ({ page }) => {
    await mount(page, { tab: 'hunts' });
    await huntRow(page, 'c2-sweep').locator('[data-testid=sm-hunt-toggle]').click();
    await expect.poll(async () => (await lastOf(page, 'save_hunt')).params).toEqual({ name: 'c2-sweep', enabled: false });
    await huntRow(page, 'dns-tunnel').locator('[data-testid=sm-hunt-toggle]').click();
    await expect.poll(async () => (await lastOf(page, 'save_hunt')).params).toEqual({ name: 'dns-tunnel', enabled: true });
  });

  test('run now asks the scheduler for that hunt', async ({ page }) => {
    await mount(page, { tab: 'hunts' });
    await huntRow(page, 'c2-sweep').locator('[data-testid=sm-hunt-run]').click();
    await expect(huntRow(page, 'c2-sweep').locator('[data-testid=sm-hunt-run-result]')).toHaveText('Started');
    expect((await lastOf(page, 'run_hunt')).params).toEqual({ name: 'c2-sweep', trigger: true });
  });

  test('delete asks first; keeping it deletes nothing, confirming deletes that hunt', async ({ page }) => {
    await mount(page, { tab: 'hunts' });
    const r = huntRow(page, 'dns-tunnel');
    await r.locator('[data-testid=sm-hunt-delete]').click();
    await expect(r.locator('[data-testid=sm-hunt-confirm]')).toContainText('Delete this hunt and its history?');
    await r.locator('[data-testid=sm-hunt-delete-no]').click();
    expect(await calls(page, 'delete_hunt')).toEqual([]);
    await r.locator('[data-testid=sm-hunt-delete]').click();
    await r.locator('[data-testid=sm-hunt-delete-yes]').click();
    await expect.poll(async () => (await lastOf(page, 'delete_hunt')).params).toEqual({ name: 'dns-tunnel' });
  });

  test('no hunts reads as empty, and a failed load is not shown as empty', async ({ page }) => {
    await mount(page, { tab: 'hunts', handle: (op, params, base) => (op === 'list_hunts' ? { ok: true, hunts: [] } : base(op, params)) });
    await expect(T(page, 'sm-hunts-empty')).toHaveText('No scheduled hunts yet');
  });

  test('a connector that cannot list hunts says so', async ({ page }) => {
    await mount(page, { tab: 'hunts', handle: (op, params, base) => (op === 'list_hunts' ? { ok: false } : base(op, params)) });
    await expect(T(page, 'sm-hunts-failed')).toContainText('The scheduled hunts could not be loaded.');
    await expect(T(page, 'sm-hunts-empty')).toHaveCount(0);
  });
});

test.describe('agenticAssistantMonitor -- shift summary', () => {
  test('shows the digest numbers by section for the last 8 hours', async ({ page }) => {
    await mount(page, { tab: 'shift' });
    expect((await lastOf(page, 'shift_summary')).params).toEqual({ hours: 8 });
    await expect(T(page, 'sm-shift-window')).toHaveValue('number:8');
    await expect(T(page, 'sm-shift-triaged')).toHaveText('6');
    await expect(T(page, 'sm-shift-closed')).toHaveText('2');
    await expect(T(page, 'sm-shift-sent')).toHaveText('1');
    await expect(T(page, 'sm-shift-grouped')).toHaveText('2');
    await expect(T(page, 'sm-shift-waiting')).toContainText('Waiting for you (3)');
    const waiting = T(page, 'sm-shift-waiting-item');
    await expect(waiting).toHaveCount(2);
    await expect(waiting.nth(0)).toContainText('P2');
    await expect(waiting.nth(0)).toContainText('Phish report');
    await expect(waiting.nth(0)).toContainText('The verdict needs review: needs more information.');
    await expect(waiting.nth(0).locator('a')).toHaveAttribute('href', '#/main/modules/alerts/f2000000-0000-4000-8000-000000000002');
    await expect(T(page, 'sm-shift-notable')).toContainText('Notable verdicts (2)');
    await expect(T(page, 'sm-shift-notable-item').nth(0)).toContainText('Outbound C2: True positive, 92% confident');
    await expect(T(page, 'sm-shift-notable-item').nth(1)).toContainText('Odd login: Suspicious, 60% confident');
    await expect(T(page, 'sm-shift-help-item')).toHaveText('FortiSIEM returned an error: would have helped 1 uncertain case');
    await expect(T(page, 'sm-shift-hunts-line')).toHaveText('7 runs: 2 found something, 3 quiet, 1 inconclusive, 1 failed.');
    await expect(T(page, 'sm-shift-hunt-item')).toContainText('c2-sweep: Host h1 beaconed to a known command-and-control address.');
  });

  test('the window picker asks for that many hours', async ({ page }) => {
    await mount(page, { tab: 'shift' });
    await T(page, 'sm-shift-window').selectOption({ label: 'Last 7 days' });
    await expect.poll(async () => (await lastOf(page, 'shift_summary')).params).toEqual({ hours: 168 });
  });

  test('copy puts the digest text on the clipboard unchanged', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mount(page, { tab: 'shift' });
    await T(page, 'sm-shift-copy').click();
    await expect(T(page, 'sm-shift-notice')).toHaveText('Copied to the clipboard.');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(shiftSummary({ hours: 8 }).text);
  });

  test('download saves the digest text as a file', async ({ page }) => {
    await mount(page, { tab: 'shift' });
    const [download] = await Promise.all([page.waitForEvent('download'), T(page, 'sm-shift-export').click()]);
    expect(download.suggestedFilename()).toBe('shift-summary.txt');
    expect(fs.readFileSync(await download.path(), 'utf8')).toBe(shiftSummary({ hours: 8 }).text);
  });

  test('a quiet shift says nothing is waiting, and a failed load is not shown as a digest', async ({ page }) => {
    await mount(page, { tab: 'shift', handle: (op, params, base) => {
      if (op !== 'shift_summary') return base(op, params);
      const d = shiftSummary(params);
      return { ...d, waiting: { total: 0, cases: [] }, notable: { total: 0, cases: [] },
        would_help: { uncertain: 0, with_help: 0, items: [] },
        hunts: { runs: 0, findings: 0, quiet: 0, inconclusive: 0, failed: 0, cases: [] } };
    } });
    await expect(T(page, 'sm-shift-waiting-empty')).toHaveText('Nothing is waiting on you.');
    await expect(T(page, 'sm-shift-notable-empty')).toHaveText('No confirmed or suspicious verdicts.');
    await expect(T(page, 'sm-shift-help-empty')).toHaveText('No uncertain cases.');
    await expect(T(page, 'sm-shift-hunts-line')).toHaveText('0 runs: 0 found something, 0 quiet, 0 inconclusive, 0 failed.');
  });

  test('a connector that cannot answer shows a failure and no digest', async ({ page }) => {
    await mount(page, { tab: 'shift', handle: (op, params, base) => (op === 'shift_summary' ? { ok: false, error: { code: 'bad_window' } } : base(op, params)) });
    await expect(T(page, 'sm-shift-failed')).toContainText('The shift summary could not be loaded.');
    await expect(T(page, 'sm-shift-triaged')).toHaveCount(0);
    await expect(T(page, 'sm-shift-copy')).toBeDisabled();
  });
});
