"use strict";
// Unit tests for the Monitor's handled-cases queue (M1), outcome tiles (M2)
// and right/wrong feedback (M3) in the view controller.
//
//   make test-unit WIDGET=agenticAssistantMonitor

global.jasmine = global.jasmine || {};

require("angular");
require("angular-mocks");

angular.module("cybersponse", []); // eslint-disable-line no-undef
require("../widget/widgetAssets/js/fsrMonitorAgent.service.js");
require("../widget/view.controller.js");

const ngModule = window.angular.mock.module; // eslint-disable-line no-undef
const ngInject = window.angular.mock.inject; // eslint-disable-line no-undef

const ROW = (over) => Object.assign({
  record_iri: "/api/3/alerts/aaaa", record_module: "alerts", record_name: "Beacon", session_id: "auto:alerts:aaaa",
  bucket: "handled", verdict: "True positive", confidence: 0.92, sources: ["FortiSIEM", "FortiEDR"],
  action: "Blocked the address", action_kind: "taken", action_card_id: "card-1", undoable: true, reasons: ["Known bad."],
  at: 1785240000, group_size: 1, rule_id: "r1", feedback: { mine: null, note: "", right: 1, wrong: 0 },
}, over || {});

function setup(opts) {
  opts = opts || {};
  const calls = { cases: [], feedback: [], undo: [] };
  let $scope, $q;
  const svc = {
    listUsage: () => $q.resolve({ usage: [] }),
    getUsageSummary: () => $q.resolve({ summary: [] }),
    listPending: () => $q.resolve({ pending: [] }),
    getAuditTrail: () => $q.resolve({ usage: [] }),
    listScheduledTasks: () => $q.resolve({ tasks: [] }),
    listActiveSessions: () => $q.resolve({ sessions: [] }),
    listCases: (p) => {
      calls.cases.push(p);
      if (opts.listCases) return opts.listCases(p, $q);
      return $q.resolve(p.view === "kpis"
        ? { ok: true, view: "kpis", hours: p.hours, kpis: { handled: 24, auto_closed: 20, escalated: 3, needs_you: 3,
            reopened: 1, rated: 27, right: 25, wrong: 2, agreement: 25 / 27, deferred: 0, cost_today_usd: 0.84 } }
        : { ok: true, view: "list", hours: p.hours, bucket: p.bucket, total: 1,
            counts: { handled: 24, needs_you: 3, reopened: 1 }, rows: [ROW()] });
    },
    submitFeedback: (p) => { calls.feedback.push(p); return opts.feedback(p, $q); },
    undoAction: (p) => { calls.undo.push(p); return $q.resolve({ ok: true }); },
  };
  ngModule("cybersponse", ($provide) => {
    $provide.value("config", { range: "7d", refreshSecs: 600 });
    $provide.value("fsrMonitorAgentService", svc);
  });
  ngInject((_$rootScope_, _$controller_, _$q_) => {
    $scope = _$rootScope_.$new();
    $q = _$q_;
    const $interval = function () { return 0; };
    $interval.cancel = function () {};
    _$controller_("agenticAssistantMonitor118DevCtrl", { $scope, config: { range: "7d", refreshSecs: 600 }, $interval, $q, fsrMonitorAgentService: svc });
  });
  $scope.$digest();
  return { $scope, $q, calls };
}

