"use strict";
// Unit tests for the Monitor's scheduled hunts (X6) and shift summary (X6) in
// the view controller: what reaches the wire, and what the panel shows.
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

const HUNT = (over) => Object.assign({
  name: "c2-sweep", question: "any host talking to known C2 in the last hour", cron: "0 * * * *",
  timezone: "UTC", schedule_label: "Every hour", module: "alerts", enabled: true,
  case_iri: "/api/3/alerts/abc", last_run_at: 1785240000, last_outcome: "finding",
  last_outcome_label: "Found something", last_summary: "h1 beaconed to a known C2", runs: [],
}, over || {});

const DIGEST = {
  ok: true, hours: 8, subject: "Shift summary: a to b",
  text: "Shift summary: a to b\n\nWhat the assistant handled\n- Triaged 6 cases.\n",
  handled: { triaged: 6, closed: 2, handled: 3, sent_to_you: 1, grouped: 2, deferred: 1 },
  waiting: { total: 1, cases: [{ record_name: "Phish report", record_iri: "/api/3/alerts/p1", priority: "P2", reasons: ["Needs review."] }] },
  notable: { total: 1, cases: [{ record_name: "Outbound C2", record_iri: "/api/3/alerts/c1", verdict: "True positive", confidence: 0.92 }] },
  would_help: { uncertain: 1, with_help: 1, items: [{ label: "FortiSIEM", problem: "FortiSIEM returned an error", cases: 1 }] },
  hunts: { runs: 2, findings: 1, quiet: 1, inconclusive: 0, failed: 0,
           cases: [{ hunt: "c2-sweep", summary: "h1 beaconed", case_iri: "/api/3/alerts/abc" }] },
};

function setup(opts) {
  opts = opts || {};
  const calls = { list: 0, save: [], del: [], run: [], shift: [], audit: [] };
  let $scope, $q, $timeout;
  const svc = {
    listUsage: () => $q.resolve({ usage: [] }),
    getUsageSummary: () => $q.resolve({ summary: [] }),
    listPending: () => $q.resolve({ pending: [] }),
    getAuditTrail: () => $q.resolve({ usage: [] }),
    listScheduledTasks: () => $q.resolve({ tasks: [] }),
    listActiveSessions: () => $q.resolve({ sessions: [] }),
    listCases: (p) => $q.resolve(p.view === "list"
      ? { ok: true, view: "list", total: 0, counts: { handled: 0, needs_you: 0, reopened: 0 }, rows: [] }
      : { ok: true, view: p.view, kpis: {}, uncertain: 0, with_help: 0, items: [] }),
    listHunts: () => { calls.list += 1; return opts.listHunts ? opts.listHunts($q) : $q.resolve({ ok: true, hunts: [HUNT()] }); },
    saveHunt: (p) => { calls.save.push(p); return opts.saveHunt ? opts.saveHunt(p, $q) : $q.resolve({ ok: true }); },
    deleteHunt: (n) => { calls.del.push(n); return $q.resolve({ ok: true, deleted: true }); },
    runHuntNow: (n) => { calls.run.push(n); return opts.runHuntNow ? opts.runHuntNow(n, $q) : $q.resolve({ ok: true, triggered: true }); },
    exportAudit: (p) => { calls.audit.push(p); return opts.exportAudit ? opts.exportAudit(p, $q) : $q.resolve({ ok: true, file_stem: "agent-audit-x", redaction: "off", csv: "at,kind\n", json: "{}" }); },
    getShiftSummary: (p) => { calls.shift.push(p); return opts.shift ? opts.shift(p, $q) : $q.resolve(DIGEST); },
  };
  ngModule("cybersponse", ($provide) => {
    $provide.value("config", { range: "7d", refreshSecs: 600 });
    $provide.value("fsrMonitorAgentService", svc);
  });
  ngInject((_$rootScope_, _$controller_, _$q_, _$timeout_) => {
    $scope = _$rootScope_.$new();
    $q = _$q_;
    $timeout = _$timeout_;
    const $interval = function () { return 0; };
    $interval.cancel = function () {};
    _$controller_("agenticAssistantMonitor116DevCtrl", { $scope, config: { range: "7d", refreshSecs: 600 }, $interval, $q, $timeout, fsrMonitorAgentService: svc });
  });
  $scope.$digest();
  return { $scope, $q, $timeout, calls };
}

