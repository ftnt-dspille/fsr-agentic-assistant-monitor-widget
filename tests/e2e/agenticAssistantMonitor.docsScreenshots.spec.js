'use strict';
// Screenshots of the Monitor for the Agentic Assistant user guide
// (widgets-src/agenticAssistant/docs/USER_GUIDE.md), from the network
// mock so they are reproducible and carry no box details. Opt-in, because each
// run rewrites the committed images:
//
//   DOCS_SHOTS=1 make test-e2e-spec SPEC=widgets-src/agenticAssistantMonitor/tests/e2e/agenticAssistantMonitor.docsScreenshots.spec.js

const path = require('path');
const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');
const { installMonitorMock, withEscalation } = require('./_monitorMock');

const OUT = path.resolve(__dirname, '../../../agenticAssistant/docs/images');
const CONFIG = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 600 };
const WIDGET_ID = 'agenticAssistantMonitor-' + require('../../widget/info.json').version;

test.skip(!process.env.DOCS_SHOTS, 'set DOCS_SHOTS=1 to regenerate the user-guide screenshots');
test.use({ viewport: { width: 1400, height: 1000 } });

const SHADOW = {
  policy: { enabled: true, mode: 'shadow', rules: ['block-external-ip'] },
  rules: [{ rule: 'block-external-ip', would_act_approved: 14, would_act_rejected: 0,
            would_not_act_approved: 3, would_not_act_rejected: 5, undecided: 2 }],
  decisions: [
    { session_id: 's1', card_id: 'c1', at: 1785000000, summary: 'Block 203.0.113.45',
      connector: 'fortigate-firewall', operation: 'block_ip_new',
      policy: { rule: 'block-external-ip', outcome: 'would_act', failed: [] },
      human: 'approve', actor: 'SOC Lead' },
    { session_id: 's2', card_id: 'c2', at: 1784996000, summary: 'Block 198.51.100.1',
      connector: 'fortigate-firewall', operation: 'block_ip_new',
      policy: { rule: 'block-external-ip', outcome: 'would_not_act',
                failed: ['198.51.100.1 is an internal address'] },
      human: 'reject', actor: 'SOC Lead' },
    { session_id: 's3', card_id: 'c3', at: 1784990000, summary: 'Block 198.51.100.23',
      connector: 'fortigate-firewall', operation: 'block_ip_new',
      policy: { rule: 'block-external-ip', outcome: 'would_not_act',
                failed: ['confidence 0.71 is below 0.9'] },
      human: null, actor: null },
  ],
};

async function mount(page, handle) {
  await installMonitorMock(page, handle ? { handle } : {});
  await page.addInitScript(([id, cfg]) => {
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness:config:' + id, JSON.stringify(cfg));
  }, [WIDGET_ID, CONFIG]);
  await mountWidget(page, WIDGET_ID, { config: CONFIG });
  await page.locator('[data-testid=sm-queue]').waitFor({ timeout: 15000 });
  await page.locator('[data-testid=sm-tab-overview]').click();
  await page.locator('[data-testid=sm-card-turns]').waitFor({ timeout: 15000 });
}

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.locator('[data-testid=soc-monitor-root]').screenshot({ path: path.join(OUT, name) });
}

const both = (op, params, base) =>
  (op === 'list_shadow_decisions' ? SHADOW : withEscalation(op, params, base));

test('overview', async ({ page }) => {
  await mount(page, both);
  await expect(page.locator('[data-testid=sm-overview-chart]')).toBeVisible();
  await shot(page, 'monitor-overview.png');
});

test('pending queue with an escalation', async ({ page }) => {
  await mount(page, both);
  await page.locator('[data-testid=sm-tab-pending]').click();
  await expect(page.locator('[data-testid=sm-esc-handled]').first()).toBeVisible();
  await shot(page, 'monitor-pending.png');
});