describe("handled-cases queue", () => {
  test("the queue is the default tab and loads the handled bucket and the tiles for 24 hours", () => {
    const { $scope, calls } = setup();
    expect($scope.activeTab).toBe("queue");
    expect(calls.cases).toEqual([
      { view: "kpis", hours: 24 },
      { view: "list", bucket: "handled", hours: 24, limit: 50 },
      { view: "would_help", hours: 24 },
    ]);
    expect($scope.queue.rows.map((r) => r.record_name)).toEqual(["Beacon"]);
    expect($scope.queue.counts).toEqual({ handled: 24, needs_you: 3, reopened: 1 });
    expect($scope.kpis.handled).toBe(24);
  });

  test("a bucket tab and the time window each reach the wire", () => {
    const { $scope, calls } = setup();
    calls.cases.length = 0;
    $scope.setQueueBucket("needs_you");
    $scope.$digest();
    expect(calls.cases).toEqual([{ view: "list", bucket: "needs_you", hours: 24, limit: 50 }]);
    calls.cases.length = 0;
    $scope.queue.hours = 168;
    $scope.queueWindowChanged();
    $scope.$digest();
    expect(calls.cases).toEqual([
      { view: "list", bucket: "needs_you", hours: 168, limit: 50 },
      { view: "kpis", hours: 168 },
      { view: "would_help", hours: 168 },
    ]);
  });

  test("an answer that arrives after a newer request is ignored", () => {
    const pending = [];
    const { $scope, $q } = setup({ listCases: (p, q) => {
      if (p.view !== "list") return q.resolve({ ok: true, kpis: {} });
      const d = q.defer(); pending.push({ p, d }); return d.promise;
    } });
    $scope.setQueueBucket("needs_you");
    $scope.$digest();
    // initial (handled) request, then needs_you; answer needs_you first, handled last
    pending[1].d.resolve({ ok: true, total: 1, counts: {}, rows: [ROW({ record_name: "Needs you row", bucket: "needs_you" })] });
    pending[0].d.resolve({ ok: true, total: 1, counts: {}, rows: [ROW({ record_name: "Stale handled row" })] });
    $scope.$digest();
    expect($scope.queue.rows.map((r) => r.record_name)).toEqual(["Needs you row"]);
    expect($q).toBeTruthy();
  });

  test("a failed or malformed load is a failure, not an empty queue", () => {
    const { $scope } = setup({ listCases: (p, q) => q.resolve(p.view === "kpis" ? { ok: true, kpis: {} } : { ok: false, error: { code: "bad_view" } }) });
    expect($scope.panelFailed.queue).toBe("The handled cases could not be loaded.");
    expect($scope.isPanelEmpty("queue", $scope.queue.rows)).toBe(false);
  });

  test("row text is in the analyst's words", () => {
    const { $scope } = setup();
    expect($scope.confText(ROW())).toBe("92%");
    expect($scope.confText(ROW({ confidence: null }))).toBe("-");
    expect($scope.sourcesText(ROW())).toBe("FortiSIEM, FortiEDR");
    expect($scope.sourcesText(ROW({ sources: [] }))).toBe("-");
    expect(["taken", "would_have", "escalated", "none"].map((k) => $scope.actionKindLabel({ action_kind: k })))
      .toEqual(["Done", "Not run (shadow mode)", "Waiting for you", "No action"]);
    expect($scope.recordHref(ROW())).toBe("#/main/modules/alerts/aaaa");
    expect($scope.recordHref({ record_iri: "nonsense" })).toBeNull();
  });

  test("the agreement tile reads '93% (27 rated)', or says there are no ratings", () => {
    const { $scope } = setup();
    expect($scope.agreementText()).toBe("93% (27 rated)");
    expect($scope.kpiValue("auto_closed")).toBe(20);
    expect($scope.costTodayText()).toBe("$0.84");
    $scope.kpis = { agreement: null, rated: 0, cost_today_usd: null };
    expect($scope.agreementText()).toBe("No ratings yet");
    expect($scope.costTodayText()).toBe("not available");
    $scope.kpis = null;
    expect($scope.kpiValue("handled")).toBe("-");
  });
});

describe("right / wrong feedback", () => {
  const ok = (fb) => (p, q) => q.resolve({ ok: true, record: p.record, session_id: "s", feedback: fb(p) });

  test("answers at once, sends the record and rating, and keeps the read-back", () => {
    const { $scope, calls } = setup({ feedback: ok((p) => ({ mine: p.rating, note: "", right: 4, wrong: 0 })) });
    const r = $scope.queue.rows[0];
    $scope.rate(r, "right");
    // optimistic, before the answer lands
    expect(r.feedback.mine).toBe("right");
    expect(r.feedback.right).toBe(2);
    $scope.$digest();
    expect(calls.feedback).toEqual([{ record: "/api/3/alerts/aaaa", rating: "right" }]);
    expect($scope.queue.rows[0].feedback).toEqual({ mine: "right", note: "", right: 4, wrong: 0 });
  });

  test("the same button again clears the rating", () => {
    const { $scope, calls } = setup({ feedback: ok((p) => ({ mine: p.rating || null, note: "", right: 1, wrong: 0 })) });
    $scope.rate($scope.queue.rows[0], "wrong");
    $scope.$digest();
    $scope.rate($scope.queue.rows[0], "wrong");
    $scope.$digest();
    expect(calls.feedback.map((c) => c.rating)).toEqual(["wrong", ""]);
    expect($scope.queue.rows[0].feedback.mine).toBeNull();
  });

  test("a refused write puts the old state back with a plain message", () => {
    const { $scope } = setup({ feedback: (p, q) => q.resolve({ ok: false, error: { code: "no_analyst" } }) });
    $scope.rate($scope.queue.rows[0], "wrong");
    $scope.$digest();
    const r = $scope.queue.rows[0];
    expect(r.feedback).toEqual({ mine: null, note: "", right: 1, wrong: 0 });
    expect(r.feedbackError).toBe("Your account is not set up to rate decisions, so nothing was saved.");
    expect(r.feedbackSaving).toBe(false);
  });

  test("a connection failure reverts with the generic message", () => {
    const { $scope } = setup({ feedback: (p, q) => q.reject({ status: 500 }) });
    $scope.rate($scope.queue.rows[0], "right");
    $scope.$digest();
    expect($scope.queue.rows[0].feedback.mine).toBeNull();
    expect($scope.queue.rows[0].feedbackError).toBe("Your rating could not be saved. Try again.");
  });

  test("a note is saved with the current rating, and only once the case is rated", () => {
    const { $scope, calls } = setup({ feedback: ok((p) => ({ mine: p.rating, note: p.note || "", right: 2, wrong: 0 })) });
    const r = $scope.queue.rows[0];
    r.noteDraft = "Looks right";
    $scope.saveFeedbackNote(r);
    $scope.$digest();
    expect(calls.feedback).toEqual([]); // not rated yet: nothing is sent
    $scope.rate(r, "right");
    $scope.$digest();
    const r2 = $scope.queue.rows[0];
    r2.noteDraft = "Looks right";
    $scope.saveFeedbackNote(r2);
    $scope.$digest();
    expect(calls.feedback[1]).toEqual({ record: "/api/3/alerts/aaaa", rating: "right", note: "Looks right" });
    expect($scope.queue.rows[0].feedback.note).toBe("Looks right");
  });

  test("a successful rating refreshes the agreement tile", () => {
    const { $scope, calls } = setup({ feedback: ok(() => ({ mine: "wrong", note: "", right: 1, wrong: 1 })) });
    calls.cases.length = 0;
    $scope.rate($scope.queue.rows[0], "wrong");
    $scope.$digest();
    expect(calls.cases).toEqual([{ view: "kpis", hours: 24 }]);
  });
});

