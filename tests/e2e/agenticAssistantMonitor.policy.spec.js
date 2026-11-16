'use strict';
// Monitor revamp phase C: the Autonomy tab's readiness per rule with its
// decision drawer (M4) and the actionable tuning table (M5), against the
// connector mock (_monitorMock.js serves the policy and tuning views with the
// live contract: the connector decides ready / safe, the widget displays it).
//
//   make test-e2e-spec SPEC=agenticAssistantMonitor.policy

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');
const { installMonitorMock, calls, lastCall, CASES, POLICY_RULES, TUNING_RULES } = require('./_monitorMock');

const CONFIG = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 600 };
const WIDGET_ID = 'agenticAssistantMonitor-' + require('../../widget/info.json').version;
const T = (page, id) => page.locator(`[data-testid=${id}]`);

async function mount(page, { width, handle } = {}) {
  if (width) await page.setViewportSize({ width, height: 900 });
  await installMonitorMock(page, handle ? { handle } : {});
  await page.addInitScript(([id, cfg]) => {
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness:config:' + id, JSON.stringify(cfg));
  }, [WIDGET_ID, CONFIG]);
  await mountWidget(page, WIDGET_ID, { config: CONFIG });
  await T(page, 'sm-queue').waitFor({ timeout: 15000 });
}
async function openPolicy(page, opts) {
  await mount(page, opts);
  await T(page, 'sm-tab-autonomy').click();
}

// What each fixture rule must read as, word for word (written out here, not
// derived from the fixture, so a widget that re-derives the verdict is caught).
const EXPECT_RULES = {
  'close-benign': { name: 'Close benign alerts', badge: 'Ready to enforce',
    numbers: '24 decisions, 96% agreement, 0% reopened', blockers: [], showId: true },
  'block-external-ip': { name: 'Block external addresses', badge: 'Not ready yet',
    numbers: '7 decisions, 86% agreement, 14% reopened',
    blockers: ['Only 7 decisions so far; at least 20 are needed.',
      'Reviewers agreed 86% of the time; at least 95% is needed.',
      '14% of its closes were reopened; at most 5% is allowed.'], showId: true },
  'quarantine-host': { name: 'Quarantine infected hosts', badge: 'Not ready yet',
    numbers: '0 decisions, agreement not known yet, reopens not known yet',
    blockers: ['This rule has not made a decision yet.'], showId: true },
};
const EXPECT_TUNING = [
  { rule: 'Port scan from scanner subnet', source: 'FortiSIEM', closes: '12', reopened: '0', rate: '0%',
    flag: 'Safe to tune', note: 'Closed 12 times and never reopened, so it is safe to tune.', warn: false },
  { rule: 'Suspicious Process', source: 'FortiEDR', closes: '6', reopened: '2', rate: '33%',
    flag: 'Keep watching', note: 'A third of its closes were reopened, so keep watching.', warn: true },
  { rule: 'Unnamed rule', source: 'Unknown source', closes: '2', reopened: '0', rate: '0%',
    flag: 'Keep watching', note: 'Only 2 closes so far; at least 5 are needed.', warn: false },
];
const decisionsOf = (ruleId) => CASES.filter((c) => c.rule_id === ruleId).sort((a, b) => a.age - b.age);