test('autonomy tab', async ({ page }) => {
  await mount(page, both);
  await page.locator('[data-testid=sm-tab-autonomy]').click();
  await expect(page.locator('[data-testid=sm-autonomy-rule]')).toBeVisible();
  await shot(page, 'monitor-autonomy.png');
});

test('sessions tab', async ({ page }) => {
  await mount(page, both);
  await page.locator('[data-testid=sm-tab-sessions]').click();
  await expect(page.locator('[data-testid=sm-sessions-table]')).toBeVisible();
  await expect(page.locator('[data-testid=sm-sessions-row]')).toHaveCount(3);
  await expect(page.locator('[data-testid=sm-sessions-open]').first()).toBeVisible();
  await shot(page, 'monitor-sessions.png');
});

test('users tab', async ({ page }) => {
  await mount(page, both);
  await page.locator('[data-testid=sm-tab-users]').click();
  await expect(page.locator('[data-testid=sm-users-table]')).toBeVisible();
  await expect(page.locator('[data-testid=sm-users-name]').first()).toContainText('CS Admin');
  await shot(page, 'monitor-users.png');
});

test('scheduled tab', async ({ page }) => {
  await mount(page, both);
  await page.locator('[data-testid=sm-tab-scheduled]').click();
  await expect(page.locator('[data-testid=sm-scheduled-table]')).toBeVisible();
  await expect(page.locator('[data-testid=sm-scheduled-row]').first()).toContainText('Daily alert review');
  await expect(page.locator('[data-testid=sm-scheduled-run]').first()).toBeVisible();
  await shot(page, 'monitor-scheduled.png');
});

test('audit trail tab', async ({ page }) => {
  await mount(page, both);
  await page.locator('[data-testid=sm-tab-audit]').click();
  await expect(page.locator('[data-testid=sm-audit-table]')).toBeVisible();
  await expect(page.locator('[data-testid=sm-audit-row]').first()).toBeVisible();
  await shot(page, 'monitor-audit.png');
});

// The policy document the autonomy tab renders as plain words. Mirrors the
// rule shape the features spec uses for the same tab.
const POLICY_DOC = {
  version: 1, enabled: true, mode: 'shadow',
  rules: [{
    id: 'block-external-ip',
    action: { connector: 'fortigate-firewall', op: 'block_ip' },
    when: { verdict: { disposition: ['true_positive'], min_confidence: 0.9 },
            target: { kind: 'ip', external_only: true, not_in: 'protected_ips' } },
    limits: { per_hour: 10, per_target_per_day: 1 },
  }],
};
const withPolicy = (op, params, base) => {
  if (op === 'list_shadow_decisions') return { ...SHADOW, policy_document: POLICY_DOC };
  if (op === 'get_autonomy_policy') return { ok: true, policy: POLICY_DOC, valid: true };
  return both(op, params, base);
};

test('autonomy tab with a policy document', async ({ page }) => {
  await mount(page, withPolicy);
  await page.locator('[data-testid=sm-tab-autonomy]').click();
  const def = page.locator('[data-testid=sm-autonomy-rule-def]');
  await expect(def).toBeVisible();
  await expect(def.locator('td').nth(1)).toHaveText('fortigate-firewall / block_ip');
  await expect(def.locator('td').nth(2)).toContainText('verdict true positive at 90%+');
  await expect(page.locator('[data-testid=sm-autonomy-decision]').first()).toBeVisible();
  await shot(page, 'monitor-policy-rules.png');
});

test('autonomy policy JSON editor', async ({ page }) => {
  await mount(page, withPolicy);
  await page.locator('[data-testid=sm-tab-autonomy]').click();
  await page.locator('[data-testid=sm-autonomy-edit]').click();
  const text = page.locator('[data-testid=sm-autonomy-editor-text]');
  await expect(text).toBeVisible();
  expect(JSON.parse(await text.inputValue())).toEqual(POLICY_DOC);
  await shot(page, 'monitor-policy-editor.png');
});