describe("undo from the queue", () => {
  test("sends the session and the action card, then reloads the queue", () => {
    const { $scope, calls } = setup();
    const r = $scope.queue.rows[0];
    expect($scope.canQueueUndo(r)).toBe(true);
    calls.cases.length = 0;
    $scope.queueUndo(r);
    $scope.$digest();
    expect(calls.undo).toEqual([{ session_id: "auto:alerts:aaaa", card_id: "card-1" }]);
    expect($scope.canQueueUndo(r)).toBe(false);
    expect(calls.cases.map((c) => c.view).sort()).toEqual(["kpis", "list"]);
  });
  test("a row that is not undoable offers no undo", () => {
    const { $scope } = setup();
    expect($scope.canQueueUndo(ROW({ undoable: false }))).toBe(false);
  });
});

describe("would help most", () => {
  const HELP = { ok: true, view: "would_help", hours: 24, uncertain: 9, with_help: 8, items: [
    { kind: "tickets", state: "not_connected", label: "Ticket system", problem: "Ticket system is not connected", cases: 7 },
    { kind: "source_failed", state: "failed", label: "FortiSIEM", problem: "FortiSIEM returned an error", cases: 1 },
    { kind: "data_gap", state: "no_data", label: "FortiAnalyzer", problem: "FortiAnalyzer was searched and returned nothing", cases: 1 },
  ] };
  const withHelp = (res) => setup({ listCases: (p, q) => q.resolve(
    p.view === "would_help" ? res
      : p.view === "kpis" ? { ok: true, kpis: {} }
        : { ok: true, total: 0, counts: {}, rows: [] }) });

  test("shows the connector's ranking as it came, by value", () => {
    const { $scope } = withHelp(HELP);
    expect($scope.wouldHelp.state).toBe("ready");
    expect([$scope.wouldHelp.uncertain, $scope.wouldHelp.withHelp]).toEqual([9, 8]);
    expect($scope.wouldHelp.items.map((i) => [i.problem, $scope.helpCasesText(i)])).toEqual([
      ["Ticket system is not connected", "Would have helped 7 uncertain cases"],
      ["FortiSIEM returned an error", "Would have helped 1 uncertain case"],
      ["FortiAnalyzer was searched and returned nothing", "Would have helped 1 uncertain case"],
    ]);
  });

  test("a setup link only for a source that is missing or failing, never for an empty search", () => {
    const { $scope } = withHelp(HELP);
    expect($scope.wouldHelp.items.map((i) => $scope.helpNeedsSetup(i))).toEqual([true, true, false]);
  });

  test("the connectors link is a route, with no host in it", () => {
    const { $scope } = withHelp(HELP);
    expect($scope.connectorsHref()).toMatch(/^#\//);
    expect($scope.connectorsHref()).not.toMatch(/https?:|\/\/[a-z]/i);
  });

  test("no uncertain cases is an empty answer, not a failure", () => {
    const { $scope } = withHelp({ ok: true, uncertain: 0, with_help: 0, items: [] });
    expect($scope.wouldHelp).toEqual({ state: "ready", uncertain: 0, withHelp: 0, items: [] });
  });

  test("a connector that cannot answer reads as unavailable", () => {
    const { $scope } = withHelp({ ok: false, error: { code: "bad_view" } });
    expect($scope.wouldHelp.state).toBe("unavailable");
  });

  test("it follows the window: a new window asks again with those hours", () => {
    const { $scope, calls } = withHelp(HELP);
    calls.cases.length = 0;
    $scope.queue.hours = 720;
    $scope.queueWindowChanged();
    $scope.$digest();
    expect(calls.cases.filter((c) => c.view === "would_help")).toEqual([{ view: "would_help", hours: 720 }]);
  });
});