test.describe('agenticAssistantMonitor -- policy readiness (M4)', () => {
  test('every rule shows its badge, the numbers behind it and its blockers', async ({ page }) => {
    await openPolicy(page);
    await expect(T(page, 'sm-policy-rule')).toHaveCount(POLICY_RULES.length);
    await expect(T(page, 'sm-policy-mode')).toHaveText('Recording only: nothing acts on its own yet');
    await expect(T(page, 'sm-policy-bar')).toHaveText(
      'A rule is ready to enforce at 20 decisions or more, 95% agreement or better, and 5% or fewer reopened.');
    for (const r of POLICY_RULES) {
      const want = EXPECT_RULES[r.rule_id];
      const item = T(page, 'sm-policy-rule').filter({ hasText: want.name });
      await expect(item, r.rule_id).toHaveCount(1);
      await expect(item.locator('[data-testid=sm-policy-rule-name]')).toHaveText(want.name);
      await expect(item.locator('[data-testid=sm-policy-rule-id]')).toHaveText(r.rule_id);
      await expect(item.locator('[data-testid=sm-policy-badge]')).toHaveText(want.badge);
      await expect(item.locator('[data-testid=sm-policy-numbers]')).toHaveText(want.numbers);
      await expect(item.locator('[data-testid=sm-policy-blocker]')).toHaveText(want.blockers);
      if (!want.blockers.length) await expect(item.locator('[data-testid=sm-policy-blockers]')).toHaveCount(0);
    }
    // The readiness table replaces the old shadow matrix.
    await expect(T(page, 'sm-autonomy-rules')).toHaveCount(0);
    expect((await calls(page, 'monitor_cases')).filter((c) => c.params.view === 'policy').map((c) => c.params))
      .toEqual([{ view: 'policy' }]);
  });

  test('opening a rule lists exactly that rule\'s decisions with verdict and evidence', async ({ page }) => {
    await openPolicy(page);
    for (const r of POLICY_RULES) {
      const item = T(page, 'sm-policy-rule').filter({ hasText: EXPECT_RULES[r.rule_id].name });
      await item.locator('[data-testid=sm-policy-open]').click();
      const drawer = item.locator('[data-testid=sm-policy-drawer]');
      await expect(drawer, r.rule_id).toBeVisible();
      const want = decisionsOf(r.rule_id);
      if (!want.length) {
        await expect(drawer.locator('[data-testid=sm-policy-drawer-empty]')).toHaveText('This rule has no recent decisions.');
        await expect(drawer.locator('[data-testid=sm-policy-decision]')).toHaveCount(0);
      } else {
        await expect(drawer.locator('[data-testid=sm-policy-decision]')).toHaveCount(want.length);
        await expect(drawer.locator('[data-testid=sm-policy-decision-case]')).toHaveText(want.map((c) => c.record_name));
        for (const c of want) {
          const d = drawer.locator('[data-testid=sm-policy-decision]').filter({ hasText: c.record_name });
          await expect(d.locator('[data-testid=sm-policy-decision-verdict]')).toHaveText(c.verdict);
          await expect(d.locator('[data-testid=sm-policy-decision-conf]')).toHaveText(Math.round(c.confidence * 100) + '%');
          await expect(d.locator('[data-testid=sm-policy-decision-sources]')).toHaveText(c.sources.join(', '));
          await expect(d.locator('[data-testid=sm-policy-decision-reason]')).toHaveText(c.reasons);
          await expect(d.locator('[data-testid=sm-policy-decision-action]')).toHaveText(c.action);
          await expect(d.locator('[data-testid=sm-policy-decision-undo]')).toHaveCount(c.undoable ? 1 : 0);
        }
      }
      // Only one drawer at a time, and its list call carried the window.
      await expect(T(page, 'sm-policy-drawer')).toHaveCount(1);
      expect((await lastCall(page, 'monitor_cases')).params).toEqual({ view: 'list', bucket: 'all', hours: 336, limit: 200 });
      await drawer.locator('[data-testid=sm-policy-drawer-close]').click();
      await expect(T(page, 'sm-policy-drawer')).toHaveCount(0);
    }
  });

  test('Undo in the drawer sends the card to the undo operation and shows it undone', async ({ page }) => {
    await openPolicy(page);
    const item = T(page, 'sm-policy-rule').filter({ hasText: 'Block external addresses' });
    await item.locator('[data-testid=sm-policy-open]').click();
    await item.locator('[data-testid=sm-policy-decision-undo]').click();
    await expect(item.locator('[data-testid=sm-policy-decision-undone]')).toHaveText('Undone');
    await expect(item.locator('[data-testid=sm-policy-decision-undo]')).toHaveCount(0);
    const sent = await calls(page, 'undo_action');
    expect(sent).toHaveLength(1);
    expect(sent[0].params).toMatchObject({ session_id: 'auto:alerts:a1', card_id: 'card-a1' });
  });

  test('a drawer that fails to load says so', async ({ page }) => {
    await openPolicy(page, { handle: (op, params, base) =>
      (op === 'monitor_cases' && params.view === 'list' ? { ok: false, error: { code: 'bad' } } : base(op, params)) });
    await T(page, 'sm-policy-open').first().click();
    await expect(T(page, 'sm-policy-drawer-failed')).toHaveText('The decisions for this rule could not be loaded.');
  });

  test('when the readiness answer is unavailable the earlier shadow table stays', async ({ page }) => {
    await openPolicy(page, { handle: (op, params, base) => {
      if (op === 'monitor_cases' && (params.view === 'policy' || params.view === 'tuning')) return { ok: false, error: { code: 'bad_view' } };
      if (op === 'list_shadow_decisions') return { policy: { enabled: true, mode: 'shadow', rules: ['block-external-ip'] },
        rules: [{ rule: 'block-external-ip', would_act_approved: 3, would_act_rejected: 0,
                  would_not_act_approved: 0, would_not_act_rejected: 0, undecided: 0 }], decisions: [] };
      return base(op, params);
    } });
    await expect(T(page, 'sm-autonomy-rules')).toBeVisible();
    await expect(T(page, 'sm-policy-rules')).toHaveCount(0);
  });
});