describe("scheduled hunts", () => {
  test("opening the tab loads the hunts and keeps their schedule and outcome words", () => {
    const { $scope, calls } = setup();
    expect(calls.list).toBe(0);
    $scope.setTab("hunts");
    $scope.$digest();
    expect(calls.list).toBe(1);
    expect($scope.hunts.map((h) => [h.name, h.schedule_label, h.last_outcome_label])).toEqual([
      ["c2-sweep", "Every hour", "Found something"]]);
    expect($scope.isPanelEmpty("hunts", $scope.hunts)).toBe(false);
    expect($scope.huntCaseHref($scope.hunts[0])).toBe("#/main/modules/alerts/abc");
    expect($scope.huntCaseHref(HUNT({ case_iri: null }))).toBe(null);
    expect($scope.huntLastRun(HUNT({ last_run_at: null }))).toBe("Not run yet");
  });

  test("a failed load says so and an empty list is only empty after a good load", () => {
    const { $scope } = setup({ listHunts: ($q) => $q.reject({ message: "boom" }) });
    $scope.setTab("hunts");
    $scope.$digest();
    expect($scope.panelFailed.hunts).toBe("boom");
    expect($scope.isPanelEmpty("hunts", $scope.hunts)).toBe(false);
  });

  test("an empty list is empty after a good load", () => {
    const { $scope } = setup({ listHunts: ($q) => $q.resolve({ ok: true, hunts: [] }) });
    $scope.setTab("hunts");
    $scope.$digest();
    expect($scope.isPanelEmpty("hunts", $scope.hunts)).toBe(true);
  });

  test("a new hunt sends the preset's schedule and the chosen case type, then reloads", () => {
    const { $scope, calls } = setup();
    $scope.setTab("hunts");
    $scope.$digest();
    $scope.newHunt();
    expect($scope.huntFormValid()).toBe(false);
    $scope.huntForm.name = " c2-sweep ";
    $scope.huntForm.question = "  any host talking to known C2  ";
    $scope.huntForm.schedule = "weekdays";
    $scope.huntForm.module = "incidents";
    expect($scope.huntFormValid()).toBe(true);
    $scope.saveHunt();
    $scope.$digest();
    expect(calls.save).toEqual([{ name: "c2-sweep", question: "any host talking to known C2",
                                  cron: "0 8 * * 1-5", module: "incidents" }]);
    expect($scope.huntForm).toBe(null);
    expect(calls.list).toBe(2);
  });

  test("a custom schedule sends what was typed and an empty one cannot be saved", () => {
    const { $scope, calls } = setup();
    $scope.newHunt();
    Object.assign($scope.huntForm, { name: "n", question: "q", schedule: "custom", cron: "" });
    expect($scope.huntFormValid()).toBe(false);
    $scope.saveHunt();
    expect(calls.save).toEqual([]);
    $scope.huntForm.cron = " */30 * * * * ";
    $scope.saveHunt();
    expect(calls.save[0].cron).toBe("*/30 * * * *");
  });

  test("editing picks the matching preset, else the custom expression, and keeps the name fixed", () => {
    const { $scope } = setup();
    $scope.editHunt(HUNT({ cron: "0 */4 * * *" }));
    expect($scope.huntForm).toMatchObject({ editing: true, name: "c2-sweep", schedule: "four", cron: "" });
    $scope.editHunt(HUNT({ cron: "15 3 1 * *", module: "incidents" }));
    expect($scope.huntForm).toMatchObject({ schedule: "custom", cron: "15 3 1 * *", module: "incidents" });
    expect($scope.huntFormCron()).toBe("15 3 1 * *");
  });

  test("a refused save keeps the form open and says why", () => {
    const { $scope } = setup({ saveHunt: (p, $q) => $q.resolve({ ok: false, error: { message: "a hunt cannot run every 5 minutes; use at least 15" } }) });
    $scope.newHunt();
    Object.assign($scope.huntForm, { name: "n", question: "q" });
    $scope.saveHunt();
    $scope.$digest();
    expect($scope.huntForm.error).toBe("The hunt was not saved. a hunt cannot run every 5 minutes; use at least 15");
    expect($scope.huntForm.saving).toBe(false);
  });

  test("pause and resume send only the name and the flipped flag", () => {
    const { $scope, calls } = setup();
    $scope.toggleHunt(HUNT({ enabled: true }));
    $scope.toggleHunt(HUNT({ enabled: false }));
    expect(calls.save).toEqual([{ name: "c2-sweep", enabled: false }, { name: "c2-sweep", enabled: true }]);
  });

  test("delete asks first and only the confirmation deletes", () => {
    const { $scope, calls } = setup();
    $scope.askDeleteHunt(HUNT());
    expect($scope.huntDeleting).toBe("c2-sweep");
    expect(calls.del).toEqual([]);
    $scope.cancelDeleteHunt();
    expect($scope.huntDeleting).toBe(null);
    $scope.askDeleteHunt(HUNT());
    $scope.deleteHunt(HUNT());
    $scope.$digest();
    expect(calls.del).toEqual(["c2-sweep"]);
    expect($scope.huntDeleting).toBe(null);
  });

  test("run now asks the scheduler for that hunt and reports a refusal", () => {
    const { $scope, calls } = setup();
    $scope.runHuntNow(HUNT());
    $scope.$digest();
    expect(calls.run).toEqual(["c2-sweep"]);
    expect($scope.runStateFor("hunt:c2-sweep").state).toBe("ok");
  });

  test("a refused run now is reported", () => {
    const { $scope } = setup({ runHuntNow: (n, $q) => $q.resolve({ ok: false, error: { message: "no such hunt" } }) });
    $scope.runHuntNow(HUNT());
    $scope.$digest();
    expect($scope.runStateFor("hunt:c2-sweep")).toEqual({ state: "error", message: "no such hunt" });
  });
});

