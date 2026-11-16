'use strict';
// Smoke spec: mounts the Agentic Assistant Monitor widget and verifies its
// root DOM + header chrome render. Connector calls fail in hermetic mode
// (no mock snapshots), which the controller surfaces as an error banner --
// that is the expected hermetic state, not a test failure.

const { test, expect } = require('../../../../fortisoar-widget-harness/tests/e2e/_fixtures');
const { mountWidget } = require('../../../../fortisoar-widget-harness/tests/e2e/_widgetHarness');

test.describe('agenticAssistantMonitor -- smoke', () => {
  test('mounts and renders the dashboard chrome', async ({ page }) => {
    const w = await mountWidget(page, 'agenticAssistantMonitor', {
      config: { title: 'Monitor Smoke', range: '7d', refreshSecs: 600 },
    });

    // Root element rendered.
    expect(await w.visible('[data-testid=soc-monitor-root]')).toBe(true);

    // Header title passed through from config.
    expect(await w.text('.sm-title')).toContain('Monitor Smoke');

    // Refresh control is present (confirms the toolbar rendered).
    expect(await w.visible('[data-testid=sm-refresh]')).toBe(true);

    // Sessions tab renders and opens the Live Sessions panel. In hermetic
    // mode the connector call fails, so the panel says it could not load --
    // never "no sessions", which would claim the box has none.
    //
    // The state is ASYNCHRONOUS by design: it renders only once the fetch has
    // settled. `w.visible()` is a one-shot read, so wait for the element
    // rather than sampling the instant after the click -- that instant
    // legitimately shows the loading state.
    expect(await w.visible('[data-testid=sm-tab-sessions]')).toBe(true);
    await w.click('[data-testid=sm-tab-sessions]');
    await page.locator('[data-testid=sm-sessions-failed]').waitFor({ state: 'visible' });
    expect(await page.locator('[data-testid=sm-sessions-empty]').count()).toBe(0);

    // Audit trail tab renders; hermetic mode → the same failed state.
    expect(await w.visible('[data-testid=sm-tab-audit]')).toBe(true);
    await w.click('[data-testid=sm-tab-audit]');
    await page.locator('[data-testid=sm-audit-failed]').waitFor({ state: 'visible' });
    expect(await page.locator('[data-testid=sm-audit-empty]').count()).toBe(0);
  });
});