test.describe('agenticAssistantMonitor -- actionable tuning (M5)', () => {
  test('each detection rule shows its closes, reopen rate, flag and note', async ({ page }) => {
    await openPolicy(page);
    const rows = T(page, 'sm-tuning-row');
    await expect(rows).toHaveCount(TUNING_RULES.length);
    for (const [i, w] of EXPECT_TUNING.entries()) {
      const r = rows.nth(i);
      await expect(r.locator('[data-testid=sm-tuning-rule]')).toHaveText(w.rule);
      await expect(r.locator('[data-testid=sm-tuning-source]')).toHaveText(w.source);
      await expect(r.locator('[data-testid=sm-tuning-closes]')).toHaveText(w.closes);
      await expect(r.locator('[data-testid=sm-tuning-reopened]')).toHaveText(w.reopened);
      await expect(r.locator('[data-testid=sm-tuning-rate]')).toHaveText(w.rate);
      await expect(r.locator('[data-testid=sm-tuning-flag]')).toHaveText(w.flag);
      await expect(r.locator('[data-testid=sm-tuning-note-row]')).toHaveText(w.note);
      if (w.warn) await expect(r.locator('[data-testid=sm-tuning-reopened]')).toHaveClass(/sm-badge-warn/);
      else await expect(r.locator('[data-testid=sm-tuning-reopened]')).not.toHaveClass(/sm-badge-warn/);
      // The data gives no link to a detection rule, so none is invented.
      await expect(r.locator('a')).toHaveCount(0);
    }
    await expect(T(page, 'sm-tuning-bar')).toContainText(
      'A detection rule is safe to tune at 5 closes by the assistant or more, with 10% or fewer reopened.');
    // The old raw counters are gone.
    await expect(T(page, 'sm-autonomy-tuning')).toHaveCount(0);
    expect((await calls(page, 'monitor_cases')).filter((c) => c.params.view === 'tuning').map((c) => c.params))
      .toEqual([{ view: 'tuning' }]);
  });

  test('no closes says so plainly', async ({ page }) => {
    await openPolicy(page, { handle: (op, params, base) =>
      (op === 'monitor_cases' && params.view === 'tuning'
        ? { ok: true, view: 'tuning', thresholds: { min_closes: 5, max_reopen_rate: 0.1 }, rules: [] }
        : base(op, params)) });
    await expect(T(page, 'sm-tuning-empty')).toHaveText('The assistant has not closed any alerts as false positives in this window.');
    await expect(T(page, 'sm-tuning-row')).toHaveCount(0);
  });
});

test.describe('agenticAssistantMonitor -- policy at phone width', () => {
  test('360px: the rules, an open drawer and the tuning table never scroll the page sideways', async ({ page }) => {
    await openPolicy(page, { width: 360 });
    await T(page, 'sm-policy-open').nth(0).click();
    await expect(T(page, 'sm-policy-decision').first()).toBeVisible();
    await expect(T(page, 'sm-tuning-row').first()).toBeVisible();
    const over = await page.evaluate(() => {
      const r = document.querySelector('[data-testid=soc-monitor-root]');
      const rr = r.getBoundingClientRect();
      const scrolls = (n) => { for (let p = n.parentElement; p && p !== r; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; }
        return false; };
      const poking = [...r.querySelectorAll('*')].filter((n) => n.getBoundingClientRect().width > 0
        && n.getBoundingClientRect().right > rr.right + 1 && !scrolls(n)).length;
      return { past: Math.max(0, Math.round(rr.right - window.innerWidth)), inner: r.scrollWidth - r.clientWidth, poking };
    });
    expect(over).toEqual({ past: 0, inner: 0, poking: 0 });
  });
});