describe("shift summary", () => {
  test("opening the tab asks for the last eight hours and holds the digest", () => {
    const { $scope, calls } = setup();
    expect(calls.shift).toEqual([]);
    $scope.setTab("shift");
    $scope.$digest();
    expect(calls.shift).toEqual([{ hours: 8 }]);
    expect($scope.shift.state).toBe("ready");
    expect($scope.shift.digest.handled.triaged).toBe(6);
    expect($scope.shiftText()).toBe(DIGEST.text);
    expect($scope.shiftConfText(DIGEST.notable.cases[0])).toBe("92%");
    expect($scope.shiftHref("/api/3/alerts/p1")).toBe("#/main/modules/alerts/p1");
  });

  test("the window picker reloads with that many hours", () => {
    const { $scope, calls } = setup();
    $scope.setTab("shift");
    $scope.$digest();
    $scope.shift.hours = 168;
    $scope.shiftWindowChanged();
    $scope.$digest();
    expect(calls.shift.map((c) => c.hours)).toEqual([8, 168]);
  });

  test("a failed load is a failure, not an empty digest", () => {
    const { $scope } = setup({ shift: (p, $q) => $q.resolve({ ok: false, error: { code: "bad_window" } }) });
    $scope.setTab("shift");
    $scope.$digest();
    expect($scope.shift.state).toBe("failed");
    expect($scope.shift.digest).toBe(null);
    expect($scope.panelFailed.shift).toBe("The shift summary could not be loaded.");
    expect($scope.shiftText()).toBe("");
  });

  test("copy hands the clipboard the digest text unchanged", () => {
    const { $scope } = setup();
    $scope.setTab("shift");
    $scope.$digest();
    const written = [];
    Object.defineProperty(global.navigator, "clipboard", { configurable: true,
      value: { writeText: (t) => { written.push(t); return Promise.resolve(); } } });
    $scope.copyShift();
    return Promise.resolve().then(() => Promise.resolve()).then(() => {
      $scope.$root.$digest();   // flushes the $applyAsync the copy queued
      expect(written).toEqual([DIGEST.text]);
      expect($scope.shift.notice).toBe("Copied to the clipboard.");
    });
  });

  test("export downloads the digest text as a text file", () => {
    const { $scope } = setup();
    $scope.setTab("shift");
    $scope.$digest();
    const blobs = [];
    global.URL.createObjectURL = (b) => { blobs.push(b); return "blob:x"; };
    global.URL.revokeObjectURL = () => {};
    const clicked = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { clicked.push(this.download); };
    try { $scope.exportShift(); } finally { HTMLAnchorElement.prototype.click = orig; }
    expect(clicked).toEqual(["shift-summary.txt"]);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].size).toBe(Buffer.byteLength(DIGEST.text));
    expect($scope.shift.notice).toBe("Downloaded shift-summary.txt.");
  });
});

describe("audit export", () => {
  function download(run) {
    const blobs = [], names = [];
    global.URL.createObjectURL = (b) => { blobs.push(b); return "blob:x"; };
    global.URL.revokeObjectURL = () => {};
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
    try { run(); } finally { HTMLAnchorElement.prototype.click = orig; }
    return { blobs, names };
  }

  test("asks for the chosen window and format and saves the text it gets back", () => {
    const { $scope, calls } = setup();
    $scope.auditExport.hours = 168;
    $scope.auditExport.format = "json";
    const { blobs, names } = download(() => { $scope.exportAudit(); $scope.$digest(); });
    expect(calls.audit).toEqual([{ hours: 168, format: "json" }]);
    expect(names).toEqual(["agent-audit-x.json"]);
    expect(blobs[0].size).toBe(2);
    expect($scope.auditExport.notice).toBe("Downloaded agent-audit-x.json.");
    expect($scope.auditExport.busy).toBe(false);
  });

  test("a masked export says so", () => {
    const s = setup({ exportAudit: (p, $q) => $q.resolve({ ok: true, csv: "a", redaction: "strict" }) });
    const r = download(() => { s.$scope.exportAudit(); s.$scope.$digest(); });
    expect(r.names).toEqual(["agent-audit.csv"]);
    expect(s.$scope.auditExport.notice).toBe("Downloaded agent-audit.csv (sensitive values masked).");
  });

  test("a refused export saves nothing and says so", () => {
    const s = setup({ exportAudit: (p, $q) => $q.resolve({ ok: false, error: { code: "bad_window" } }) });
    const r = download(() => { s.$scope.exportAudit(); s.$scope.$digest(); });
    expect(r.names).toEqual([]);
    expect(s.$scope.auditExport.failed).toBe(true);
    expect(s.$scope.auditExport.notice).toBe("The audit could not be exported.");
  });

  test("a failed call saves nothing and frees the button", () => {
    const s = setup({ exportAudit: (p, $q) => $q.reject({ message: "boom" }) });
    const r = download(() => { s.$scope.exportAudit(); s.$scope.$digest(); });
    expect(r.names).toEqual([]);
    expect(s.$scope.auditExport.busy).toBe(false);
    expect(s.$scope.auditExport.failed).toBe(true);
  });
});
