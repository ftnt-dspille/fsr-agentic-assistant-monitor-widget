"use strict";
// Unit tests for the Monitor's policy readiness (M4) and tuning (M5) in the
// view controller. The connector decides ready / safe_to_tune; the controller
// only displays it, so these assert the wording and the wire calls.
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

const TH = { min_sample: 20, min_agreement: 0.95, max_reopen_rate: 0.05 };
const RULES = [
  { rule_id: "a", label: "Close benign alerts", ready: true, sample: 24, agreement: 0.96, reopen_rate: 0, blockers: [] },
  { rule_id: "b", label: "", ready: false, sample: 1, agreement: null, reopen_rate: null, blockers: ["Not enough decisions."] },
];
const LIST_ROWS = [
  { record_iri: "/api/3/alerts/1", session_id: "s1", rule_id: "a", action_card_id: "c1", undoable: true, record_name: "One" },
  { record_iri: "/api/3/alerts/2", session_id: "s2", rule_id: "b", action_card_id: "c2", undoable: false, record_name: "Two" },
  { record_iri: "/api/3/alerts/3", session_id: "s3", rule_id: "a", action_card_id: "c3", undoable: false, record_name: "Three" },
];

function setup(opts) {
  opts = opts || {};
  const calls = { cases: [], undo: [] };
  let $scope, $q;
  const svc = {
    listUsage: () => $q.resolve({ usage: [] }),
    getUsageSummary: () => $q.resolve({ summary: [] }),
    listPending: () => $q.resolve({ pending: [] }),
    getAuditTrail: () => $q.resolve({ usage: [] }),
    listScheduledTasks: () => $q.resolve({ tasks: [] }),
    listActiveSessions: () => $q.resolve({ sessions: [] }),
    listShadowDecisions: () => $q.resolve({ rules: [], decisions: [], policy: null }),
    listCases: (p) => {
      calls.cases.push(p);
      if (p.view === "policy") return opts.policy ? opts.policy($q) : $q.resolve({ ok: true, mode: "shadow", thresholds: TH, rules: RULES });
      if (p.view === "tuning") return opts.tuning ? opts.tuning($q) : $q.resolve({ ok: true, thresholds: { min_closes: 5, max_reopen_rate: 0.1 }, rules: [] });
      if (p.view === "list") return $q.resolve({ ok: true, rows: LIST_ROWS.map((r) => Object.assign({}, r)), total: 3 });
      return $q.resolve({ ok: true, kpis: null, rows: [], total: 0 });
    },
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
  return { $scope, calls };
}

describe("policy readiness", () => {
  test("opening the tab asks for the policy and tuning views, and keeps the connector's answer", () => {
    const { $scope, calls } = setup();
    $scope.setTab("autonomy");
    $scope.$digest();
    expect(calls.cases.filter((c) => c.view === "policy" || c.view === "tuning")).toEqual([{ view: "policy" }, { view: "tuning" }]);
    expect($scope.policyView.state).toBe("ready");
    expect($scope.policyView.rules.map((r) => r.ready)).toEqual([true, false]);
  });

  test("the numbers, the name and the mode read in plain words", () => {
    const { $scope } = setup();
    $scope.setTab("autonomy"); $scope.$digest();
    expect($scope.ruleNumbers(RULES[0])).toBe("24 decisions, 96% agreement, 0% reopened");
    expect($scope.ruleNumbers(RULES[1])).toBe("1 decision, agreement not known yet, reopens not known yet");
    expect($scope.ruleName(RULES[0])).toBe("Close benign alerts");
    expect($scope.ruleName(RULES[1])).toBe("b");
    expect($scope.policyModeText()).toBe("Recording only: nothing acts on its own yet");
    $scope.policyView.mode = "enforce";
    expect($scope.policyModeText()).toBe("Enforcing: rules act on their own in unattended triage");
    expect($scope.readyBar()).toBe("A rule is ready to enforce at 20 decisions or more, 95% agreement or better, and 5% or fewer reopened.");
  });

  test("a failed or malformed answer leaves the earlier tables in charge", () => {
    const { $scope } = setup({ policy: ($q) => $q.reject({ message: "x" }), tuning: ($q) => $q.resolve({ ok: false }) });
    $scope.setTab("autonomy"); $scope.$digest();
    expect($scope.policyView.state).toBe("unavailable");
    expect($scope.tuningView.state).toBe("unavailable");
  });

  test("the drawer keeps only the opened rule's decisions and Undo sends the card", () => {
    const { $scope, calls } = setup();
    $scope.setTab("autonomy"); $scope.$digest();
    $scope.openRuleDrawer(RULES[0]); $scope.$digest();
    expect(calls.cases.filter((c) => c.view === "list").pop()).toEqual({ view: "list", bucket: "all", hours: 336, limit: 200 });
    expect($scope.ruleDrawer.rows.map((r) => r.record_name)).toEqual(["One", "Three"]);
    expect($scope.isRuleOpen(RULES[0])).toBe(true);
    $scope.openRuleDrawer(RULES[1]); $scope.$digest();
    expect($scope.ruleDrawer.rows.map((r) => r.record_name)).toEqual(["Two"]);
    $scope.openRuleDrawer(RULES[0]); $scope.$digest();
    $scope.drawerUndo($scope.ruleDrawer.rows[0]); $scope.$digest();
    expect(calls.undo).toEqual([{ session_id: "s1", card_id: "c1" }]);
    $scope.closeRuleDrawer();
    expect($scope.ruleDrawer.open).toBe(false);
  });

  test("tuning rate reads as a percentage, or a dash when unknown", () => {
    const { $scope } = setup();
    expect($scope.tuningRate({ reopen_rate: 0.333 })).toBe("33%");
    expect($scope.tuningRate({ reopen_rate: null })).toBe("-");
  });
});
