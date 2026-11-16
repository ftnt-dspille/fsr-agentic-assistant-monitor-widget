"use strict";
// Unit test for the agenticAssistantMonitor view controller. Boots a bare
// `cybersponse` module, loads the controller + service IIFEs (which
// self-register), then $controller-instantiates with a mocked
// fsrMonitorAgentService + $interval and asserts the view-model's derived
// logic (totals, per-user rollup, cost-bars).
//
//   make test-unit WIDGET=agenticAssistantMonitor

global.jasmine = global.jasmine || {};

require("angular");
require("angular-mocks");

angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/widgetAssets/js/fsrMonitorAgent.service.js");
require("../widget/view.controller.js");

const CTRL_NAME = "agenticAssistantMonitor110DevCtrl";
const ngModule = window.angular.mock.module; // eslint-disable-line no-undef
const ngInject = window.angular.mock.inject; // eslint-disable-line no-undef

function makeController(serviceMock) {
  let $scope, $q;
  ngModule("cybersponse", ($provide) => {
    $provide.value("config", { range: "7d", refreshSecs: 600 });
    $provide.value("fsrMonitorAgentService", serviceMock);
  });
  ngInject((_$rootScope_, _$controller_, _$q_, _$interval_) => {
    $scope = _$rootScope_.$new();
    $q = _$q_;
    // Stub $interval: no-op timer fn with a .cancel (called on $destroy).
    var $interval = function () { return 0; };
    $interval.cancel = function () {};
    _$controller_(CTRL_NAME, {
      $scope,
      config: { range: "7d", refreshSecs: 600 },
      $interval: $interval,
      $q: $q,
      fsrMonitorAgentService: serviceMock,
    });
  });
  return { $scope, $q };
}

