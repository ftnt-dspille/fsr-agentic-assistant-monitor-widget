'use strict';
// M6 clean-up guards for the Agentic Assistant Monitor:
//  1. the text an analyst reads carries no emoji or pictograph, no dash
//     punctuation the house style bans, no connector operation or tool names,
//     no wire enum values and no raw JSON, on every tab;
//  2. at a phone width the tab bar wraps onto more than one row and the page
//     never scrolls sideways.
//
//   make test-e2e-spec SPEC=agenticAssistantMonitor.cleanup
//
// The raw tool-call payloads under an audit row's expander and in Turn Detail
// are the audit record itself and stay out of scope until opened.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');
const { installMonitorMock, withEscalation, PENDING } = require('./_monitorMock');

const CONFIG = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 600 };
const WIDGET_ID = 'agenticAssistantMonitor-' + require('../../widget/info.json').version;

// Pictographs, dingbats, arrows, geometric shapes, math operators, the
// multiplication sign used as a close glyph, the ellipsis glyph, en/em dashes.
const BANNED_GLYPHS = /[\u{1F000}-\u{1FFFF}←-⯿☀-➿×…–—️]/u;
// Identifiers the analyst must never read: operation/tool names from the
// mock below and the wire keys behind the filters.
const BANNED_WORDS = /block_ip_new|unblock_ip|update_record|run_op|get_record|fortigate-firewall|session_status|waiting_approval|user_iri/;
const RAW_JSON = /[{[]\s*"[A-Za-z_]+"\s*:/;

// An approval that carries only its connector, operation and tool: the title
// fallback must not print them. A policy decision with no summary does the same.
const BARE_APPROVAL = {
  approval_id: 'apr-bare', card_id: 'apr-bare', session_id: 'sess-wait-1', age_seconds: 60,
  user: { name: 'CS Admin', iri: '/api/3/people/x' }, record_module: 'alerts',
  card: { type: 'action_card', tool: 'run_op', connector: 'fortigate-firewall', operation: 'block_ip_new' },
};
const SHADOW = {
  policy: { enabled: true, mode: 'shadow', rules: ['block-external-ip'] },
  rules: [{ rule: 'block-external-ip', would_act_approved: 1, would_act_rejected: 0,
            would_not_act_approved: 0, would_not_act_rejected: 0, undecided: 0 }],
  tuning: [],
  decisions: [{ session_id: 's1', card_id: 'c2', at: 1785000000,
    connector: 'fortigate-firewall', operation: 'block_ip_new',
    policy: { rule: 'block-external-ip', outcome: 'would_act', failed: [] }, human: null, actor: null }],
  policy_document: { version: 1, enabled: true, mode: 'shadow', rules: [{
    id: 'block-external-ip', action: { connector: 'fortigate-firewall', op: 'block_ip_new' },
    when: { verdict: { disposition: ['true_positive'], min_confidence: 0.9 } } }] },
};

async function mount(page, width) {
  if (width) await page.setViewportSize({ width, height: 900 });
  await installMonitorMock(page, { handle: (op, params, base) => {
    if (op === 'list_shadow_decisions') return SHADOW;
    if (op === 'list_pending') return { ...withEscalation(op, params, base), pending: PENDING.concat([BARE_APPROVAL]) };
    return withEscalation(op, params, base);
  } });
  await page.addInitScript(([id, cfg]) => {
    localStorage.setItem('harness.widget', id);
    localStorage.setItem('harness.ctx', 'dashboard');
    localStorage.setItem('harness:config:' + id, JSON.stringify(cfg));
  }, [WIDGET_ID, CONFIG]);
  await mountWidget(page, WIDGET_ID, { config: CONFIG });
  await page.locator('[data-testid=sm-queue]').waitFor({ timeout: 15000 });
}

const readable = (page) => page.locator('[data-testid=soc-monitor-root]').evaluate((el) => {
  // innerText skips <style>/<script>; placeholders and tooltips are read too.
  const extra = [...el.querySelectorAll('[placeholder],[title],[aria-label]')]
    .map((n) => [n.getAttribute('placeholder'), n.getAttribute('title'), n.getAttribute('aria-label')].join(' '));
  return el.innerText + '\n' + extra.join('\n');
});

test.describe('agenticAssistantMonitor -- analyst text is clean', () => {
  test.setTimeout(180000);
  test('no emoji, banned dashes, tool names, wire values or raw JSON on any tab', async ({ page }) => {
    await mount(page);
    // Make a filter chip visible on its tab too (the Pending card sets one).
    await page.locator('[data-testid=sm-tab-overview]').click();
    await page.locator('[data-testid=sm-card-pending]').click();
    await expect(page.locator('[data-testid=sm-filter-chip]')).toHaveCount(1);
    const seen = [];
    for (const name of ['queue', 'overview', 'sessions', 'pending', 'users', 'scheduled', 'autonomy', 'audit']) {
      await page.locator(`[data-testid=sm-tab-${name}]`).click();
      // A partial is fetched on demand; wait until the panel has real content.
      await page.waitForFunction((n) => {
        const root = document.querySelector('[data-testid=soc-monitor-root]');
        return root && !root.querySelector('.sm-spinner') && root.querySelectorAll('[ng-include]').length > 0
          && root.querySelector('[ng-include] *');
      }, name);
      await page.waitForTimeout(250);
      const text = await readable(page);
      seen.push(name + ':' + text.length);
      expect.soft(text, `${name}: glyph`).not.toMatch(BANNED_GLYPHS);
      expect.soft(text, `${name}: identifier`).not.toMatch(BANNED_WORDS);
      expect.soft(text, `${name}: raw JSON`).not.toMatch(RAW_JSON);
    }
    // The sweep read real content on every tab, not empty shells.
    expect(seen.every((s) => Number(s.split(':')[1]) > 40)).toBe(true);
  });

  test('the approval with only a connector and an operation reads as a plain request', async ({ page }) => {
    await mount(page);
    await page.locator('[data-testid=sm-tab-pending]').click();
    await expect(page.locator('[data-testid=sm-pending-title]').filter({ hasText: 'Approval request' })).toHaveCount(1);
  });
});

test.describe('agenticAssistantMonitor -- narrow width', () => {
  test('tabs wrap onto several rows and the page never scrolls sideways at 360px', async ({ page }) => {
    await mount(page, 360);
    const bar = page.locator('.sm-tab-bar');
    const tabs = page.locator('.sm-tab');
    // The tab list is whatever the view declares, so a new tab does not need a
    // literal edited here; the sweep below visits every one of them.
    const names = await tabs.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('sm-tab-', '')));
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toEqual(expect.arrayContaining(['queue', 'overview', 'sessions', 'pending', 'audit', 'autonomy', 'hunts', 'shift']));
    const tops = await tabs.evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
    expect(tops.length, 'tabs sit on more than one row').toBeGreaterThan(1);
    // Every tab is inside the bar, and the bar inside the widget.
    const root = await page.locator('[data-testid=soc-monitor-root]').boundingBox();
    const box = await bar.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(root.x + root.width + 1);
    for (const name of names) {
      await page.locator(`[data-testid=sm-tab-${name}]`).click();
      await page.waitForTimeout(300);
      // Measure the widget, not the harness page around it: the root fits the
      // viewport, does not scroll inside itself, and no descendant pokes out of
      // it unless its own scroll box (a wide table) contains it.
      const over = await page.evaluate(() => {
        const r = document.querySelector('[data-testid=soc-monitor-root]');
        const rr = r.getBoundingClientRect();
        const scrolls = (n) => { for (let p = n.parentElement; p && p !== r; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; }
          return false; };
        const poking = [...r.querySelectorAll('*')].filter((n) => n.getBoundingClientRect().width > 0
          && n.getBoundingClientRect().right > rr.right + 1 && !scrolls(n)).length;
        return { past: Math.max(0, Math.round(rr.right - window.innerWidth)),
                 inner: r.scrollWidth - r.clientWidth, poking };
      });
      expect(over, `${name}: horizontal overflow`).toEqual({ past: 0, inner: 0, poking: 0 });
    }
  });
});