describe("agenticAssistantMonitor view controller", () => {
  // Charts are zero-filled across the configured range, so every assertion
  // about bucket counts depends on "now". Freeze it: the fixtures below sit on
  // 2026-07-26/27, which must fall inside the default 7d window.
  const NOW = new Date("2026-07-28T12:00:00Z");
  beforeAll(() => { jest.useFakeTimers({ doNotFake: ["nextTick"] }).setSystemTime(NOW); });
  afterAll(() => { jest.useRealTimers(); });
  // 7d back from NOW floors to 2026-07-21, inclusive through 2026-07-28.
  const DAY_BUCKETS = 8;

  function cannedService() {
    return {
      listUsage: () => ({ then: (r) => r({ usage: [
        { ts: "2026-07-26T10:00:00Z", session_id: "s1", user_name: "alice", model: "claude", intent: "triage",
          input_tokens: 100, output_tokens: 20, cost_usd: 0.01, status: "success" },
        { ts: "2026-07-27T11:00:00Z", session_id: "s1", user_name: "alice", model: "claude", intent: "triage",
          input_tokens: 200, output_tokens: 40, cost_usd: 0.02, status: "success" },
        { ts: "2026-07-27T14:00:00Z", session_id: "s2", user_name: "bob", model: "gpt-4.1", intent: "build",
          input_tokens: 50, output_tokens: 10, cost_usd: 0.005, status: "success" },
      ] }) }),
      // Metric-aware, like the connector op: turns=COUNT, tokens/cost=SUM.
      getUsageSummary: (params) => {
        const m = (params && params.metric) || "cost";
        const hourly = params && params.bucket === "hour";
        const series = {
          cost:   hourly ? [0.005, 0.01, 0.008] : [0.02, 0.015],
          turns:  hourly ? [1, 2, 1] : [1, 2],
          tokens: hourly ? [60, 120, 90] : [120, 300],
        }[m];
        const keys = hourly
          ? ["2026-07-28T10:00", "2026-07-28T11:00", "2026-07-28T12:00"]
          : ["2026-07-26", "2026-07-27"];
        return { then: (r) => r({ summary: keys.map((k, i) => ({ bucket: k, value: series[i] })) }) };
      },
      listPending: () => ({ then: (r) => r({ pending: [
        { approval_id: "a1", session_id: "s1", intent: "triage", age_seconds: 120 },
      ] }) }),
      getAuditTrail: () => ({ then: (r) => r({ usage: [
        { ts: "2026-07-28T10:00:00Z", session_id: "s1", user_name: "alice", model: "claude", intent: "triage", input_tokens: 100, output_tokens: 20, cost_usd: 0.01, status: "success", prompt: "triage this alert", response: "This alert is benign -- the IOC is a known benign IP.", approvals_count: 0, tool_call_detail: [
          { tool_name: "get_record", params: { module: "alerts", id: "42" }, result_status: "success", result_summary: "alert 42 loaded", latency_ms: 120, index: 0, turn: 1 },
          { tool_name: "run_op", params: null, result_status: "error", result_summary: "bad args", latency_ms: 50, index: 1, turn: 1 },
        ] },
        { ts: "2026-07-28T11:00:00Z", session_id: "s2", user_name: "bob", model: "gpt-4.1", intent: "build", input_tokens: 50, output_tokens: 10, cost_usd: 0.005, status: "success", prompt: "build a playbook", response: "", approvals_count: 1, tool_call_detail: [] },
      ] }) }),
      listCases: () => ({ then: (r) => r({ ok: true, rows: [], total: 0, kpis: null }) }),
      listScheduledTasks: () => ({ then: (r) => r({ tasks: [] }) }),
      runScheduledTaskNow: () => ({ then: (r) => r({}) }),
      listHunts: () => ({ then: (r) => r({ ok: true, hunts: [] }) }),
      getShiftSummary: () => ({ then: (r) => r({ ok: true, handled: {}, text: "" }) }),
      listActiveSessions: () => ({ then: (r) => r({ sessions: [
        { session_id: "live1", status: "active", user: { name: "alice" }, record_module: "alerts", record_uuid: "u1", current_prompt: "triage this alert", turn_count: 3, last_activity: Date.now() / 1000 - 120 },
        { session_id: "wait1", status: "waiting_approval", user: null, record_module: null, record_uuid: null, current_prompt: "", turn_count: 1, last_activity: Date.now() / 1000 - 3600 },
        { session_id: "idle1", status: "idle", user: { name: "bob" }, record_module: "ztpf_devices", record_uuid: "u2", current_prompt: "list steps on this device", turn_count: 2, last_activity: Date.now() / 1000 - 90000 },
      ] }) }),
    };
  }

  test("a central decision sends the chat drawer's resume shape per card type", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    const action = { session_id: "s1", approval_id: "c1", card_id: "c1", card: { type: "action_card" } };
    expect($scope.decisionPayload(action, "approve")).toEqual(
      { session_id: "s1", decision: "approve", card_id: "c1" });
    const run = { session_id: "s2", approval_id: "a2", card_id: "a2", card: { type: "approval_request" } };
    // approval_id pops a live gate; card_id still executes the stored card after the TTL.
    expect($scope.decisionPayload(run, "reject")).toEqual(
      { session_id: "s2", decision: "reject", approval_id: "a2", card_id: "a2" });
  });

  test("a pending row reads the connector's human title before the raw summary", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    expect($scope.pendingTitle({ card: { title: "Change script on Loopback", summary: "Update ztpf_templates/7d76" } }))
      .toBe("Change script on Loopback");
    expect($scope.pendingTitle({ card: { summary: "Block 198.51.100.7 on the firewall" } }))
      .toBe("Block 198.51.100.7 on the firewall");
    expect($scope.pendingTitle({ card: null })).toBe("Approval waiting in the chat");
  });

  test("a sub-cent cost shows real digits, not $0.00 and not a raw float", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    // Under a cent keeps four places so the number is still legible...
    expect($scope.fmtCost(0.0023456)).toBe("0.0023");
    // ...and a cent or more rounds to two, never a long tail.
    expect($scope.fmtCost(1.23456)).toBe("1.23");
    expect($scope.fmtCost(0)).toBe("0.0000");
    expect($scope.fmtCost(undefined)).toBe("0.0000");
  });

  test("the target is only appended when the title does not already name it", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    // Title already says "on the firewall": no second target suffix.
    expect($scope.pendingTarget({ card: { summary: "Block 198.51.100.7 on FortiGate", target: { name: "FortiGate" } } }))
      .toBe("");
    // Title does not name it: surface the target.
    expect($scope.pendingTarget({ card: { title: "Block 198.51.100.7", target: { name: "FortiGate" } } }))
      .toBe("FortiGate");
    // The name appears mid-title, not as the " on <target>" suffix: the
    // structured target is still shown, never hidden by an incidental match.
    expect($scope.pendingTarget({ card: { title: "Review FortiGate rule on Edge-FW", target: { name: "FortiGate" } } }))
      .toBe("FortiGate");
    expect($scope.pendingTarget({ card: { title: "Block", target: null } })).toBe("");
  });

  test("tiles come from the uncapped server summary, not the 500-capped list", () => {
    // The list is capped at 500 rows; the summary is not. Give them different
    // answers and assert the tiles follow the summary.
    const svc = Object.assign({}, cannedService(), {
      getUsageSummary: (params) => {
        const v = { turns: [700, 300], tokens: [90000, 10000], cost: [1.25, 0.75] }[params.metric];
        return { then: (r) => r({ summary: [{ bucket: "2026-07-26", value: v[0] }, { bucket: "2026-07-27", value: v[1] }] }) };
      },
    });
    const { $scope } = makeController(svc);
    $scope.$apply();
    expect($scope.usage.length).toBe(3); // the capped list still loads
    expect($scope.totals.turns).toBe(1000);
    expect($scope.totals.tokens).toBe(100000);
    expect($scope.totals.cost).toBe(2);
    expect($scope.sparkTurns).toBeTruthy();
  });

  test("loads overview and computes totals", () => {
    const { $scope, $q } = makeController(cannedService());
    // The controller called listUsage/getUsageSummary/listPending at init via
    // $q.all; flush the digest so the .then callbacks run.
    $scope.$apply();
    expect($scope.totals.turns).toBe(3);
    expect($scope.totals.tokens).toBe(420); // 120 + 240 + 60
    expect($scope.totals.cost).toBeCloseTo(0.035, 5);
    expect($scope.totals.pending).toBe(1);
  });

  test("per-user rollup aggregates by user name, sorted by cost desc", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    const users = $scope.users();
    expect(users.length).toBe(2);
    expect(users[0].name).toBe("alice"); // 0.03 > 0.005
    expect(users[0].turns).toBe(2);
    expect(users[0].tokens).toBe(360);
    expect(users[1].name).toBe("bob");
    expect(users[1].turns).toBe(1);
  });

  test("area chart path is built from the summary", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    expect($scope.costAreaPath).toBeTruthy();
    expect($scope.costAreaPath.startsWith("M")).toBe(true);
    expect($scope.costAreaFill).toContain("Z");
    // Labels carry both text and a percentage that must match the path's own
    // x scale -- the old build positioned them on an unrelated 0..400 scale.
    expect($scope.costAreaLabels[0].leftPct).toBe(0);
    expect($scope.costAreaLabels[$scope.costAreaLabels.length - 1].leftPct).toBe(100);
    $scope.costAreaLabels.forEach((l) => {
      expect(l.text).toMatch(/^\d{2}-\d{2}$/);
      expect(l.leftPct).toBeGreaterThanOrEqual(0);
      expect(l.leftPct).toBeLessThanOrEqual(100);
    });
  });

  // ── Bucket zero-fill (defect: two-point "trend" over a 7d axis) ──────────

  test("area chart zero-fills every bucket across the range", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    // The service returns 2 populated day buckets; the chart must still span
    // the whole 7d window, with 0 on the days that had no traffic.
    expect($scope.summary.length).toBe(DAY_BUCKETS);
    expect($scope.summary[0]).toEqual({ bucket: "2026-07-21", value: 0 });
    const byBucket = {};
    $scope.summary.forEach((b) => { byBucket[b.bucket] = b.value; });
    expect(byBucket["2026-07-26"]).toBe(0.02);
    expect(byBucket["2026-07-27"]).toBe(0.015);
    expect(byBucket["2026-07-28"]).toBe(0); // quiet day, not omitted
    // One vertex per bucket -- not a single M..L segment across the panel.
    expect(($scope.costAreaPath.match(/[ML]/g) || []).length).toBe(DAY_BUCKETS);
  });

  test("sparklines zero-fill too, so a quiet day reads as zero", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    expect(($scope.sparkTurns.match(/[ML]/g) || []).length).toBe(DAY_BUCKETS);
    // Zero-based: the quiet days sit on the sparkline floor (h - pad = 25).
    expect($scope.sparkTurns).toContain(",25.0");
  });

  test("costAreaMax exposes the peak so the area has a magnitude", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    expect($scope.costAreaMax).toBeCloseTo(0.02, 5);
  });

  test("sparkline paths are built from per-day usage buckets", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    expect($scope.sparkTurns).toBeTruthy();
    expect($scope.sparkCost).toBeTruthy();
    expect($scope.sparkTokens).toBeTruthy();
  });

  test("defaults config when none provided", () => {
    const { $scope } = makeController(cannedService());
    expect($scope.config.title).toBe("Agentic Assistant Monitor");
    expect($scope.config.range).toBe("7d");
    expect($scope.activeTab).toBe("queue");
  });

  test("a single populated day still draws a full-range chart", () => {
    // Previously this triggered an "only 1 bucket -> re-query hourly" fallback,
    // which papered over the real problem (no zero-fill). Zero-fill removes the
    // need for it: one populated day inside a 7d window is a spike, not a
    // reason to change granularity.
    const requested = [];
    const singleDayService = Object.assign({}, cannedService(), {
      getUsageSummary: (params) => {
        requested.push(params.bucket);
        return { then: (r) => r({ summary: [{ bucket: "2026-07-28", value: 0.02 }] }) };
      },
    });
    const { $scope } = makeController(singleDayService);
    $scope.$apply();
    expect(Array.from(new Set(requested))).toEqual(["day"]); // no second, hourly round-trip
    expect($scope.summary.length).toBe(DAY_BUCKETS);
    expect($scope.costAreaPath).toBeTruthy();
    expect($scope.summary[DAY_BUCKETS - 1].value).toBe(0.02);
  });

  test("a 24h range buckets hourly", () => {
    const requested = [];
    const service = Object.assign({}, cannedService(), {
      getUsageSummary: (params) => {
        requested.push(params.bucket);
        return { then: (r) => r({ summary: [{ bucket: "2026-07-28T10:00:00", value: 0.005 }] }) };
      },
    });
    let $scope;
    ngModule("cybersponse", ($provide) => {
      $provide.value("config", { range: "24h" });
      $provide.value("fsrMonitorAgentService", service);
    });
    ngInject((_$rootScope_, _$controller_, _$q_) => {
      $scope = _$rootScope_.$new();
      const $interval = function () { return 0; };
      $interval.cancel = function () {};
      _$controller_(CTRL_NAME, { $scope, config: { range: "24h" },
        $interval, $q: _$q_, fsrMonitorAgentService: service });
    });
    $scope.$apply();
    expect(Array.from(new Set(requested))).toEqual(["hour"]);
    expect($scope.summary.length).toBe(25); // 24h inclusive of both endpoints
    expect($scope.costAreaLabels[0].text).toMatch(/^\d{2}:\d{2}$/);
  });

  test("setTab('sessions') loads live sessions", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    expect($scope.liveSessions.length).toBe(0); // not loaded until tab opened
    $scope.setTab("sessions");
    $scope.$apply();
    expect($scope.liveSessions.length).toBe(3);
    expect($scope.liveSessions[0].status).toBe("active");
  });

  test("sessionStatusClass maps active/waiting/idle to badge classes", () => {
    const { $scope } = makeController(cannedService());
    expect($scope.sessionStatusClass("active")).toBe("on");
    expect($scope.sessionStatusClass("waiting_approval")).toBe("waiting");
    expect($scope.sessionStatusClass("idle")).toBe("paused");
  });

  test("sessionAgo renders relative last-activity", () => {
    const { $scope } = makeController(cannedService());
    const now = Date.now() / 1000;
    expect($scope.sessionAgo({ last_activity: now - 5 })).toBe("just now");
    expect($scope.sessionAgo({ last_activity: now - 120 })).toBe("2m ago");
    expect($scope.sessionAgo({ last_activity: now - 3600 })).toBe("1h ago");
    expect($scope.sessionAgo({ last_activity: now - 90000 })).toBe("1d ago");
    expect($scope.sessionAgo({})).toBe("--");
  });

  test("openInChat broadcasts an openSession event (forward seam)", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    let captured = null;
    $scope.$root.$on("fsrAgenticAssistant:openSession", (e, data) => { captured = data; });
    $scope.openInChat({ session_id: "live1", record_module: "alerts", record_uuid: "u1" });
    $scope.$apply();
    expect(captured).not.toBeNull();
    expect(captured.session_id).toBe("live1");
    expect(captured.record_uuid).toBe("u1");
  });

  // Live on 8.0: after leaving a page with the chat open, the drawer group's
  // closeModal() hides #custom-modal but leaves activeWidget naming the chat.
  // "Open in chat" treated that as "already open" and never re-launched, so
  // the drawer stayed hidden (seen on a build session, which has no record).
  describe("Open in chat with a stale drawer activeWidget", () => {
    let drawer, modal, drawerScope;
    beforeEach(() => {
      modal = document.createElement("div");
      modal.id = "custom-modal";
      drawer = document.createElement("div");
      drawer.id = "global-drawer";
      document.body.appendChild(modal);
      document.body.appendChild(drawer);
    });
    afterEach(() => { modal.remove(); drawer.remove(); });

    function mountDrawer($scope, modalDisplay) {
      modal.style.display = modalDisplay;
      drawerScope = $scope.$root.$new(true);
      drawerScope.widgets = [{ name: "agenticAssistant", version: "1.2.70",
        metadata: { drawerVisibility: true, view: { popup: "custom" } } }];
      drawerScope.activeWidget = "agenticAssistant_1.2.70";
      drawerScope.launchWidget = jest.fn();
      window.angular.element(drawer).data("$isolateScope", drawerScope); // eslint-disable-line no-undef
    }

    const buildSession = { session_id: "sess-build-1", record_module: null, record_uuid: null };

    test("re-launches when the chat is active but the drawer is hidden", () => {
      const { $scope } = makeController(cannedService());
      $scope.$apply();
      mountDrawer($scope, "none");
      $scope.openInChat(buildSession);
      expect(drawerScope.launchWidget).toHaveBeenCalledTimes(1);
      expect(drawerScope.launchWidget.mock.calls[0][0]).toBe("agenticAssistant");
    });

    test("does not re-launch when the chat drawer is already showing", () => {
      const { $scope } = makeController(cannedService());
      $scope.$apply();
      mountDrawer($scope, "inline");
      $scope.openInChat(buildSession);
      expect(drawerScope.launchWidget).not.toHaveBeenCalled();
    });
  });

  test("loadAudit initializes rows collapsed and exposes tool-call counts", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    $scope.setTab("audit");
    $scope.$apply();
    expect($scope.audit.length).toBe(2);
    expect($scope.audit[0]._expanded).toBe(false);
    expect($scope.toolCallCount($scope.audit[0])).toBe(2);
    expect($scope.toolCallCount($scope.audit[1])).toBe(0);
  });

  test("toggleAuditRow flips the expand state", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    $scope.setTab("audit");
    $scope.$apply();
    const a = $scope.audit[0];
    expect(a._expanded).toBe(false);
    $scope.toggleAuditRow(a);
    expect(a._expanded).toBe(true);
    $scope.toggleAuditRow(a);
    expect(a._expanded).toBe(false);
  });

  test("toolCallParams pretty-prints objects and dashes nulls", () => {
    const { $scope } = makeController(cannedService());
    expect($scope.toolCallParams({ params: { a: 1 } })).toBe('{\n  "a": 1\n}');
    expect($scope.toolCallParams({ params: null })).toBe("--");
    expect($scope.toolCallParams({ params: "raw" })).toBe("raw");
  });

  test("toolCallStatusClass maps success/error", () => {
    const { $scope } = makeController(cannedService());
    expect($scope.toolCallStatusClass("success")).toBe("on");
    expect($scope.toolCallStatusClass("error")).toBe("error");
    expect($scope.toolCallStatusClass("unknown")).toBe("paused");
  });

  test("toolCallLatency formats ms and seconds", () => {
    const { $scope } = makeController(cannedService());
    expect($scope.toolCallLatency(120)).toBe("120ms");
    expect($scope.toolCallLatency(1500)).toBe("1.5s");
    expect($scope.toolCallLatency(null)).toBe("--");
  });

  test("showTurnDetail / closeTurnDetail toggle the overlay state", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    expect($scope.turnDetail).toBeNull();
    const row = { ts: "2026-07-28T10:00:00Z", prompt: "triage this", response: "benign", tool_call_detail: [], approvals_count: 0 };
    $scope.showTurnDetail(row);
    expect($scope.turnDetail).toBe(row);
    $scope.closeTurnDetail();
    expect($scope.turnDetail).toBeNull();
  });

  test("audit rows carry response + approvals_count from the connector", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    $scope.setTab("audit");
    $scope.$apply();
    // The canned audit data has response + approvals on the first row
    expect($scope.audit[0]).toHaveProperty("response");
    expect($scope.audit[0]).toHaveProperty("approvals_count");
  });

  // ── Interactive filters (§10.4) ─────────────────────────────────────────

  test("toggleFilter sets and clears a filter", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    $scope.setTab("audit"); // `status` is an audit-panel key
    expect($scope.activeFilters).toEqual({});
    expect($scope.hasActiveFilters()).toBe(false);
    $scope.toggleFilter("status", "error");
    expect($scope.activeFilters.status).toBe("error");
    expect($scope.hasActiveFilters()).toBe(true);
    // Toggle again -> clears
    $scope.toggleFilter("status", "error");
    expect($scope.activeFilters.status).toBeUndefined();
    expect($scope.hasActiveFilters()).toBe(false);
  });

  test("toggleFilter supports multiple independent filters", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    $scope.toggleFilter("status", "error");
    $scope.toggleFilter("intent", "triage");
    expect(Object.keys($scope.activeFilters).length).toBe(2);
    expect($scope.activeFilters.status).toBe("error");
    expect($scope.activeFilters.intent).toBe("triage");
  });

  test("clearFilter removes one filter without touching others", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    $scope.toggleFilter("status", "error");
    $scope.toggleFilter("intent", "build");
    $scope.clearFilter("status");
    expect($scope.activeFilters.status).toBeUndefined();
    expect($scope.activeFilters.intent).toBe("build");
  });

  test("clearAllFilters wipes everything", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    $scope.toggleFilter("status", "error");
    $scope.toggleFilter("intent", "triage");
    $scope.toggleFilter("model", "gpt-4.1");
    $scope.clearAllFilters();
    expect($scope.hasActiveFilters()).toBe(false);
    expect(Object.keys($scope.activeFilters).length).toBe(0);
  });

  test("loadAudit passes active filters to the service", () => {
    const auditCalls = [];
    const service = cannedService();
    service.getAuditTrail = (params) => {
      auditCalls.push(params);
      return { then: (r) => r({ usage: [] }) };
    };
    const { $scope } = makeController(service);
    $scope.$apply();
    $scope.toggleFilter("status", "error");
    $scope.setTab("audit");
    $scope.$apply();
    // The last getAuditTrail call should include status=error
    const lastCall = auditCalls[auditCalls.length - 1];
    expect(lastCall.status).toBe("error");
  });

  // ── Filters actually reach the panel they claim to filter ───────────────
  // These are the regressions the old suite couldn't see: it only ever
  // asserted that loadAudit forwards filters, and never asserted the VALUE
  // shape of one. Both live defects hid in that gap.

  test("loadLiveSessions forwards the session filters to the service", () => {
    const calls = [];
    const service = cannedService();
    service.listActiveSessions = (params) => {
      calls.push(params);
      return { then: (r) => r({ sessions: [] }) };
    };
    const { $scope } = makeController(service);
    $scope.$apply();
    // This is exactly what the "Pending HITL" KPI card does.
    $scope.toggleFilter("session_status", "waiting_approval");
    $scope.setTab("sessions");
    $scope.$apply();
    const last = calls[calls.length - 1];
    // The widget key is session_status; the op's param is status.
    expect(last.status).toBe("waiting_approval");
    expect(last.limit).toBe(50);
  });

  test("a session-status filter never leaks into the audit query", () => {
    // `status` means active/waiting_approval/idle for sessions but
    // success/error for audit rows. Sending one into the other returns zero
    // rows -- that is how the Pending drill-down emptied the audit trail.
    const auditCalls = [];
    const service = cannedService();
    service.getAuditTrail = (params) => {
      auditCalls.push(params);
      return { then: (r) => r({ usage: [] }) };
    };
    const { $scope } = makeController(service);
    $scope.$apply();
    $scope.toggleFilter("session_status", "waiting_approval");
    $scope.setTab("audit");
    $scope.$apply();
    expect(auditCalls[auditCalls.length - 1].status).toBeUndefined();
  });

  test("chips only render on panels that honour them", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    $scope.toggleFilter("session_status", "waiting_approval");
    // The queue ignores filters entirely -- no chip may claim to be active.
    expect($scope.activeTab).toBe("queue");
    expect($scope.hasActiveFilters()).toBe(false);
    $scope.setTab("sessions");
    expect($scope.hasActiveFilters()).toBe(true);
    expect($scope.visibleFilters()).toEqual({ session_status: "waiting_approval" });
    $scope.setTab("audit");
    expect($scope.hasActiveFilters()).toBe(false);
  });

  test("visibleFilters is referentially stable across digests (no infdig)", () => {
    const { $scope } = makeController(cannedService());
    $scope.$apply();
    $scope.setTab("sessions");
    $scope.toggleFilter("session_status", "idle");
    expect($scope.visibleFilters()).toBe($scope.visibleFilters());
  });

  test("the user filter sends the IRI, not the display name", () => {
    const auditCalls = [];
    const service = cannedService();
    service.listUsage = () => ({ then: (r) => r({ usage: [
      { ts: "2026-07-27T10:00:00Z", user_name: "CS Admin",
        user_iri: "/api/3/people/abc-123", input_tokens: 10, output_tokens: 2,
        cost_usd: 0.001, status: "success" },
    ] }) });
    service.getAuditTrail = (params) => {
      auditCalls.push(params);
      return { then: (r) => r({ usage: [] }) };
    };
    const { $scope } = makeController(service);
    $scope.$apply();
    const u = $scope.users()[0];
    expect(u.name).toBe("CS Admin");
    expect(u.iri).toBe("/api/3/people/abc-123");
    $scope.filterByUser(u);
    $scope.$apply();
    // The wire value must be the IRI (the old build sent "CS Admin", which
    // matched nothing and emptied the audit trail)...
    expect(auditCalls[auditCalls.length - 1].user_iri).toBe("/api/3/people/abc-123");
    // ...while the chip still reads as the human name.
    expect($scope.filterLabel("user_iri")).toBe("CS Admin");
  });

  test("users with no IRI can't be drilled into", () => {
    const service = cannedService();
    service.listUsage = () => ({ then: (r) => r({ usage: [
      { ts: "2026-07-27T10:00:00Z", input_tokens: 10, output_tokens: 2,
        cost_usd: 0.001, status: "success" },
    ] }) });
    const { $scope } = makeController(service);
    $scope.$apply();
    const u = $scope.users()[0];
    expect(u.name).toBe("(unknown)");
    expect($scope.canFilterUser(u)).toBe(false);
    $scope.filterByUser(u);
    expect($scope.activeFilters.user_iri).toBeUndefined();
  });

  // ── Escalations (autonomous tier-1) ─────────────────────────────────────

  function escalationService(overrides) {
    const service = cannedService();
    service.listPending = () => ({ then: (r) => r({
      pending: [
        { approval_id: "c1", card_id: "c1", session_id: "auto:alerts:u1", age_seconds: 60,
          card: { type: "action_card", title: "Block 198.51.100.7 on FortiGate" } },
        { approval_id: "c2", card_id: "c2", session_id: "s-analyst", age_seconds: 30,
          card: { type: "action_card", title: "Change description" } },
      ],
      escalations: [
        { session_id: "auto:alerts:u1", card_id: "esc_u1", priority: "P1", priority_rank: 1,
          age_seconds: 5400, record: { name: "Beacon to 198.51.100.7", module: "alerts", uuid: "u1" },
          verdict: { disposition: "true_positive", confidence: 0.92 },
          reasons: ["1 action waiting for approval."], approvals: 1 },
      ],
    }) });
    service.resolveEscalation = jest.fn(() => ({ then: (r) => r({ ok: true }) }));
    service.decidePending = jest.fn(() => ({ then: (r) => r({ ok: true }) }));
    return Object.assign(service, overrides || {});
  }

  test("an escalation's approvals are listed under it, not again in the plain table", () => {
    const { $scope } = makeController(escalationService());
    $scope.$apply();
    expect($scope.escApprovals["auto:alerts:u1"].map((p) => p.card_id)).toEqual(["c1"]);
    expect($scope.otherPending.map((p) => p.card_id)).toEqual(["c2"]);
    expect($scope.queueCount).toBe(3); // 2 approvals + 1 escalation
  });

  test("approving an escalation's action takes it from under the escalation", () => {
    const { $scope } = makeController(escalationService());
    $scope.$apply();
    $scope.decidePending($scope.escApprovals["auto:alerts:u1"][0], "approve");
    expect($scope.escApprovals["auto:alerts:u1"]).toEqual([]);
    expect($scope.escalations.length).toBe(1); // still needs a human to close it
    expect($scope.queueCount).toBe(2);
  });

  test("the KPI tile and the Pending badge count the same queue, escalations included", () => {
    const { $scope } = makeController(escalationService());
    $scope.$apply();
    expect($scope.queueCount).toBe(3); // 2 approvals + 1 escalation
    expect($scope.totals.pending).toBe($scope.queueCount);
  });

  test("resolving an escalation takes it off the KPI tile as well as the badge", () => {
    const { $scope } = makeController(escalationService());
    $scope.$apply();
    $scope.resolveEscalation($scope.escalations[0], "handled");
    expect($scope.queueCount).toBe(2);
    expect($scope.totals.pending).toBe(2);
  });

  test("the verdict and age read in a reviewer's words", () => {
    const { $scope } = makeController(escalationService());
    $scope.$apply();
    expect($scope.verdictLine($scope.escalations[0])).toBe("True positive, 92% confident");
    expect($scope.verdictLine({ verdict: null })).toBe("No verdict");
    expect($scope.verdictLine({ verdict: { disposition: "needs_more_info" } })).toBe("Needs more information");
    expect($scope.ageText(30)).toBe("1m");
    expect($scope.ageText(5400)).toBe("1.5h");
    expect($scope.ageText(3 * 86400)).toBe("3d");
  });

  test("Mark handled resolves it as the reviewer and takes it off the queue", () => {
    const service = escalationService();
    const { $scope } = makeController(service);
    $scope.$apply();
    $scope.currentUser = { name: "Lead A", iri: "/api/3/people/lead-a" };
    $scope.resolveEscalation($scope.escalations[0], "handled");
    expect(service.resolveEscalation).toHaveBeenCalledWith({
      session_id: "auto:alerts:u1", card_id: "esc_u1", outcome: "handled",
      actor: { name: "Lead A", iri: "/api/3/people/lead-a" } });
    expect($scope.escalations).toEqual([]);
    // Its approval was not decided, so it now stands on its own in the queue.
    expect($scope.otherPending.map((p) => p.card_id)).toEqual(["c1", "c2"]);
  });

  test("an escalation someone else resolved says who and stays disabled", () => {
    const service = escalationService({
      resolveEscalation: jest.fn(() => ({ then: (r) => r({ ok: false, error: {
        code: "already_decided", message: "This escalation was already dismissed by Lead B." } }) })),
    });
    const { $scope } = makeController(service);
    $scope.$apply();
    const e = $scope.escalations[0];
    $scope.resolveEscalation(e, "handled");
    expect($scope.escDecisionFor(e)).toEqual({ state: "taken",
      message: "This escalation was already dismissed by Lead B." });
    $scope.resolveEscalation(e, "handled");
    expect(service.resolveEscalation).toHaveBeenCalledTimes(1);
  });

  // ── A panel whose fetch failed is not an empty panel ─────────────────────

  test.each([
    ["sessions", "listActiveSessions", "loadLiveSessions"],
    ["scheduled", "listScheduledTasks", "loadScheduled"],
    ["audit", "getAuditTrail", "loadAudit"],
  ])("a failed %s fetch says it failed, never 'nothing here'", (panel, op, load) => {
    const service = cannedService();
    service[op] = () => ({ then: (ok, fail) => fail({ message: "Gateway dropped the request." }) });
    const { $scope } = makeController(service);
    $scope.$apply();
    $scope[load]();
    expect($scope.isPanelLoading(panel)).toBe(false);
    expect($scope.panelFailed[panel]).toBe("Gateway dropped the request.");
    expect($scope.isPanelEmpty(panel, [])).toBe(false);
    // The panel says it failed; the page banner is for the overview only.
    expect($scope.error).toBe("");
  });

  test("a panel that failed and then loads clears its failure", () => {
    const service = cannedService();
    let fail = true;
    const realList = service.listActiveSessions;
    service.listActiveSessions = (f) => (fail
      ? { then: (ok, bad) => bad({ message: "dropped" }) } : realList(f));
    const { $scope } = makeController(service);
    $scope.$apply();
    $scope.loadLiveSessions();
    fail = false;
    $scope.loadLiveSessions();
    expect($scope.panelFailed.sessions).toBe("");
    expect($scope.liveSessions.length).toBe(3);
  });
  describe("autonomy (shadow) wording", () => {
    function scope() { return makeController(cannedService()).$scope; }

    test("no policy, off, unreadable, shadow and an enforce request each read plainly", () => {
      const $scope = scope();
      $scope.shadow.policy = null;
      expect($scope.policyLine()).toBe("No autonomy policy is set. Every action waits for a reviewer.");
      $scope.shadow.policy = { enabled: false, rules: ["r"] };
      expect($scope.policyLine()).toBe("The autonomy policy is switched off.");
      $scope.shadow.policy = { error: "not valid JSON" };
      expect($scope.policyLine()).toContain("could not be read, so it is ignored: not valid JSON");
      $scope.shadow.policy = { enabled: true, mode: "shadow", rules: ["a", "b"] };
      expect($scope.policyLine()).toBe(
        "The autonomy policy (2 rules) is recording only; every action still waits for a reviewer.");
      // Enforce acts only in unattended triage: say exactly that.
      $scope.shadow.policy = { enabled: true, mode: "enforce", rules: ["a"] };
      expect($scope.policyLine()).toBe(
        "The autonomy policy (1 rule) acts on its own in unattended triage; chats still wait for a reviewer.");
    });

    test("the autonomy load keeps the per-detection-rule close counts", () => {
      const tuning = [{ source: "FortiSIEM", rule: "Port scan", closed: 3, reopened: 1, last_at: 1 }];
      const withTuning = makeController({ ...cannedService(),
        listShadowDecisions: () => ({ then: (r) => r({ rules: [], decisions: [], tuning, policy: null }) }),
      }).$scope;
      withTuning.loadShadow();
      expect(withTuning.shadow.tuning).toEqual(tuning);
    });

    test("an older connector that sends no close counts leaves the table empty", () => {
      const older = makeController({ ...cannedService(),
        listShadowDecisions: () => ({ then: (r) => r({ rules: [], decisions: [], policy: null }) }),
      }).$scope;
      older.loadShadow();
      expect(older.shadow.tuning).toEqual([]);
    });

    const DOC = {
      version: 1, enabled: true, mode: "shadow",
      rules: [{
        id: "block-external-ip",
        action: { connector: "fortigate-firewall", op: "block_ip" },
        when: {
          verdict: { disposition: ["true_positive"], min_confidence: 0.9 },
          target: { kind: "ip", external_only: true, not_in: "protected_ips" },
          evidence: { rated: "malicious" },
        },
        limits: { per_hour: 10, per_target_per_day: 1 },
      }],
    };

    test("the full policy document is captured and rendered in plain words", () => {
      const $scope = makeController({ ...cannedService(),
        listShadowDecisions: () => ({ then: (r) => r({ rules: [], decisions: [], tuning: [], policy: { enabled: true, mode: "shadow", rules: ["block-external-ip"] }, policy_document: DOC }) }),
      }).$scope;
      $scope.loadShadow();
      expect($scope.policyDoc).toEqual(DOC);
      const r = $scope.policyRules()[0];
      expect($scope.ruleAction(r)).toBe("Block an IP on FortiGate");
      expect($scope.ruleWhen(r)).toBe(
        "verdict true positive at 90%+; target ip, external only, not in protected_ips; evidence rates it malicious");
      expect($scope.ruleLimits(r)).toBe("10/hour, 1/target/day");
    });

    // What the builder itself authors: an evidence-gated FP close. The builder
    // must round-trip this losslessly (document -> form -> document).
    const CANON = {
      version: 1, enabled: true, mode: "shadow",
      rules: [{
        id: "close-false-positive",
        action: { tool: "update_record", module: "alerts",
                  fields: ["status", "resolution", "closureNotes"],
                  values: { status: ["Closed"] } },
        when: { verdict: { disposition: ["false_positive", "benign"], min_confidence: 0.8 },
                target: { kind: "record" }, evidence: { cites_tool_kind: "read" } },
        limits: { per_hour: 20 },
      }],
    };

    test("the builder round-trips a close rule losslessly (no JSON)", () => {
      const $scope = scope();
      const builder = $scope._policyToBuilder(CANON);
      expect(builder.mode).toBe("shadow");
      expect(builder.rules[0].actionKey).toBe("close");
      expect(builder.rules[0].disp).toEqual({ false_positive: true, benign: true });
      expect(builder.rules[0].minConfidence).toBe(80);
      expect(builder.rules[0].setResolution).toBe(true);
      expect(builder.rules[0].requireLookup).toBe(true);
      expect($scope._builderToPolicy(builder, CANON)).toEqual(CANON);
    });

    test("a rule the form cannot represent is kept read-only and saved unchanged", () => {
      const $scope = scope();
      const EXOTIC = { version: 1, enabled: true, mode: "shadow", rules: [
        { id: "custom", action: { tool: "run_playbook", playbook: "x" },
          when: { verdict: { disposition: ["true_positive"], min_confidence: 0.9 } },
          undo: { kind: "reopen" } },
      ] };
      const builder = $scope._policyToBuilder(EXOTIC);
      expect(builder.rules[0].supported).toBe(false);
      // Saved exactly as read: the action is NOT recast to a close, and the
      // undo clause the form does not model survives.
      expect($scope._builderToPolicy(builder, EXOTIC)).toEqual(EXOTIC);
    });

    test("editing a close rule preserves rule-level fields the form does not model", () => {
      const $scope = scope();
      const WITH_UNDO = { version: 1, enabled: true, mode: "shadow", rules: [{
        id: "close-false-positive",
        action: { tool: "update_record", module: "alerts", fields: ["status"], values: { status: ["Closed"] } },
        when: { verdict: { disposition: ["false_positive"], min_confidence: 0.8 },
                target: { kind: "record" }, evidence: { cites_tool_kind: "read" } },
        undo: { kind: "reopen" },
      }] };
      const back = $scope._builderToPolicy($scope._policyToBuilder(WITH_UNDO), WITH_UNDO);
      expect(back.rules[0].undo).toEqual({ kind: "reopen" });
    });

    test("an update_record rule that is not a close is read-only, never recast to a close", () => {
      const $scope = scope();
      // Writes owner -- NOT a status-to-Closed close. The form must not present
      // it as an editable close and rebuild it on save.
      const NOT_A_CLOSE = { version: 1, enabled: true, mode: "shadow", rules: [{
        id: "reassign", action: { tool: "update_record", module: "alerts",
          fields: ["owner"], values: { owner: ["/api/3/people/x"] } },
        when: { verdict: { disposition: ["suspicious"], min_confidence: 0.5 } },
      }] };
      const builder = $scope._policyToBuilder(NOT_A_CLOSE);
      expect(builder.rules[0].supported).toBe(false);
      expect($scope._builderToPolicy(builder, NOT_A_CLOSE)).toEqual(NOT_A_CLOSE);
    });

    test("a wrong status pin (not Closed) is not treated as a close", () => {
      const $scope = scope();
      const REOPEN = { version: 1, enabled: true, mode: "shadow", rules: [{
        id: "reopen", action: { tool: "update_record", module: "alerts",
          fields: ["status"], values: { status: ["Reopened"] } },
        when: { verdict: { disposition: ["suspicious"], min_confidence: 0.5 } },
      }] };
      expect($scope._policyToBuilder(REOPEN).rules[0].supported).toBe(false);
    });

    test("the builder does not open on a stale copy when the fresh read fails", () => {
      const $scope = makeController({ ...cannedService(),
        getAutonomyPolicy: () => ({ then: (_ok, fail) => fail(new Error("offline")) }),
      }).$scope;
      $scope.openPolicyBuilder();
      expect($scope.policyBuilder.open).toBe(false);
      expect($scope.policyBuilder.error).toContain("could not be read");
    });

    test("every top-level policy field the form does not model is preserved on save", () => {
      const $scope = scope();
      const EXTRA = { version: 3, enabled: true, mode: "shadow", protected: { protected_ips: ["198.51.100.4"] },
        future_knob: { x: 1 }, rules: [] };
      const back = $scope._builderToPolicy($scope._policyToBuilder(EXTRA), EXTRA);
      expect(back.version).toBe(3);
      expect(back.protected).toEqual({ protected_ips: ["198.51.100.4"] });
      expect(back.future_knob).toEqual({ x: 1 });
    });

    test("a stored block rule the preset list does not know is kept, not dropped", () => {
      const $scope = scope();
      // DOC's op is block_ip, not a built-in preset; reading it must not fall
      // back to a close or lose the connector/op.
      const builder = $scope._policyToBuilder(DOC);
      const row = builder.rules[0];
      expect($scope.ruleActionKind(row)).toBe("block");
      expect(row.externalOnly).toBe(true);
      expect(row.notIn).toBe("protected_ips");
      expect(row.disp).toEqual({ true_positive: true });
      expect(row.minConfidence).toBe(90);
      expect(row.perHour).toBe(10);
      const back = $scope._builderToPolicy(builder, DOC);
      expect(back.rules[0].action).toEqual({ connector: "fortigate-firewall", op: "block_ip" });
      expect(back.rules[0].when.target).toEqual({ kind: "ip", external_only: true, not_in: "protected_ips" });
    });

    test("opening the builder loads the stored document fresh as a form", () => {
      const $scope = makeController({ ...cannedService(),
        getAutonomyPolicy: () => ({ then: (r) => r({ ok: true, policy: CANON, valid: true }) }),
      }).$scope;
      $scope.openPolicyBuilder();
      expect($scope.policyBuilder.open).toBe(true);
      expect($scope.policyBuilder.mode).toBe("shadow");
      expect($scope.policyBuilder.rules.length).toBe(1);
      expect($scope.policyBuilder.rules[0].id).toBe("close-false-positive");
    });

    test("add a rule starts from a shadow-safe FP close; remove drops it", () => {
      const $scope = scope();
      $scope.policyBuilder.rules = [];
      $scope.addRule();
      expect($scope.policyBuilder.rules.length).toBe(1);
      const row = $scope.policyBuilder.rules[0];
      expect(row.supported).toBe(true); // editable, not read-only
      expect($scope.ruleActionKind(row)).toBe("close");
      expect(row.disp).toEqual({ false_positive: true, benign: true });
      expect(row.requireLookup).toBe(true);
      $scope.removeRule(0);
      expect($scope.policyBuilder.rules.length).toBe(0);
    });

    test("a rule with no verdict selected is refused client-side, never reaches the connector", () => {
      let called = false;
      const $scope = makeController({ ...cannedService(),
        setAutonomyPolicy: () => { called = true; return { then: (r) => r({ ok: true }) }; },
      }).$scope;
      $scope.policyBuilder.open = true;
      $scope.policyBuilder.rules = [{ id: "r1", supported: true, actionKey: "close", module: "alerts",
        disp: {}, minConfidence: 80, requireLookup: true }];
      $scope.savePolicyBuilder();
      expect(called).toBe(false);
      expect($scope.policyBuilder.error).toContain("at least one verdict");
    });

    test("an unnamed or duplicate rule is refused client-side", () => {
      const $scope = scope();
      $scope.policyBuilder.rules = [{ id: "", actionKey: "close", disp: { benign: true }, minConfidence: 80 }];
      $scope.savePolicyBuilder();
      expect($scope.policyBuilder.error).toContain("needs a name");
      $scope.policyBuilder.rules = [
        { id: "dup", actionKey: "close", disp: { benign: true }, minConfidence: 80 },
        { id: "dup", actionKey: "close", disp: { benign: true }, minConfidence: 80 },
      ];
      $scope.savePolicyBuilder();
      expect($scope.policyBuilder.error).toContain("own name");
    });

    test("a successful save serializes the form to a document, closes, and refreshes", () => {
      let reloaded = 0, sent = null;
      const $scope = makeController({ ...cannedService(),
        setAutonomyPolicy: (doc) => { sent = doc; return { then: (r) => r({ ok: true }) }; },
        listShadowDecisions: () => { reloaded += 1; return { then: (r) => r({ rules: [], decisions: [], tuning: [], policy: null, policy_document: CANON }) }; },
      }).$scope;
      $scope.policyBuilder = { ...$scope.policyBuilder, open: true, enabled: true, mode: "enforce",
        rules: $scope._policyToBuilder(CANON).rules };
      $scope.savePolicyBuilder();
      expect(sent.mode).toBe("enforce");
      expect(sent.rules[0].id).toBe("close-false-positive");
      expect(sent.rules[0].action.values).toEqual({ status: ["Closed"] });
      expect($scope.policyBuilder.open).toBe(false);
      expect($scope.policyBuilder.error).toBe(null);
      expect(reloaded).toBeGreaterThan(0);
    });

    test("a connector refusal (not a reviewer / invalid) shows its message, builder stays open", () => {
      const $scope = makeController({ ...cannedService(),
        setAutonomyPolicy: () => ({ then: (r) => r({ ok: false, error: { code: "not_authorized", message: "Only reviewers can edit the autonomy policy." } }) }),
      }).$scope;
      $scope.policyBuilder.open = true;
      $scope.policyBuilder.rules = $scope._policyToBuilder(CANON).rules;
      $scope.savePolicyBuilder();
      expect($scope.policyBuilder.open).toBe(true);
      expect($scope.policyBuilder.error).toBe("Only reviewers can edit the autonomy policy.");
    });

    test("only would-run-it against a rejection is the miss", () => {
      const $scope = scope();
      const d = (outcome, human) => ({ policy: { outcome }, human });
      expect($scope.shadowIsMiss(d("would_act", "reject"))).toBe(true);
      expect($scope.shadowIsMiss(d("would_act", "approve"))).toBe(false);
      expect($scope.shadowIsMiss(d("would_act", null))).toBe(false);
      expect($scope.shadowIsMiss(d("would_not_act", "reject"))).toBe(false);
      expect($scope.shadowHuman({ human: "approve", actor: "lead" })).toBe("Approved by lead");
      expect($scope.shadowHuman({ human: null })).toBe("Not decided yet");
      expect($scope.shadowOutcome(d("would_not_act"))).toBe("Would ask");
    });

    test("an action the policy ran itself says so, and names no reviewer", () => {
      const $scope = scope();
      const ran = { policy: { outcome: "would_act", mode: "enforced" }, human: "approve",
                    actor: "system:autonomy" };
      expect($scope.shadowOutcome(ran)).toBe("Ran it");
      expect($scope.shadowHuman(ran)).toBe("Run by the policy, no reviewer");
      expect($scope.shadowIsMiss(ran)).toBe(false);
    });

    // ── One-click undo (phase D) ───────────────────────────────────────────
    const ran = (extra) => Object.assign({ session_id: "s1", card_id: "c1", human: "approve",
      executed: true, undone_at: null, undo: { connector: "fortigate-firewall", op: "unblock_ip" } }, extra || {});

    test("undo is offered only on an approved action that ran and has a reverse", () => {
      const $scope = scope();
      expect($scope.canUndo(ran())).toBe(true);
      expect($scope.canUndo(ran({ human: "reject" }))).toBe(false);
      expect($scope.canUndo(ran({ human: null }))).toBe(false);
      expect($scope.canUndo(ran({ executed: false }))).toBe(false);
      expect($scope.canUndo(ran({ executed: null }))).toBe(false);   // never recorded
      expect($scope.canUndo(ran({ undo: null }))).toBe(false);
      expect($scope.canUndo(ran({ undone_at: 1700000000 }))).toBe(false);
    });

    test("Undo sends the reviewer and marks the row undone", () => {
      const service = cannedService();
      service.undoAction = jest.fn(() => ({ then: (r) => r({ ok: true }) }));
      const { $scope } = makeController(service);
      $scope.currentUser = { name: "Lead A", iri: "/api/3/people/lead-a" };
      const d = ran();
      $scope.undoAction(d);
      expect(service.undoAction).toHaveBeenCalledWith({ session_id: "s1", card_id: "c1",
        actor: { name: "Lead A", iri: "/api/3/people/lead-a" } });
      expect($scope.undoneLine(d)).toBe("Undone by Lead A");
      expect($scope.canUndo(d)).toBe(false);
      $scope.undoAction(d);
      expect(service.undoAction).toHaveBeenCalledTimes(1);
    });

    test("an undo someone else did says who; a failed one can be tried again", () => {
      const service = cannedService();
      service.undoAction = jest.fn(() => ({ then: (r) => r({ ok: false, error: {
        code: "already_undone", message: "This action was already undone by Lead B.",
        undone: { undone_by: "Lead B", undone_at: 1700000000 } } }) }));
      const { $scope } = makeController(service);
      const d = ran();
      $scope.undoAction(d);
      expect($scope.undoStateFor(d)).toEqual({ state: "taken", message: "This action was already undone by Lead B." });
      expect($scope.undoneLine(d)).toBe("Undone by Lead B");

      service.undoAction = jest.fn(() => ({ then: (r) => r({ ok: false, error: {
        code: "undo_failed", message: "fortigate-firewall.unblock_ip failed: unreachable" } }) }));
      const d2 = ran({ card_id: "c2" });
      $scope.undoAction(d2);
      expect($scope.undoStateFor(d2).state).toBe("failed");
      expect($scope.canUndo(d2)).toBe(true);
    });
  });

  // ── The 60s poll must not tear the page down ───────────────────────────────
  // The whole body sat under one ng-if on `loading`, so every refresh unmounted
  // the tabs, the policy editor, the expanded audit rows and the scroll.

  describe("background refresh keeps the page mounted", () => {
    test("only the first load is a first-paint load; a refresh is not", () => {
      const service = cannedService();
      const { $scope } = makeController(service);
      expect($scope.initialLoading).toBe(true);
      $scope.$apply();
      expect($scope.initialLoading).toBe(false);
      // Hold the next overview fetch open so the page can be read mid-refresh.
      let release;
      service.listUsage = () => ({ then: (ok) => { release = () => ok({ usage: [] }); } });
      $scope.refresh();
      expect($scope.initialLoading).toBe(false);
      expect($scope.refreshing).toBe(true);
      expect($scope.isBusy()).toBe(true);
      release();
      $scope.$apply();
      expect($scope.refreshing).toBe(false);
      expect($scope.initialLoading).toBe(false);
      expect($scope.isBusy()).toBe(false);
    });

    test("a failed first load leaves the first-paint state and says why", () => {
      const service = cannedService();
      service.listUsage = () => ({ then: (ok, bad) => bad({ message: "Gateway dropped." }) });
      const { $scope } = makeController(service);
      $scope.$apply();
      expect($scope.initialLoading).toBe(false);
      expect($scope.error).toBe("Gateway dropped.");
    });

    test("an expanded audit row stays open when the trail reloads", () => {
      const { $scope } = makeController(cannedService());
      $scope.$apply();
      $scope.setTab("audit");
      $scope.$apply();
      $scope.toggleAuditRow($scope.audit[0]);
      $scope.refresh();
      $scope.$apply();
      expect($scope.audit[0]._expanded).toBe(true);
      expect($scope.audit[1]._expanded).toBe(false);
    });

    test("expand state follows its row when the trail reorders, not its position", () => {
      const service = cannedService();
      const { $scope } = makeController(service);
      $scope.$apply();
      $scope.setTab("audit");
      $scope.$apply();
      $scope.toggleAuditRow($scope.audit[0]); // the s1 row, open
      // A newer turn lands at the top: the open row moves down one place.
      const newest = { ts: "2026-07-28T12:00:00Z", session_id: "s3", user_name: "cara", model: "claude",
                       intent: "triage", status: "success", prompt: "new", tool_call_detail: [] };
      const [s1, s2] = [$scope.audit[0], $scope.audit[1]];
      service.getAuditTrail = () => ({ then: (r) => r({ usage: [newest, s1, s2] }) });
      $scope.loadAudit();
      $scope.$apply();
      expect($scope.audit.map((a) => a.session_id)).toEqual(["s3", "s1", "s2"]);
      expect($scope.audit[1]._expanded).toBe(true);
      expect($scope.audit[0]._expanded).toBe(false);
    });

    test("a reload shows the rows it just fetched, not the cached ones", () => {
      const service = cannedService();
      const rows = (status) => [
        { ts: "2026-07-28T10:00:00Z", session_id: "s1", model: "claude", intent: "triage", status: status, prompt: "p1", tool_call_detail: [] },
        { ts: "2026-07-28T11:00:00Z", session_id: "s2", model: "gpt-4.1", intent: "build", status: "success", prompt: "p2", tool_call_detail: [] },
      ];
      let current = rows("error");
      service.getAuditTrail = () => ({ then: (r) => r({ usage: current }) });
      const { $scope } = makeController(service);
      $scope.$apply();
      $scope.setTab("audit");
      $scope.$apply();
      expect($scope.filteredAudit()[0].status).toBe("error");
      // Same length, same first timestamp: only the status changed.
      current = rows("success");
      $scope.loadAudit();
      $scope.$apply();
      expect($scope.filteredAudit()[0].status).toBe("success");
    });

    test("a panel shows its spinner only until its first result, then keeps its empty state", () => {
      const service = cannedService();
      let release;
      service.listActiveSessions = () => ({ then: (ok) => { release = () => ok({ sessions: [] }); } });
      const { $scope } = makeController(service);
      $scope.$apply();
      $scope.setTab("sessions");
      expect($scope.isPanelLoading("sessions")).toBe(true);
      expect($scope.isPanelEmpty("sessions", $scope.liveSessions)).toBe(false);
      release();
      $scope.$apply();
      expect($scope.isPanelLoading("sessions")).toBe(false);
      expect($scope.isPanelEmpty("sessions", $scope.liveSessions)).toBe(true);
      // A reload of an empty panel is still an empty panel: no spinner in between.
      $scope.loadLiveSessions();
      expect($scope.isPanelLoading("sessions")).toBe(false);
      expect($scope.isPanelEmpty("sessions", $scope.liveSessions)).toBe(true);
    });
  });

  // ── Opening a tab and the poll must load the same panels ──────────────────
  // Two hand-written if-chains (setTab, refresh) had drifted: Autonomy loaded
  // on click and was never reloaded. The tab ids come from the template, so a
  // tab added there is covered here without touching this test.

  describe("opening a tab and the poll load the same panels", () => {
    const TAB_IDS = Array.from(new Set(
      [...require("fs").readFileSync(require("path").join(__dirname, "../widget/view.html"), "utf8")
        .matchAll(/setTab\('(\w+)'\)/g)].map((m) => m[1])));
    const OVERVIEW_OPS = ["listUsage", "getUsageSummary", "listPending"];

    function recordingService() {
      const svc = cannedService();
      svc.listShadowDecisions = () => ({ then: (r) => r({ rules: [], decisions: [], tuning: [], policy: null }) });
      const ops = [];
      Object.keys(svc).forEach((k) => {
        const real = svc[k];
        svc[k] = (...args) => { ops.push(k); return real(...args); };
      });
      return { svc, ops };
    }

    // One test per tab: angular-mocks cannot register a module once an
    // injector exists, so each controller needs its own spec.
    function openThenPoll(tab) {
      const { svc, ops } = recordingService();
      const { $scope } = makeController(svc);
      $scope.$apply();
      ops.length = 0;
      $scope.setTab(tab);
      $scope.$apply();
      const onOpen = ops.filter((op) => !OVERVIEW_OPS.includes(op));
      ops.length = 0;
      $scope.refresh();
      $scope.$apply();
      return { onOpen, onPoll: ops.slice() };
    }

    test("the tab ids are read from the template, including the Autonomy tab", () => {
      expect(TAB_IDS).toEqual(expect.arrayContaining(["overview", "audit", "scheduled", "sessions", "autonomy"]));
    });

    TAB_IDS.forEach((tab) => {
      test(`opening "${tab}" loads nothing the poll would miss`, () => {
        const { onOpen, onPoll } = openThenPoll(tab);
        const missing = onOpen.filter((op) => !onPoll.includes(op));
        expect({ tab, missing }).toEqual({ tab, missing: [] });
      });
    });

    // Not vacuous: each panel tab really fetches on open.
    test.each([
      ["audit", "getAuditTrail"],
      ["sessions", "listActiveSessions"],
      ["scheduled", "listScheduledTasks"],
      ["hunts", "listHunts"],
      ["shift", "getShiftSummary"],
      ["autonomy", "listShadowDecisions"],
    ])("opening %s fetches %s", (tab, op) => {
      // The Autonomy tab also asks for the rule readiness and tuning views.
      const extra = tab === "autonomy" ? ["listCases", "listCases"] : [];
      expect(openThenPoll(tab).onOpen.slice().sort()).toEqual([op].concat(extra).sort());
    });
  });

  // ── A failed action is shown where it happened ───────────────────────────
  // The page banner is one global message. A failed Run now used to write it
  // and nothing but the next overview load cleared it.

  describe("a failure stays where it happened", () => {
    test("a failed Run now shows in its row, not in the page banner", () => {
      const service = cannedService();
      service.listScheduledTasks = () => ({ then: (r) => r({ tasks: [
        { name: "Daily alert review", cron: "0 9 * * 1", intent: "triage" }] }) });
      service.runScheduledTaskNow = () => ({ then: (r) => r({ ok: false, error: {
        message: "Connector did not accept the trigger." } }) });
      const { $scope } = makeController(service);
      $scope.$apply();
      $scope.runScheduledNow("Daily alert review");
      expect($scope.runStateFor("Daily alert review"))
        .toEqual({ state: "error", message: "Connector did not accept the trigger." });
      expect($scope.error).toBe("");
    });

    test("switching tabs clears a stale page message", () => {
      const { $scope } = makeController(cannedService());
      $scope.$apply();
      $scope.error = "Gateway dropped.";
      $scope.setTab("users");
      expect($scope.error).toBe("");
    });

    test("a user action clears the page message when it starts", () => {
      const { $scope } = makeController(escalationService());
      $scope.$apply();
      $scope.error = "Gateway dropped.";
      $scope.decidePending($scope.escApprovals["auto:alerts:u1"][0], "approve");
      expect($scope.error).toBe("");
    });
  });
});
