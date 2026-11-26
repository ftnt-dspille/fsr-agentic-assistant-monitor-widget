/* Copyright start
   MIT License
   Copyright (c) 2026 Fortinet Inc
   Copyright end */
"use strict";
// VIEW controller. Resolved as `agenticAssistantMonitor118DevCtrl` for v1.0.0.
(function () {
  // Tab bodies live in widgetAssets/html/*.html and are ng-included by
  // view.html. The folder this controller was served from is the folder the
  // partials are served from (harness and SOAR alike); empty in a unit test.
  var WIDGET_BASE = (function () {
    var el = document.currentScript || (function () {
      var all = document.getElementsByTagName("script");
      return all[all.length - 1];
    })();
    var src = (el && el.src) || "";
    return src.replace(/view\.controller\.js(?:\?.*)?$/, "").replace(/^https?:\/\/[^/]+/, "");
  })();
  angular
    .module("cybersponse")
    .controller("agenticAssistantMonitor118DevCtrl", agenticAssistantMonitor118DevCtrl);

  agenticAssistantMonitor118DevCtrl.$inject = ["$scope", "config", "$interval", "$timeout", "$q", "$injector", "fsrMonitorAgentService"];

  function agenticAssistantMonitor118DevCtrl($scope, config, $interval, $timeout, $q, $injector, fsrMonitorAgentService) {
    $scope.tpl = function (name) { return WIDGET_BASE + "widgetAssets/html/" + name + ".html"; };

    var defaults = { title: "Agentic Assistant Monitor", range: "7d", refreshSecs: 60 };
    $scope.config = angular.extend({}, defaults, config || {});

    // initialLoading gates the first paint only. A background refresh sets
    // `refreshing` instead, so the page is never unmounted while it polls.
    $scope.initialLoading = true;
    $scope.refreshing = false;
    $scope.error = "";
    $scope.usage = [];
    $scope.summary = [];
    $scope.pending = [];
    // Escalations (autonomous tier-1) and the queue derived from them; see
    // _groupPending. Declared with the rest of the state, not beside the code.
    $scope.escalations = [];
    $scope.otherPending = [];
    $scope.escApprovals = {};
    $scope.queueCount = 0;
    $scope.escDecisions = {};
    $scope.audit = [];
    $scope.scheduledTasks = [];
    $scope.hunts = [];
    $scope.liveSessions = [];
    $scope.activeTab = "queue";

    // ── Interactive filters (§10.4) ────────────────────────────────────────
    // Shared filter state across all panels. Click a KPI card, status badge,
    // user row, or model name to toggle a filter; the audit trail + live
    // sessions reload with the active filters applied.
    //
    // Filter keys are PANEL-SCOPED, because the same word means different
    // things per panel: a live session's `status` is active/waiting_approval/
    // idle, while an audit row's `status` is success/error. Sending one into
    // the other's query silently returns zero rows (that's how "Pending HITL"
    // used to land you on an empty audit trail). `_PANEL_KEYS` declares which
    // keys each panel accepts; `_panelFilters()` projects the shared state
    // down to the wire shape that panel's connector op understands.
    var _PANEL_KEYS = {
      // session_status is the widget-side key; the op's param is `status`.
      sessions: { session_status: "status", user_iri: "user_iri" },
      audit: { status: "status", intent: "intent", user_iri: "user_iri",
               model: "model" }
    };
    $scope.activeFilters = {};
    // Human-readable value per filter key, for the chips. A user filter
    // carries an IRI on the wire but must read as "CS Admin" in the UI.
    $scope.filterLabels = {};
    $scope.toggleFilter = function (key, value, label) {
      if ($scope.activeFilters[key] === value) {
        delete $scope.activeFilters[key];
        delete $scope.filterLabels[key];
      } else {
        $scope.activeFilters[key] = value;
        if (label != null) $scope.filterLabels[key] = label;
      }
      $scope._applyFilters();
    };
    $scope.clearFilter = function (key) {
      delete $scope.activeFilters[key];
      delete $scope.filterLabels[key];
      $scope._applyFilters();
    };
    $scope.clearAllFilters = function () {
      $scope.activeFilters = {};
      $scope.filterLabels = {};
      $scope._applyFilters();
    };
    $scope.hasActiveFilters = function () { return Object.keys($scope.visibleFilters()).length > 0; };
    // Filters that actually apply to the panel on screen. The chip bar only
    // renders these, so a filter can never be shown as active on a tab that
    // ignores it (Overview/Users/Pending/Scheduled show no chips at all).
    //
    // Memoised on (tab, filter-state) because ng-repeat over a freshly built
    // object every digest trips $rootScope:infdig -- same reason `users()`
    // caches (see below).
    var _visCache = {};
    var _visKey = null;
    $scope.visibleFilters = function () {
      var allowed = _PANEL_KEYS[$scope.activeTab];
      var key = $scope.activeTab + "|" + JSON.stringify($scope.activeFilters);
      if (_visKey === key) return _visCache;
      var out = {};
      if (allowed) {
        Object.keys($scope.activeFilters).forEach(function (k) {
          if (allowed[k]) out[k] = $scope.activeFilters[k];
        });
      }
      _visKey = key;
      _visCache = out;
      return out;
    };
    // The chip's name for a filter key, in the analyst's words (never the wire key).
    var _FILTER_KEY_LABELS = { session_status: "Status", status: "Status", intent: "Intent",
                               user_iri: "User", model: "Model" };
    $scope.filterKeyLabel = function (key) { return _FILTER_KEY_LABELS[key] || "Filter"; };
    // Display label for a chip (falls back to the raw value).
    var _FILTER_VALUE_LABELS = { waiting_approval: "Waiting for approval", active: "Streaming", idle: "Idle" };
    $scope.filterLabel = function (key) {
      var l = $scope.filterLabels[key];
      if (l != null) return l;
      var v = $scope.activeFilters[key];
      return _FILTER_VALUE_LABELS[v] || v;
    };
    // Project the shared filter state onto one panel's wire params.
    $scope._panelFilters = function (panel) {
      var allowed = _PANEL_KEYS[panel] || {};
      var out = {};
      Object.keys($scope.activeFilters).forEach(function (k) {
        if (allowed[k]) out[allowed[k]] = $scope.activeFilters[k];
      });
      return out;
    };
    // Reload the audit trail + live sessions with the active filters.
    $scope._applyFilters = function () {
      if ($scope.activeTab === "audit") $scope.loadAudit();
      if ($scope.activeTab === "sessions") $scope.loadLiveSessions();
    };

    // Time-range → ISO 8601 `from` for the queries.
    function rangeDays(range) { return { "24h": 1, "7d": 7, "30d": 30 }[range] || 7; }
    function fromFor(range) {
      var d = new Date(Date.now() - rangeDays(range) * 86400000);
      return d.toISOString();
    }

    // ── Bucket zero-fill ──────────────────────────────────────────────────
    // The connector's get_usage_summary only returns buckets that HAVE rows,
    // so a 7d range with activity on two days comes back as two points. Left
    // as-is, the chart stretches those two points across the whole width and
    // draws a "trend" over five days that never existed. Every series is
    // therefore expanded to one bucket per interval across the requested
    // range, with 0 for the quiet ones.
    //
    // Keys are UTC and must match the producer's format exactly:
    //   day  -> "2026-07-28"           (storage.usage_summary strftime %Y-%m-%d)
    //   hour -> "2026-07-28T14:00:00"  (…%Y-%m-%dT%H:00:00)
    // The key builder takes the style explicitly ("short" hour form is
    // "2026-07-28T14").
    function _bucketKey(d, granularity, style) {
      var iso = d.toISOString();
      if (granularity !== "hour") return iso.slice(0, 10);
      return style === "short" ? iso.slice(0, 13) : iso.slice(0, 13) + ":00:00";
    }
    // Truncate a Date down to the start of its bucket (UTC).
    function _floorTo(d, granularity) {
      var c = new Date(d.getTime());
      c.setUTCMilliseconds(0); c.setUTCSeconds(0); c.setUTCMinutes(0);
      if (granularity !== "hour") c.setUTCHours(0);
      return c;
    }
    // Ordered [{bucket, value}] across [from, now], 0 where `map` has no entry.
    // Capped so a pathological range can't build an unbounded array.
    function _fillRange(map, granularity, fromDate, style) {
      var stepMs = granularity === "hour" ? 3600000 : 86400000;
      var cur = _floorTo(fromDate, granularity);
      var end = _floorTo(new Date(), granularity);
      var out = [];
      var guard = 0;
      while (cur.getTime() <= end.getTime() && guard++ < 1000) {
        var k = _bucketKey(cur, granularity, style);
        out.push({ bucket: k, value: map[k] || 0 });
        cur = new Date(cur.getTime() + stepMs);
      }
      return out;
    }

    // The panel loader for each tab that fetches on open. Opening a tab
    // (setTab) and the poll (refresh) both read this one map, so a tab that
    // loads on click is also reloaded on the timer. They used to be two
    // separate if-chains, and Autonomy was only in one of them.
    var PANEL_LOADERS = { queue: "loadQueue", audit: "loadAudit", scheduled: "loadScheduled", hunts: "loadHunts", shift: "loadShift", sessions: "loadLiveSessions", autonomy: "loadShadow" };
    function _loadPanelFor(tab) { if (PANEL_LOADERS[tab]) $scope[PANEL_LOADERS[tab]](); }
    // Switching tabs drops a stale page-level message; a panel's own failure
    // renders in that panel, so it does not need the banner.
    $scope.setTab = function (t) { $scope.error = ""; $scope.activeTab = t; _loadPanelFor(t); };

    // Totals for the overview cards (derived from the usage summary).
    $scope.totals = { turns: 0, tokens: 0, cost: 0, pending: 0 };
    function _computeTotals() {
      var t = { turns: 0, tokens: 0, cost: 0, pending: _queueSize() };
      // Sourced from the server-side summaries (uncapped), NOT $scope.usage,
      // which is capped at 500 rows and would silently undercount.
      function sum(rows) {
        return (rows || []).reduce(function (a, x) { return a + (x.value || 0); }, 0);
      }
      t.turns = sum($scope.summaryTurns);
      t.tokens = sum($scope.summaryTokens);
      t.cost = sum($scope.summaryCost);
      t.cost = Math.round(t.cost * 10000) / 10000;
      $scope.totals = t;
      _computeSparklines();
      _computeAreaChart();
    }

    // Chart granularity follows the range: a 24h window is hourly, anything
    // longer is daily. There is no "too few buckets, retry hourly" fallback
    // any more -- zero-fill guarantees a full series at either granularity.
    function _granularity() { return $scope.config.range === "24h" ? "hour" : "day"; }

    $scope.loadOverview = function () {
      // Only the first load shows the loading state. Later loads leave the page
      // mounted and set `refreshing`, which the header shows as "Updating".
      $scope.refreshing = !$scope.initialLoading;
      var from = fromFor($scope.config.range);
      var g = _granularity();
      $q.all([
        fsrMonitorAgentService.listUsage({ from: from, limit: 500 }),
        fsrMonitorAgentService.getUsageSummary({ bucket: g, metric: "cost", from: from }),
        fsrMonitorAgentService.listPending(),
        fsrMonitorAgentService.getUsageSummary({ bucket: g, metric: "turns", from: from }),
        fsrMonitorAgentService.getUsageSummary({ bucket: g, metric: "tokens", from: from })
      ]).then(function (results) {
        $scope.error = "";
        $scope.usage = (results[0] && results[0].usage) || [];
        $scope.summaryCost = (results[1] && results[1].summary) || [];
        $scope.summaryTurns = (results[3] && results[3].summary) || [];
        $scope.summaryTokens = (results[4] && results[4].summary) || [];
        $scope.pending = (results[2] && results[2].pending) || [];
        $scope.escalations = (results[2] && results[2].escalations) || [];
        _groupPending();
        _computeTotals();
        $scope.initialLoading = false;
        $scope.refreshing = false;
      }, function (err) {
        $scope.error = (err && err.message) || "Could not load monitor data.";
        $scope.initialLoading = false;
        $scope.refreshing = false;
      });
    };
    // Any fetch in flight, for the header's "Updating" marker.
    $scope.isBusy = function () {
      if ($scope.refreshing) return true;
      return Object.keys($scope.panelLoading).some(function (p) { return $scope.panelLoading[p]; });
    };

    // ── Per-panel load state ──────────────────────────────────────────────
    // Each panel's empty state was gated purely on `!rows.length`, which is
    // also true for the entire duration of the fetch. So switching to a tab
    // rendered a confident "No chat sessions available" / "No LLM calls
    // recorded yet" for as long as the connector round-trip took, and the real
    // rows then replaced it. That reads as "there is nothing here" when the
    // truth is "we haven't looked yet" -- the two states must not share a
    // rendering. `loaded` is what distinguishes them: an empty state is only
    // honest AFTER a completed fetch.
    $scope.panelLoading = { queue: false, audit: false, sessions: false, scheduled: false, hunts: false, shift: false, autonomy: false };
    $scope.panelLoaded = { queue: false, audit: false, sessions: false, scheduled: false, hunts: false, shift: false, autonomy: false };
    // The spinner is for the first fetch only. Once a panel has rows (or a
    // known-empty result), a reload keeps them on screen and the header shows
    // "Updating"; swapping them for a spinner would unmount the panel.
    $scope.isPanelLoading = function (p) { return !!$scope.panelLoading[p] && !$scope.panelLoaded[p]; };
    // True only when a fetch has completed and genuinely returned nothing.
    // A fetch that FAILED returned nothing too, but "No chat sessions" over a
    // dead call is the same lie as over an unfinished one: live on .159 a
    // dropped request showed an empty Sessions panel on a box with 50.
    // A reload of an already-empty panel stays empty until its result lands.
    $scope.panelFailed = {};
    $scope.isPanelEmpty = function (p, rows) {
      return $scope.panelLoaded[p] && !$scope.panelFailed[p] && !((rows || []).length);
    };
    // A failure is kept until the next success, so a retry in flight still
    // reads as "could not load", not as an empty panel.
    function _panelStart(p) { $scope.panelLoading[p] = true; }
    function _panelDone(p) {
      $scope.panelLoading[p] = false;
      $scope.panelLoaded[p] = true;
      $scope.panelFailed[p] = "";
    }
    function _panelFail(p, err, fallback) {
      var msg = (err && (err.message || (err.data && err.data.message))) || fallback;
      $scope.panelLoading[p] = false;
      $scope.panelLoaded[p] = true;
      $scope.panelFailed[p] = msg;
    }

    $scope.loadAudit = function () {
      var f = angular.extend({ limit: $scope.AUDIT_LIMIT, from: fromFor($scope.config.range) },
                             $scope._panelFilters("audit"));
      _panelStart("audit");
      fsrMonitorAgentService.getAuditTrail(f)
        .then(function (res) {
          // Rows are replaced on every load. Carry the expand state over to the
          // rows that are still there, so a reload does not fold open rows
          // shut. New rows start collapsed. The tool_call_detail array arrives
          // nested from the connector (Phase 1, §10.2).
          var open = {};
          ($scope.audit || []).forEach(function (a) { if (a._expanded) open[_auditKey(a)] = true; });
          var rows = (res && res.usage) || [];
          rows.forEach(function (a) { a._expanded = !!open[_auditKey(a)]; });
          $scope.audit = rows;
          _panelDone("audit");
        },
              function (err) { _panelFail("audit", err, "Audit load failed."); });
    };
    // Row identity across reloads. The connector pops the row id before it
    // answers, so the wire row has none today; use it when it is sent, else
    // the fields that make one LLM call unique.
    function _auditKey(a) {
      return a.id != null ? "id:" + a.id : [a.session_id, a.ts, a.turn, a.model].join("|");
    }

    // ── Audit free-text search ────────────────────────────────────────────
    // The badge filters (status/intent/model/user) only work if you already
    // know which value you want, and none of them reach the prompt text --
    // so "find the turn where someone asked about 102.220.160.21" had no
    // answer at all. This is a client-side substring match across every
    // field the row displays, applied over the rows already loaded for the
    // current range + badge filters. That window is `limit: 200`, so the
    // template reports "showing X of Y" and warns when the fetch was capped:
    // a search that silently missed older rows would be worse than none.
    // Bound through an object, not a bare primitive: the search input sits
    // inside ng-if, which creates a child scope, so `ng-model="auditQuery"`
    // would write the child's own shadowing copy and the filter below would
    // keep reading the parent's empty string.
    $scope.search = {audit: ""};
    $scope.clearAuditQuery = function () { $scope.search.audit = ""; };

    function _auditHaystack(a) {
      if (a._hay != null) return a._hay;
      var parts = [a.ts, a.user_name, a.user_iri, a.model, a.intent, a.status,
                   a.prompt, a.session_id, a.agent_thinking, a.response];
      (a.tool_call_detail || []).forEach(function (tc) {
        parts.push(tc.name, tc.status);
        try {
          parts.push(angular.isString(tc.params) ? tc.params : JSON.stringify(tc.params));
        } catch (e) {}
      });
      a._hay = parts.filter(function (p) { return p != null; })
        .join(" ").toLowerCase();
      return a._hay;
    }

    // Memoised on (rows, query) -- ng-repeat over a freshly built array every
    // digest trips $rootScope:infdig, the same trap `users()` documents.
    // Keyed on the rows array itself: every reload replaces it, and a key of
    // length + first timestamp would keep handing back the previous objects.
    var _audCache = [];
    var _audRows = null;
    var _audQuery = null;
    $scope.filteredAudit = function () {
      var rows = $scope.audit || [];
      var q = ($scope.search.audit || "").trim().toLowerCase();
      if (_audRows === rows && _audQuery === q) return _audCache;
      _audRows = rows;
      _audQuery = q;
      _audCache = q ? rows.filter(function (a) { return _auditHaystack(a).indexOf(q) !== -1; })
                    : rows;
      return _audCache;
    };
    // True when the underlying fetch hit its cap, so a search may be looking
    // at a truncated window rather than the whole range.
    $scope.AUDIT_LIMIT = 200;
    $scope.auditTruncated = function () {
      return ($scope.audit || []).length >= $scope.AUDIT_LIMIT;
    };

    // Toggle the expandable tool-call chain on an audit row (§10.1).
    $scope.toggleAuditRow = function (a) { a._expanded = !a._expanded; };

    // Count of tool calls in an audit row, for the inline badge.
    $scope.toolCallCount = function (a) {
      return (a && a.tool_call_detail && a.tool_call_detail.length) || 0;
    };

    // Format a tool call's params as pretty JSON for the expandable detail.
    $scope.toolCallParams = function (tc) {
      if (!tc || tc.params == null) return "--";
      try {
        return angular.isString(tc.params) ? tc.params
          : JSON.stringify(tc.params, null, 2);
      } catch (e) { return String(tc.params); }
    };

    // Tool-call status → badge class.
    $scope.toolCallStatusClass = function (status) {
      return { success: "on", error: "error" }[status] || "paused";
    };

    // Human-readable latency for a tool call.
    $scope.toolCallLatency = function (ms) {
      if (ms == null) return "--";
      return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
    };

    // Pretty-print a tool call's RESULT. `result_summary` arrives as a string
    // that is usually JSON -- the overlay used to render it into a
    // one-line-ellipsis cell with only a `title` tooltip, so the single most
    // interesting field in the whole turn (what the tool actually returned)
    // was the one thing you could not read. Parse-and-reindent when it's JSON
    // so it lands in the same readable block as the params; leave plain text
    // alone.
    $scope.toolCallResult = function (tc) {
      var r = tc && tc.result_summary;
      if (r == null || r === "") return "--";
      if (!angular.isString(r)) {
        try { return JSON.stringify(r, null, 2); } catch (e) { return String(r); }
      }
      var t = r.trim();
      if (t.charAt(0) === "{" || t.charAt(0) === "[") {
        try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) {}
      }
      return r;
    };

    // Long payloads render clipped with a "show more" affordance rather than
    // pushing the rest of the timeline off-screen. Threshold is in characters
    // because the block is monospace and pre-wrapped, so length tracks height
    // closely enough.
    var TOOL_BLOB_CLIP = 600;
    $scope.isLongBlob = function (s) {
      return !!s && s.length > TOOL_BLOB_CLIP;
    };
    $scope.toggleToolBlob = function (tc, which) {
      tc["_open_" + which] = !tc["_open_" + which];
    };
    $scope.toolBlobOpen = function (tc, which) { return !!tc["_open_" + which]; };

    // -- Central approval (slide 16) ---------------------------------------
    // A pending row names what the card asks (connector `list_pending` card
    // view); Approve / Reject answer it here with the same chat_resume the chat
    // drawer sends: card_id for an action card, approval_id (+ card_id, so it
    // still executes after the 10-minute suspend TTL) for a run approval. The
    // connector decides each card once and names who did, so a card the analyst
    // answered in the chat a moment earlier reports that instead of running twice.
    $scope.decisions = {};
    $scope.currentUser = _currentUser();

    function _currentUser() {
      try {
        var us = $injector.get("usersService");
        var u = us && us.getCurrentUser && us.getCurrentUser();
        if (!u) return null;
        var name = ((u.firstname || "") + " " + (u.lastname || "")).trim() || u.userid || u.email;
        if (!name) return null;
        var a = { name: name };
        if (u["@id"] || u.iri) a.iri = u["@id"] || u.iri;
        return a;
      } catch (e) { return null; }
    }

    $scope.decisionPayload = function (p, decision) {
      var payload = { session_id: p.session_id, decision: decision };
      var type = p.card && p.card.type;
      if (type === "approval_request") {
        payload.approval_id = p.approval_id;
        payload.card_id = p.card_id || p.approval_id;
      } else if (type === "action_card") {
        payload.card_id = p.card_id || p.approval_id;
      } else {
        payload.approval_id = p.approval_id;
      }
      if ($scope.currentUser) payload.actor = $scope.currentUser;
      return payload;
    };

    // What the reviewer reads: the card's own words, else its tool and target.
    $scope.pendingTitle = function (p) {
      var c = p.card;
      if (!c) return "Approval waiting in the chat";
      if (c.title) return c.title;
      if (c.summary) return c.summary;
      if (c.playbook) return "Run playbook " + c.playbook;
      return "Approval request";
    };

    // The target a pending item acts on. Always surface it on an approval row
    // so the reviewer sees exactly what the action hits; only suppress it when
    // the title already ends with the same " on <target>" suffix (which is the
    // one case that produced "Block X on FortiGate on FortiGate"). A mere
    // substring elsewhere in the title must not hide the structured target.
    $scope.pendingTarget = function (p) {
      var c = p && p.card;
      if (!c || !c.target || !c.target.name) return "";
      var t = $scope.pendingTitle(p) || "";
      return t.slice(-(" on ".length + c.target.name.length)) === " on " + c.target.name
        ? "" : c.target.name;
    };

    // Dollars read at a fixed width: two places once there is a cent to show,
    // four for sub-cent amounts, never a raw many-digit float.
    $scope.fmtCost = function (c) {
      c = Number(c) || 0;
      return c >= 0.01 ? c.toFixed(2) : c.toFixed(4);
    };

    $scope.decidePending = function (p, decision) {
      var key = p.session_id + "/" + (p.card_id || p.approval_id);
      if ($scope.decisions[key] && $scope.decisions[key].state === "sending") return;
      $scope.error = "";
      $scope.decisions[key] = { state: "sending", decision: decision };
      fsrMonitorAgentService.decidePending($scope.decisionPayload(p, decision)).then(function (res) {
        var err = res && res.ok === false && res.error;
        if (err) {
          $scope.decisions[key] = { state: err.code === "already_decided" ? "taken" : "failed",
                                    message: err.message || err.code };
          return;
        }
        $scope.decisions[key] = { state: "done", decision: decision };
        $scope.pending = $scope.pending.filter(function (x) { return x !== p; });
        _groupPending();
        _computeTotals();
      }, function (e) {
        $scope.decisions[key] = { state: "failed",
                                  message: (e && (e.message || (e.data && e.data.message))) || "The connector did not answer." };
      });
    };
    $scope.decisionFor = function (p) {
      return $scope.decisions[p.session_id + "/" + (p.card_id || p.approval_id)];
    };

    // -- Escalations (autonomous tier-1) -------------------------------------
    // Records auto-triage could not finish alone, most urgent first (the
    // connector sorts them). A reviewer works one here without opening the
    // chat: what the assistant concluded and why it stopped, the session's
    // waiting approvals with Approve / Reject, then Mark handled or Dismiss.
    // An approval that belongs to an escalation is listed under it, not again
    // in the plain approvals table.
    // The one queue both the KPI tile and the Pending tab badge show: plain
    // approvals plus escalations (an escalation is work for a reviewer too).
    function _queueSize() {
      return ($scope.pending || []).length + ($scope.escalations || []).length;
    }
    function _groupPending() {
      var bySession = {};
      ($scope.escalations || []).forEach(function (e) { bySession[e.session_id] = []; });
      var other = [];
      ($scope.pending || []).forEach(function (p) {
        if (bySession[p.session_id]) bySession[p.session_id].push(p);
        else other.push(p);
      });
      $scope.escApprovals = bySession;
      $scope.otherPending = other;
      $scope.queueCount = _queueSize();
    }

    var DISPOSITIONS = {
      true_positive: "True positive", false_positive: "False positive",
      benign: "Benign", suspicious: "Suspicious", needs_more_info: "Needs more information"
    };

    // "Suspicious, 86% confident" -- the verdict in a reviewer's words.
    $scope.verdictLine = function (e) {
      var v = e && e.verdict;
      if (!v || !v.disposition) return "No verdict";
      var line = DISPOSITIONS[v.disposition] || String(v.disposition).replace(/_/g, " ");
      if (typeof v.confidence === "number") line += ", " + Math.round(v.confidence * 100) + "% confident";
      return line;
    };

    $scope.ageText = function (seconds) {
      var s = Number(seconds) || 0;
      if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
      if (s < 86400) return (Math.round(s / 360) / 10) + "h";
      return Math.round(s / 86400) + "d";
    };

    $scope.resolveEscalation = function (e, outcome) {
      var key = e.session_id + "/" + e.card_id;
      var cur = $scope.escDecisions[key];
      if (cur && (cur.state === "sending" || cur.state === "taken")) return;
      $scope.error = "";
      $scope.escDecisions[key] = { state: "sending", outcome: outcome };
      var payload = { session_id: e.session_id, card_id: e.card_id, outcome: outcome };
      if ($scope.currentUser) payload.actor = $scope.currentUser;
      fsrMonitorAgentService.resolveEscalation(payload).then(function (res) {
        var err = res && res.ok === false && res.error;
        if (err) {
          $scope.escDecisions[key] = { state: err.code === "already_decided" ? "taken" : "failed",
                                       message: err.message || err.code };
          return;
        }
        $scope.escDecisions[key] = { state: "done", outcome: outcome };
        $scope.escalations = $scope.escalations.filter(function (x) { return x !== e; });
        _groupPending();
        _computeTotals();
      }, function (er) {
        $scope.escDecisions[key] = { state: "failed",
                                     message: (er && (er.message || (er.data && er.data.message))) || "The connector did not answer." };
      });
    };
    $scope.escDecisionFor = function (e) {
      return $scope.escDecisions[e.session_id + "/" + e.card_id];
    };
    $scope.openEscalationInChat = function (e) {
      var r = (e && e.record) || {};
      _openSessionInChat({ session_id: e.session_id, record_module: r.module, record_uuid: r.uuid });
    };

    // -- Turn Detail overlay (§10.3) --------------------------------------
    // Click any audit row -> opens a full timeline of the agent's execution:
    // user prompt -> agent thinking -> tool call chain -> approvals -> final
    // response. All data comes from the enriched agent_usage row (no extra
    // fetch); the overlay is a simple ng-if panel, not a $uibModal (which the
    // harness stubs and the dashboard context may not provide).
    $scope.turnDetail = null;
    $scope.showTurnDetail = function (a) { $scope.turnDetail = a; };
    $scope.closeTurnDetail = function () { $scope.turnDetail = null; };

    // Open a pending HITL-parked session in the chat widget. The chat drawer
    // mounts on module list / record detail / playbook pages -- NOT on the
    // dashboard where the monitor lives. So we stash the target session_id
    // (using the chat widget's one-shot key) and navigate to a page where the
    // drawer mounts. If we have record info, go to the record; otherwise go
    // to the alerts module list (a known drawer-mount surface).
    // ── Auto-opening the chat drawer ──────────────────────────────────────
    // "Open in chat" used to navigate to a page where the chat drawer MOUNTS
    // and stop there, leaving the analyst to spot the drawer tile and click it
    // themselves -- so the button appeared to do nothing but change pages.
    //
    // FortiSOAR's drawer is driven by the `csDrawerWidgetGroup` directive
    // (app/components/viewTemplates/widgets/drawerWidgetGroup.html). Its scope
    // hangs off `#global-drawer` and exposes exactly what the launcher tile's
    // ng-click calls: `launchWidget(name, version, metadata.view)`. For a
    // `popup: "custom"` widget (ours) that resolves the widget def, shows
    // `#custom-modal`, and broadcasts `popupOpened` -- which the chat widget
    // already listens for. Verified against a live 8.0.0 appliance: calling it
    // this way opens the drawer and renders the chat exactly as a click does.
    //
    // There is no public service for this; the scope IS the API surface. So
    // every step is defensive -- a platform version that renames the element or
    // the method must degrade to the old behaviour (navigate, don't open), not
    // throw.
    var CHAT_WIDGET_NAME = "agenticAssistant";

    function _drawerScope() {
      try {
        var el = document.getElementById("global-drawer");
        if (!el) return null;
        var ng = angular.element(el);
        // The template's root is inside the directive's isolate scope, so
        // .scope() resolves to it; check both in case that nesting changes.
        var sc = (ng.isolateScope && ng.isolateScope()) || (ng.scope && ng.scope());
        return (sc && typeof sc.launchWidget === "function") ? sc : null;
      } catch (e) { return null; }
    }

    // Is the drawer's popup container (#custom-modal) visible right now?
    function _drawerShowing() {
      try {
        var m = document.getElementById("custom-modal");
        if (!m) return false;
        var view = m.ownerDocument && m.ownerDocument.defaultView;
        var display = view && view.getComputedStyle ? view.getComputedStyle(m).display : m.style.display;
        return display !== "none";
      } catch (e) { return false; }
    }

    // Open the chat widget in the drawer. Returns true only if we actually
    // dispatched a launch.
    function _openChatDrawer() {
      var sc = _drawerScope();
      if (!sc) return false;
      var w = (sc.widgets || []).filter(function (x) {
        return x && x.name === CHAT_WIDGET_NAME;
      })[0];
      // `drawerVisibility` is recomputed by the directive per state from the
      // widget's own enableFor list. If the chat isn't enabled for the page we
      // landed on, launching it would show a drawer the platform means to hide.
      if (!w || !(w.metadata && w.metadata.drawerVisibility)) return false;
      // Skip only when the chat is active AND the drawer is actually showing.
      // `closeModal()` hides #custom-modal but never clears `activeWidget`, so
      // after the analyst leaves a page with the chat open, activeWidget still
      // names the chat while the drawer is hidden; trusting it alone meant
      // "Open in chat" switched the session but never showed the drawer.
      // Re-launching the active widget does not toggle: the platform just
      // re-shows the drawer and broadcasts popupOpened.
      if (sc.activeWidget === w.name + "_" + w.version && _drawerShowing()) return true;
      try {
        var fire = function () { sc.launchWidget(w.name, w.version, w.metadata.view); };
        // Don't nest a digest inside one that's already running.
        if (sc.$root && sc.$root.$$phase) fire(); else sc.$apply(fire);
        return true;
      } catch (e) { return false; }
    }

    // After navigation the drawer group re-renders and recomputes visibility,
    // and the installed-widget list may still be in flight, so the first
    // attempt can legitimately be too early. Poll briefly, then give up
    // quietly -- the analyst is on the right page either way.
    var AUTO_OPEN_TRIES = 12;
    var AUTO_OPEN_INTERVAL = 250;
    function _openChatDrawerWhenReady(triesLeft) {
      if (_openChatDrawer()) return;
      if (triesLeft <= 0) return;
      $timeout(function () {
        _openChatDrawerWhenReady(triesLeft - 1);
      }, AUTO_OPEN_INTERVAL);
    }

    // Arm a ONE-SHOT open for the next state change. This widget is destroyed
    // by the navigation it triggers, so the listener is registered on
    // $rootScope (which outlives it) and deregisters itself the first time it
    // fires. `_autoOpenArmed` makes double-arming impossible if the analyst
    // clicks two rows quickly.
    var _autoOpenArmed = false;
    function _armChatDrawerAutoOpen() {
      if (_autoOpenArmed) return;
      _autoOpenArmed = true;
      var off = null;
      var disarm = function () {
        _autoOpenArmed = false;
        if (off) { try { off(); } catch (e) {} off = null; }
      };
      try {
        var $rootScope = $injector.get("$rootScope");
        off = $rootScope.$on("$stateChangeSuccess", function () {
          disarm();
          // Let the drawer group's own $stateChangeSuccess handler recompute
          // drawerVisibility first; ours must observe the post-navigation state.
          $timeout(function () { _openChatDrawerWhenReady(AUTO_OPEN_TRIES); }, 0);
        });
      } catch (e) { _autoOpenArmed = false; return; }
      // Backstop: if the navigation never happens (already on the target
      // state, or a blocked transition), don't leave a listener armed to fire
      // on some unrelated navigation minutes later.
      $timeout(function () { disarm(); }, 8000);
    }

    // Shared by the Pending HITL card and the Live Sessions panel -- they had
    // byte-identical copies of this, and the record-context bug below had to be
    // fixed twice. `s` needs only {session_id, record_module?, record_uuid?}.
    function _openSessionInChat(s) {
      if (!s || !s.session_id) return;
      // Always stash the one-shot so the chat drawer picks it up on mount.
      try {
        var $win = $injector.get("$window");
        $win.localStorage.setItem("fsrPbOpenSession", s.session_id);
        if (s.record_module && s.record_uuid) {
          var recordIri = "/api/3/" + s.record_module + "/" + s.record_uuid;
          $win.localStorage.setItem("fsrPbSession:" + recordIri, s.session_id);
        }
      } catch (e) {}
      // Broadcast for the case where the chat drawer is already mounted.
      try { ($scope.$root || $scope).$broadcast("fsrAgenticAssistant:openSession",
        { session_id: s.session_id, record_uuid: s.record_uuid,
          record_module: s.record_module }); } catch (e) {}
      // If the drawer is already available on THIS page, open it directly --
      // no navigation, so no $stateChangeSuccess would ever fire to trigger it.
      if (_openChatDrawer()) return;
      // Otherwise arm the open for the page we're about to land on.
      _armChatDrawerAutoOpen();
      // Navigate to a page where the chat drawer mounts.
      try {
        var $state = $injector.get("$state");
        var appModulesService = $injector.get("appModulesService");
        var nav = {
          previousState: $state.current && $state.current.name,
          previousParams: JSON.stringify($state.params || {})
        };
        if (s.record_module && s.record_uuid) {
          // Best case: the session is pinned to a record -- open that record.
          var state = appModulesService.getState(s.record_module);
          if (state) {
            $state.go(state, angular.extend({ module: s.record_module,
              id: s.record_uuid }, nav));
            return;
          }
        }
        // A session opened over a module LIST has a record_module but no
        // record_uuid. The old test demanded both, so those sessions fell all
        // the way through to the hardcoded alerts list -- clicking "Open in
        // chat" on an `incidents` session dumped you on Alerts, a module the
        // conversation was never about. Land on the session's own module list
        // instead; the drawer mounts there too and picks up the one-shot.
        $state.go("main.modules.list",
          angular.extend({ module: s.record_module || "alerts" }, nav));
      } catch (e) { /* best-effort: services missing in some contexts */ }
    }

    // ── Autonomy (shadow) ─────────────────────────────────────────────────
    // An admin policy can name actions that may run without a click. In this
    // version it only records what it WOULD have done; every action still
    // waits for a reviewer. This tab is the go/no-go evidence: a rule may be
    // enforced only after two weeks with no "would run it, rejected".
    $scope.shadow = { rules: [], decisions: [], tuning: [], policy: null };
    $scope.loadShadow = function () {
      _panelStart("autonomy");
      $scope.loadPolicyViews();
      fsrMonitorAgentService.listShadowDecisions({})
        .then(function (res) {
                $scope.shadow = {
                  rules: (res && res.rules) || [],
                  decisions: (res && res.decisions) || [],
                  // Per detection rule: alerts the policy closed as false
                  // positives, and how many a person reopened.
                  tuning: (res && res.tuning) || [],
                  policy: (res && res.policy) || null
                };
                // The full document (rules + conditions) for display + editing.
                $scope.policyDoc = (res && res.policy_document) || null;
                _panelDone("autonomy");
              },
              function (err) { _panelFail("autonomy", err, "Could not load autonomy decisions."); });
    };
    // One plain line saying whether a policy is in force and in which mode.
    $scope.policyLine = function () {
      var p = $scope.shadow.policy;
      if (!p) return "No autonomy policy is set. Every action waits for a reviewer.";
      if (p.error) return "The autonomy policy could not be read, so it is ignored: " + p.error;
      if (p.enabled === false) return "The autonomy policy is switched off.";
      var n = (p.rules || []).length;
      var mode = p.mode === "enforce"
        ? "acts on its own in unattended triage; chats still wait for a reviewer"
        : "is recording only; every action still waits for a reviewer";
      return "The autonomy policy (" + n + " rule" + (n === 1 ? "" : "s") + ") " + mode + ".";
    };

    // ---- the full policy, readable, and the builder ----------------------
    // policyDoc is the stored document; these render each rule in plain words
    // for the display table. The builder below edits the policy as a structured
    // form (no JSON): an admin picks an action, the conditions that must hold,
    // and the limits, each in the same plain words the display table uses.
    $scope.policyDoc = null;
    $scope.policyRules = function () { return ($scope.policyDoc && $scope.policyDoc.rules) || []; };
    // An action in plain words. The stored policy names a connector operation or
    // a record tool; the analyst reads what it does, never the identifier.
    $scope.ruleAction = function (r) {
      var a = (r && r.action) || {};
      if (/^block_ip/.test(a.op || "")) return "Block an IP on FortiGate";
      if (a.tool === "run_playbook") return "Run a playbook";
      if (a.tool) return "Close the record" + (a.module ? " in " + a.module : "");
      if (a.connector || a.op) return "Run a connector action";
      return "No action";
    };
    // A policy-checked action's headline: its own summary, else a neutral line.
    $scope.shadowTitle = function (d) { return (d && d.summary) || "Action checked against the policy"; };
    $scope.ruleWhen = function (r) {
      var w = (r && r.when) || {}, bits = [];
      if (w.verdict) {
        var v = w.verdict;
        var disp = (v.disposition || []).map(function (d) {
          return String(d).replace(/_/g, " ");
        });
        bits.push("verdict " + (disp.join("/") || "any") +
          (v.min_confidence != null ? " at " + Math.round(v.min_confidence * 100) + "%+" : ""));
      }
      if (w.target) {
        var t = w.target;
        bits.push("target " + (t.kind || "ip") + (t.external_only ? ", external only" : "") +
          (t.not_in ? ", not in " + t.not_in : ""));
      }
      if (w.evidence) bits.push("evidence rates it " + (w.evidence.rated || "malicious"));
      return bits.join("; ") || "always";
    };
    $scope.ruleLimits = function (r) {
      var l = (r && r.limits) || null, bits = [];
      if (!l) return "";
      if (l.per_hour != null) bits.push(l.per_hour + "/hour");
      if (l.per_target_per_day != null) bits.push(l.per_target_per_day + "/target/day");
      return bits.join(", ");
    };

    // ---- the structured policy builder (no JSON) -------------------------
    // The actions a rule may authorize. This is the action picker's source: a
    // close (an update_record that retires the record) and the containment
    // actions the connector supports. Adding a containment action here is all
    // it takes to offer it in the builder.
    $scope.autonomyActions = [
      { key: "close", kind: "close", label: "Close the record" },
      { key: "block:fortigate-firewall/block_ip_new", kind: "block",
        label: "Block an IP on FortiGate",
        connector: "fortigate-firewall", op: "block_ip_new" },
    ];
    // The dispositions a verdict can carry, in the order a rule lists them.
    $scope.autonomyDispositions = [
      { key: "false_positive", label: "false positive" },
      { key: "benign", label: "benign" },
      { key: "suspicious", label: "suspicious" },
      { key: "true_positive", label: "true positive" },
    ];

    function _actionByKey(key) {
      for (var i = 0; i < $scope.autonomyActions.length; i++) {
        if ($scope.autonomyActions[i].key === key) return $scope.autonomyActions[i];
      }
      return null;
    }
    var _CLOSE_FIELDS = { status: true, resolution: true, closureNotes: true };
    function _arrEq(a, b) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length
        && a.every(function (x, i) { return x === b[i]; });
    }
    // A close the form can safely represent: an update_record that pins status
    // to Closed and writes only closure fields. An update_record that writes
    // anything else (owner, severity, a different status) is NOT a close -- the
    // form must not present it as one and recast it on save, so it is left
    // unsupported (read-only, saved verbatim).
    function _isCloseShape(a) {
      if (!a || a.tool !== "update_record") return false;
      if (!a.values || !_arrEq(a.values.status, ["Closed"])) return false;
      if (Object.keys(a.values).length !== 1) return false;
      var f = a.fields;
      return Array.isArray(f) && f.length > 0
        && f.every(function (k) { return _CLOSE_FIELDS[k] === true; });
    }
    // The picker value for a stored rule: a close (only when close-shaped), or
    // the matching block action. A block action the preset list does not know
    // (a different connector/op) is added to the list so editing never silently
    // drops or rewrites it. Any other action returns null -> read-only.
    function _actionKeyOf(rule) {
      var a = (rule && rule.action) || {};
      if (_isCloseShape(a)) return "close";
      if (a.tool !== "update_record" && a.connector && a.op) {
        var k = "block:" + a.connector + "/" + a.op;
        if (!_actionByKey(k)) {
          $scope.autonomyActions.push({ key: k, kind: "block",
            label: "Block on " + a.connector + " (" + a.op + ")",
            connector: a.connector, op: a.op });
        }
        return k;
      }
      return null;
    }
    // The action kind of a stored rule, independent of the picker's side list.
    function _ruleKind(a) {
      if (_isCloseShape(a)) return "close";
      if (a && a.tool !== "update_record" && a.connector && a.op) return "block";
      return null;
    }

    // ---- stored rule <-> builder row (pure, round-trips) -----------------
    // A row keeps the ORIGINAL stored rule (`_orig`) so a save preserves fields
    // the form does not model (e.g. `undo`, or pinned values beyond status) and
    // NEVER rewrites a rule the form cannot represent. `supported` is false for
    // a rule whose action is neither a record close nor a connector op; such a
    // rule is shown read-only and saved exactly as it was read, so editing one
    // rule can never silently weaken or recast another.
    function _ruleToRow(rule) {
      rule = rule || {};
      var w = rule.when || {}, v = w.verdict || {}, t = w.target || {},
          ev = w.evidence || null, lim = rule.limits || {}, a = rule.action || {};
      var key = _actionKeyOf(rule);
      var disp = {};
      (v.disposition || []).forEach(function (d) { disp[d] = true; });
      var fields = a.fields || [];
      return {
        id: rule.id || "",
        _orig: angular.copy(rule),
        supported: key != null,
        actionKey: key || "close",
        // close
        module: a.module || "alerts",
        setResolution: fields.indexOf("resolution") >= 0,
        setClosureNotes: fields.indexOf("closureNotes") >= 0,
        // block
        externalOnly: t.external_only !== false,
        notIn: t.not_in || "",
        // verdict
        disp: disp,
        minConfidence: v.min_confidence != null ? Math.round(v.min_confidence * 100) : 80,
        // evidence (keep the stored kind so a block's read/enrichment survives)
        requireLookup: !!ev,
        citesKind: (ev && ev.cites_tool_kind) || null,
        rated: (ev && ev.rated) || "malicious",
        // limits
        perHour: lim.per_hour != null ? lim.per_hour : null,
        perTargetPerDay: lim.per_target_per_day != null ? lim.per_target_per_day : null,
      };
    }

    function _num(x) { return x != null && x !== "" && !isNaN(Number(x)); }

    function _rowToRule(row) {
      // A rule the form cannot represent is saved exactly as it was read.
      if (!row.supported && row._orig) return angular.copy(row._orig);
      var cat = _actionByKey(row.actionKey) || $scope.autonomyActions[0];
      var disposition = $scope.autonomyDispositions
        .filter(function (d) { return row.disp && row.disp[d.key]; })
        .map(function (d) { return d.key; });
      // Build on a deep copy of the original so rule-level extras (undo, and any
      // keys the form does not touch) survive the edit.
      var rule = angular.copy(row._orig) || {};
      rule.id = row.id;
      rule.when = rule.when || {};
      rule.when.verdict = {
        disposition: disposition,
        min_confidence: Math.max(0, Math.min(100, Number(row.minConfidence) || 0)) / 100,
      };
      var origKind = _ruleKind((row._orig || {}).action);
      if (cat.kind === "close") {
        var fields = ["status"];
        if (row.setResolution) fields.push("resolution");
        if (row.setClosureNotes) fields.push("closureNotes");
        // A supported close pins status to Closed and writes only closure
        // fields (see _isCloseShape); rebuild it to exactly that shape.
        rule.action = { tool: "update_record", module: row.module || "alerts",
                        fields: fields, values: { status: ["Closed"] } };
        rule.when.target = angular.extend({}, rule.when.target || {}, { kind: "record" });
        if (row.requireLookup) { rule.when.evidence = { cites_tool_kind: "read" }; }
        else { delete rule.when.evidence; }
      } else {
        rule.action = angular.extend({}, rule.action || {},
          { connector: cat.connector, op: cat.op });
        ["tool", "module", "fields", "values"].forEach(function (k) { delete rule.action[k]; });
        rule.when.target = angular.extend({}, rule.when.target || {},
          { kind: "ip", external_only: !!row.externalOnly });
        if (row.notIn) { rule.when.target.not_in = row.notIn; }
        else { delete rule.when.target.not_in; }
        if (row.requireLookup) {
          // Keep the stored citation kind only when the action is still a
          // block; a kind the form flipped (close -> block) defaults to the
          // kind a block rests on (a rated threat-intel lookup).
          var cites = (origKind === "block" && row.citesKind) ? row.citesKind : "enrichment";
          rule.when.evidence = { cites_tool_kind: cites, rated: row.rated || "malicious" };
        } else { delete rule.when.evidence; }
      }
      // Merge the two modeled limits onto any stored limits; drop a modeled
      // key the user cleared, and the whole object once nothing is left.
      var limits = angular.copy((row._orig || {}).limits || {});
      if (_num(row.perHour)) { limits.per_hour = Number(row.perHour); } else { delete limits.per_hour; }
      if (_num(row.perTargetPerDay)) { limits.per_target_per_day = Number(row.perTargetPerDay); }
      else { delete limits.per_target_per_day; }
      if (Object.keys(limits).length) { rule.limits = limits; } else { delete rule.limits; }
      return rule;
    }

    // The default a brand-new rule starts from: a shadow-safe FP close. It must
    // be close-SHAPED (status pinned to Closed, closure fields only) so the row
    // is editable rather than falling through to read-only.
    function _blankRow() {
      return _ruleToRow({ id: "", action: { tool: "update_record", module: "alerts",
                            fields: ["status"], values: { status: ["Closed"] } },
                          when: { verdict: { disposition: ["false_positive", "benign"],
                                             min_confidence: 0.8 },
                                  target: { kind: "record" },
                                  evidence: { cites_tool_kind: "read" } } });
    }

    function _policyToBuilder(doc) {
      doc = doc || {};
      return {
        enabled: doc.enabled !== false,
        mode: doc.mode === "enforce" ? "enforce" : "shadow",
        rules: (doc.rules || []).map(_ruleToRow),
      };
    }
    // Start from a deep copy of the stored document so EVERY top-level field
    // the form does not model (version, protected lists, and anything a future
    // schema adds) is kept; overwrite only what the form owns.
    function _builderToPolicy(builder, base) {
      var doc = (base && typeof base === "object") ? angular.copy(base) : {};
      if (doc.version == null) doc.version = 1;
      doc.enabled = !!builder.enabled;
      doc.mode = builder.mode === "enforce" ? "enforce" : "shadow";
      doc.rules = (builder.rules || []).map(_rowToRule);
      return doc;
    }
    // Exposed so the controller test can round-trip without the DOM.
    $scope._policyToBuilder = _policyToBuilder;
    $scope._builderToPolicy = _builderToPolicy;

    // What the builder cannot let reach the connector (the connector validates
    // too; this keeps the message on the field that caused it).
    function _builderProblem(builder) {
      var ids = {};
      for (var i = 0; i < builder.rules.length; i++) {
        var r = builder.rules[i], n = i + 1;
        if (!String(r.id || "").trim()) return "Rule " + n + " needs a name.";
        if (ids[r.id]) return "Two rules are both named \"" + r.id + "\". Each needs its own name.";
        ids[r.id] = true;
        // A read-only (unrepresentable) rule is saved as-is; the form fields
        // below do not apply to it.
        if (!r.supported) continue;
        var chosen = $scope.autonomyDispositions.filter(function (d) { return r.disp && r.disp[d.key]; });
        if (!chosen.length) return "Rule \"" + r.id + "\" needs at least one verdict to match.";
        var c = Number(r.minConfidence);
        if (isNaN(c) || c < 0 || c > 100) return "Rule \"" + r.id + "\" needs a confidence between 0 and 100.";
      }
      return null;
    }

    $scope.policyBuilder = { open: false, saving: false, error: null, savedAt: null,
                             enabled: true, mode: "shadow", rules: [] };
    $scope.openPolicyBuilder = function () {
      $scope.policyBuilder.error = null;
      $scope.policyBuilder.savedAt = null;
      var fallback = { version: 1, enabled: true, mode: "shadow", rules: [] };
      // Load the stored document FRESH so the edit starts from exactly what the
      // box holds. If that read FAILS we do NOT open the builder on a stale or
      // empty copy: saving it would overwrite the real policy with something
      // that was never the current policy. The admin is told to try again.
      fsrMonitorAgentService.getAutonomyPolicy().then(function (res) {
        var doc = (res && res.policy) || $scope.policyDoc || fallback;
        $scope._policyBase = doc;
        angular.extend($scope.policyBuilder, _policyToBuilder(doc));
        $scope.policyBuilder.open = true;
      }, function () {
        $scope.policyBuilder.open = false;
        $scope.policyBuilder.error = "The current policy could not be read, so it cannot be edited safely right now. Try again.";
      });
    };
    $scope.cancelPolicyBuilder = function () {
      $scope.policyBuilder.open = false;
      $scope.policyBuilder.error = null;
    };
    $scope.addRule = function () {
      $scope.policyBuilder.rules.push(_blankRow());
    };
    $scope.removeRule = function (i) {
      $scope.policyBuilder.rules.splice(i, 1);
    };
    $scope.ruleActionKind = function (row) {
      var cat = _actionByKey(row && row.actionKey);
      return cat ? cat.kind : "close";
    };
    $scope.savePolicyBuilder = function () {
      var problem = _builderProblem($scope.policyBuilder);
      if (problem) { $scope.policyBuilder.error = problem; return; }
      var doc = _builderToPolicy($scope.policyBuilder, $scope._policyBase);
      $scope.policyBuilder.saving = true;
      $scope.policyBuilder.error = null;
      $scope.error = "";
      fsrMonitorAgentService.setAutonomyPolicy(doc).then(function (res) {
        $scope.policyBuilder.saving = false;
        if (res && res.ok) {
          $scope.policyBuilder.open = false;
          $scope.policyBuilder.savedAt = Date.now();
          $scope.loadShadow();
        } else {
          var err = res && res.error;
          $scope.policyBuilder.error = (err && err.message) ||
            (typeof err === "string" ? err : "The policy was not saved.");
        }
      }, function () {
        $scope.policyBuilder.saving = false;
        $scope.policyBuilder.error = "The policy could not be saved (connection error).";
      });
    };

    $scope.shadowOutcome = function (d) {
      if (d && d.policy && d.policy.mode === "enforced") return "Ran it";
      return (d && d.policy && d.policy.outcome === "would_act") ? "Would run it" : "Would ask";
    };
    $scope.shadowHuman = function (d) {
      if (!d || !d.human) return "Not decided yet";
      // Phase E: the policy itself decided (connector actor system:autonomy).
      if (d.actor === "system:autonomy") return "Run by the policy, no reviewer";
      var who = d.actor ? " by " + d.actor : "";
      return (d.human === "approve" ? "Approved" : d.human === "reject" ? "Rejected" : d.human) + who;
    };
    // The one disagreement that blocks enforcing a rule.
    $scope.shadowIsMiss = function (d) {
      return !!(d && d.policy && d.policy.outcome === "would_act" && d.human === "reject");
    };

    // One-click undo (phase D): reverse an approved action that ran. Offered
    // only when the connector recorded a successful run and knows the reverse
    // operation; decided once, so a second click elsewhere is told who did it.
    $scope.undoStates = {};
    function _undoKey(d) { return d.session_id + "/" + d.card_id; }
    $scope.undoStateFor = function (d) { return $scope.undoStates[_undoKey(d)]; };
    $scope.canUndo = function (d) {
      var st = $scope.undoStateFor(d);
      return !!(d && d.human === "approve" && d.executed === true && !d.undone_at && d.undo &&
                !(st && (st.state === "sending" || st.state === "done" || st.state === "taken")));
    };
    $scope.undoneLine = function (d) {
      if (!d || !d.undone_at) return "";
      return "Undone" + (d.undone_by ? " by " + d.undone_by : "");
    };
    $scope.undoAction = function (d) {
      var key = _undoKey(d);
      var cur = $scope.undoStates[key];
      if (cur && (cur.state === "sending" || cur.state === "done" || cur.state === "taken")) return;
      $scope.error = "";
      $scope.undoStates[key] = { state: "sending" };
      var payload = { session_id: d.session_id, card_id: d.card_id };
      if ($scope.currentUser) payload.actor = $scope.currentUser;
      return fsrMonitorAgentService.undoAction(payload).then(function (res) {
        var err = res && res.ok === false && res.error;
        if (err) {
          var taken = err.code === "already_undone";
          $scope.undoStates[key] = { state: taken ? "taken" : "failed", message: err.message || err.code };
          if (taken && err.undone) { d.undone_by = err.undone.undone_by; d.undone_at = err.undone.undone_at; }
          return;
        }
        $scope.undoStates[key] = { state: "done" };
        d.undone_at = Date.now() / 1000;
        d.undone_by = ($scope.currentUser && ($scope.currentUser.name || $scope.currentUser.iri)) || null;
      }, function (er) {
        $scope.undoStates[key] = { state: "failed",
                                   message: (er && (er.message || (er.data && er.data.message))) || "The connector did not answer." };
      });
    };

    $scope.loadScheduled = function () {
      _panelStart("scheduled");
      fsrMonitorAgentService.listScheduledTasks()
        .then(function (res) {
                $scope.scheduledTasks = (res && res.tasks) || [];
                _panelDone("scheduled");
              },
              function (err) { _panelFail("scheduled", err, "Scheduled-tasks load failed."); });
    };

    // Per-task feedback for the ▶ Run button. Triggering used to be entirely
    // silent on success: the op fires and the row reloads, but `last_run_at` /
    // `total_run_count` come from the scheduler and do not move for several
    // seconds, so the table looked *identical* after the click. With no
    // spinner, no confirmation and no error, a run that failed inside
    // FortiSOAR (see the connector-name bug -- every fire died in the
    // platform) was indistinguishable from one that worked.
    $scope.runState = {};
    $scope.runStateFor = function (name) { return $scope.runState[name] || null; };
    function _setRunState(name, state, message) {
      $scope.runState[name] = { state: state, message: message };
      if (state !== "running") {
        // Clear the transient result after a beat; the row's own last-run
        // columns are the durable record.
        $timeout(function () {
          var cur = $scope.runState[name];
          if (cur && cur.state === state) delete $scope.runState[name];
        }, 6000);
      }
    }

    $scope.runScheduledNow = function (name) {
      if ($scope.runStateFor(name) &&
          $scope.runStateFor(name).state === "running") return;
      $scope.error = "";
      _setRunState(name, "running", "Triggering…");
      fsrMonitorAgentService.runScheduledTaskNow(name)
        .then(function (res) {
          if (res && res.ok === false) {
            var msg = (res.error && res.error.message) || "Trigger failed.";
            _setRunState(name, "error", msg);
          } else {
            _setRunState(name, "ok", "Triggered");
            // The scheduler updates last_run_at/total_run_count a moment after
            // it accepts the trigger, so an immediate reload shows stale
            // counters. Reload now (for anything already settled) and again
            // shortly after, which is when the run actually registers.
            $scope.loadScheduled();
            $timeout(function () { $scope.loadScheduled(); }, 4000);
          }
        },
              function (err) {
                var msg = (err && err.message) || "Trigger failed.";
                _setRunState(name, "error", msg);
              });
    };

    // ── Live Sessions panel (monitor §10.2) ───────────────────────────────
    // Active agentic chat sessions with a connector-derived status. The status
    // is computed server-side (active / waiting_approval / idle) from the
    // turn_progress + suspended_sessions stores -- never from a stale column.
    // Filters are forwarded to the op. Previously this sent a bare
    // {limit: 50}, so drilling in from the "Pending HITL" card showed the
    // chip `status: waiting_approval` above a list of purely idle sessions.
    $scope.loadLiveSessions = function () {
      var f = angular.extend({ limit: 50 }, $scope._panelFilters("sessions"));
      _panelStart("sessions");
      fsrMonitorAgentService.listActiveSessions(f)
        .then(function (res) {
                $scope.liveSessions = (res && res.sessions) || [];
                _panelDone("sessions");
              },
              function (err) { _panelFail("sessions", err, "Live sessions load failed."); });
    };

    // Status → badge class for the live-session pips.
    $scope.sessionStatusClass = function (status) {
      return { active: "on", waiting_approval: "waiting", idle: "paused" }[status] || "paused";
    };

    // Relative "last activity" for a live session: 2m ago / just now / 1h ago.
    $scope.sessionAgo = function (s) {
      var ts = s && s.last_activity;
      if (!ts) return "--";
      var secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
      if (secs < 10) return "just now";
      if (secs < 3600) return Math.floor(secs / 60) + "m ago";
      if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
      return Math.floor(secs / 86400) + "d ago";
    };

    // Best-effort "View in chat": the chat widget is drawer-mounted on a record
    // page, so the only way to surface it from this standalone dashboard is to
    // navigate to the session's mounted record (which mounts the chat drawer
    // there). Also broadcasts an openSession event as the forward seam for a
    // future chat-widget listener. Sessions with no mounted record can't be
    // reopened this way yet -- the button is disabled in the template then.
    $scope.openInChat = function (s) { _openSessionInChat(s); };

    // Per-user rollup for the user-activity table (derived from usage rows).
    // Cache by $scope.usage reference so AngularJS $watchCollection sees a
    // stable array across digest cycles -- recomputing every call (the
    // naive version) produces a new object per entry each time, which trips
    // $rootScope:infdig when the table has real data.
    var _usersCache = [];
    var _usersUsageRef = null;
    $scope.users = function () {
      var cur = $scope.usage || [];
      if (_usersUsageRef === cur) return _usersCache;
      _usersUsageRef = cur;
      var map = {};
      cur.forEach(function (u) {
        // Group by IRI (the stable identity) but display the name. `iri` is
        // what the audit-trail filter must send -- sending the display name
        // into the IRI-keyed `user_iri` param matches nothing and returns an
        // empty audit trail.
        var key = u.user_iri || u.user_name || "(unknown)";
        if (!map[key]) map[key] = { key: key, name: u.user_name || u.user_iri || "(unknown)",
                                    iri: u.user_iri || null, turns: 0, tokens: 0, cost: 0 };
        map[key].turns += 1;
        map[key].tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
        map[key].cost += (u.cost_usd || 0);
      });
      var arr = Object.keys(map).map(function (k) { return map[k]; });
      arr.sort(function (a, b) { return b.cost - a.cost; });
      _usersCache = arr;
      return arr;
    };

    // Only rows with a real IRI can be drilled into. Turns with no attributed
    // user (scheduled/system runs) roll up under "(unknown)" and have nothing
    // to filter on -- offering the link there would just empty the audit tab.
    $scope.canFilterUser = function (u) { return !!(u && u.iri); };
    $scope.filterByUser = function (u) {
      if (!$scope.canFilterUser(u)) return;
      $scope.toggleFilter("user_iri", u.iri, u.name);
      $scope.setTab("audit");
    };

    // Cost share % for the per-user progress bars.
    $scope.userSharePct = function (u) {
      var total = ($scope.totals && $scope.totals.cost) || 0;
      return total > 0 ? (u.cost / total) * 100 : 0;
    };

    // ── Chart path builders ──────────────────────────────────────────────
    // Build an SVG path string from a series of numeric values scaled into a
    // viewBox. `w`/`h` are the viewBox dims; `pad` keeps the line off the edge.
    function _sparkPath(values, w, h, pad) {
      if (!values || values.length < 2) return "";
      var max = Math.max.apply(null, values);
      // Zero-based: these are counts/costs, so a quiet bucket must sit on the
      // floor. Scaling to the observed min would redraw "3,4,5" as a full-
      // height climb identical to "0,50,100".
      var min = Math.min(0, Math.min.apply(null, values));
      var range = max - min || 1;
      var step = (w - pad * 2) / (values.length - 1);
      var pts = values.map(function (v, i) {
        var x = pad + i * step;
        var y = h - pad - ((v - min) / range) * (h - pad * 2);
        return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
      });
      return pts.join(" ");
    }
    // Fill variant: closes the path to the bottom of the viewBox.
    function _sparkFill(path, w, h, pad) {
      if (!path) return "";
      return path + " L" + (w - pad).toFixed(1) + "," + h + " L" + pad + "," + h + " Z";
    }
    // Zero-filled per-bucket values across the configured range, from a
    // server-side summary ([{bucket, value}]). Keys use the producer's format.
    function _series(summary, granularity) {
      var map = {};
      (summary || []).forEach(function (x) { map[x.bucket] = x.value || 0; });
      return _fillRange(map, granularity, new Date(fromFor($scope.config.range)), "long")
        .map(function (b) { return b.value; });
    }
    function _computeSparklines() {
      var w = 100, h = 28, pad = 3;
      var g = _granularity();
      var turns = _series($scope.summaryTurns, g);
      var tokens = _series($scope.summaryTokens, g);
      var cost = _series($scope.summaryCost, g);
      $scope.sparkTurns = _sparkPath(turns, w, h, pad);
      $scope.sparkTurnsFill = _sparkFill($scope.sparkTurns, w, h, pad);
      $scope.sparkTokens = _sparkPath(tokens, w, h, pad);
      $scope.sparkTokensFill = _sparkFill($scope.sparkTokens, w, h, pad);
      $scope.sparkCost = _sparkPath(cost, w, h, pad);
      $scope.sparkCostFill = _sparkFill($scope.sparkCost, w, h, pad);
    }
    // The overview area chart: cost-per-bucket from the summary, zero-filled
    // across the range and drawn into a 0..1000 × 0..140 viewBox.
    //
    // Geometry notes (all three were bugs):
    //  * The plot spans the FULL viewBox width (padX = 0). The old version
    //    inset the path by 8px but positioned the axis labels on a 0..400
    //    scale, so the labels never sat over their data points and the first
    //    and last were half-clipped by the viewBox edge.
    //  * Axis labels are HTML, not <text> inside the SVG. The SVG uses
    //    preserveAspectRatio="none" (a ~1150px-wide box showing a 1000-unit
    //    viewBox), which stretches glyphs horizontally -- that is why the
    //    labels used to render as "0 7 - 2 8".
    //  * Label x is a PERCENTAGE off the same divisor as the path, so the two
    //    can't drift apart, and the count of labels no longer changes the
    //    spacing of the ones that are shown.
    function _computeAreaChart() {
      var w = 1000, h = 140, padTop = 10, padBottom = 6;
      var g = _granularity();
      var map = {};
      ($scope.summaryCost || []).forEach(function (x) { map[x.bucket] = x.value || 0; });
      var s = _fillRange(map, g, new Date(fromFor($scope.config.range)), "long");
      $scope.summary = s;
      if (!s.length) {
        $scope.costAreaPath = ""; $scope.costAreaFill = "";
        $scope.costAreaLabels = []; $scope.costAreaMax = 0;
        return;
      }
      var values = s.map(function (x) { return x.value || 0; });
      var max = Math.max.apply(null, values) || 1;
      var innerH = h - padTop - padBottom;
      var divisor = Math.max(1, values.length - 1);
      var step = w / divisor;
      var pts = values.map(function (v, i) {
        var x = i * step;
        var y = padTop + innerH - (v / max) * innerH;
        return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
      });
      // Single bucket: extend flat to the right edge so a segment is visible.
      if (values.length === 1) pts.push("L" + w + "," + pts[0].slice(1));
      var path = pts.join(" ");
      $scope.costAreaPath = path;
      $scope.costAreaFill = path + " L" + w + "," + (padTop + innerH) +
        " L0," + (padTop + innerH) + " Z";
      // Peak value, surfaced as the chart's y-axis label -- without it the
      // area has no readable magnitude at all.
      $scope.costAreaMax = Math.max.apply(null, values);
      // Axis labels: every bucket when there's room, else a thinned-out set
      // that always keeps the first and last. `leftPct` uses the same divisor
      // as the path, so a label sits exactly over its point.
      var maxLabels = 8;
      var stride = Math.ceil(s.length / maxLabels);
      $scope.costAreaLabels = [];
      s.forEach(function (b, i) {
        if (i % stride !== 0 && i !== s.length - 1) return;
        $scope.costAreaLabels.push({
          // "2026-07-28" -> "07-28";  "2026-07-28T14:00:00" -> "14:00"
          text: g === "hour" ? b.bucket.slice(11, 16) : b.bucket.slice(5, 10),
          leftPct: (i / divisor) * 100
        });
      });
    }

    // ── Handled-cases queue (M1), outcome tiles (M2), feedback (M3) ───────
    // The connector buckets every auto-triaged case: handled (the assistant
    // finished it), needs_you (neither closed nor escalated, or escalated and
    // waiting) and reopened (closed, then a person reopened it). The tab badges
    // come from `counts`, which cover the whole window, so they stay stable
    // while one bucket is on screen.
    $scope.QUEUE_BUCKETS = [
      { key: "handled", label: "Handled for you" },
      { key: "needs_you", label: "Needs you" },
      { key: "reopened", label: "Reopened" }
    ];
    $scope.QUEUE_WINDOWS = [
      { hours: 24, label: "Last 24 hours" },
      { hours: 72, label: "Last 3 days" },
      { hours: 168, label: "Last 7 days" },
      { hours: 720, label: "Last 30 days" }
    ];
    $scope.queue = { bucket: "handled", hours: 24, rows: [], total: 0,
                     counts: { handled: 0, needs_you: 0, reopened: 0 } };
    $scope.kpis = null;
    var _queueSeq = 0;
    var _kpiSeq = 0;

    $scope.loadQueue = function () {
      var seq = ++_queueSeq;
      var q = $scope.queue;
      _panelStart("queue");
      fsrMonitorAgentService.listCases({ view: "list", bucket: q.bucket, hours: q.hours, limit: 50 })
        .then(function (res) {
          if (seq !== _queueSeq) return; // a newer request owns the panel
          if (!res || res.ok === false || !angular.isArray(res.rows)) {
            _panelFail("queue", null, "The handled cases could not be loaded.");
            return;
          }
          res.rows.forEach(function (r) {
            if (!r.feedback) r.feedback = { mine: null, note: "", right: 0, wrong: 0 };
          });
          q.rows = res.rows;
          q.total = res.total != null ? res.total : res.rows.length;
          q.counts = angular.extend({ handled: 0, needs_you: 0, reopened: 0 }, res.counts || {});
          _panelDone("queue");
        }, function (err) { if (seq === _queueSeq) _panelFail("queue", err, "The handled cases could not be loaded."); });
    };
    $scope.loadKpis = function () {
      var seq = ++_kpiSeq;
      fsrMonitorAgentService.listCases({ view: "kpis", hours: $scope.queue.hours })
        .then(function (res) {
          if (seq !== _kpiSeq) return;
          $scope.kpis = (res && res.ok !== false && res.kpis) || null;
        }, function () { if (seq === _kpiSeq) $scope.kpis = null; });
    };
    // ── Would help most (X7) ──────────────────────────────────────────────
    // Over the window's uncertain cases, the connector ranks the sources that
    // were missing or failing by how many of those cases each would have
    // helped. This only displays that ranking: nothing is counted here. State:
    // loading | ready | unavailable (an older connector cannot answer).
    $scope.wouldHelp = { state: "loading", uncertain: 0, withHelp: 0, items: [] };
    var _helpSeq = 0;
    $scope.loadWouldHelp = function () {
      var seq = ++_helpSeq;
      fsrMonitorAgentService.listCases({ view: "would_help", hours: $scope.queue.hours })
        .then(function (res) {
          if (seq !== _helpSeq) return;
          if (!res || res.ok === false || !angular.isArray(res.items)) {
            $scope.wouldHelp = { state: "unavailable", uncertain: 0, withHelp: 0, items: [] };
            return;
          }
          $scope.wouldHelp = { state: "ready", uncertain: res.uncertain || 0,
                               withHelp: res.with_help || 0, items: res.items };
        }, function () {
          if (seq === _helpSeq) $scope.wouldHelp = { state: "unavailable", uncertain: 0, withHelp: 0, items: [] };
        });
    };
    // "Would have helped 7 uncertain cases"
    $scope.helpCasesText = function (it) {
      var n = (it && it.cases) || 0;
      return "Would have helped " + n + " uncertain " + (n === 1 ? "case" : "cases");
    };
    // A source that was searched and returned nothing needs data, not setup.
    $scope.helpNeedsSetup = function (it) {
      return !!it && (it.state === "not_connected" || it.state === "failed");
    };
    // The platform's Connectors page: the route comes from the router, never a
    // host. The fallback is the same page's hash path.
    $scope.connectorsHref = function () {
      try {
        var href = $injector.get("$state").href("main.connectors");
        if (href) return href;
      } catch (e) { /* no router here: use the path */ }
      return "#/main/connectors";
    };
    $scope.setQueueBucket = function (b) {
      if ($scope.queue.bucket === b) return;
      $scope.queue.bucket = b;
      $scope.queue.rows = [];
      $scope.loadQueue();
    };
    $scope.queueWindowChanged = function () { $scope.loadQueue(); $scope.loadKpis(); $scope.loadWouldHelp(); };
    $scope.queueWindowLabel = function () {
      var w = $scope.QUEUE_WINDOWS.filter(function (x) { return x.hours === $scope.queue.hours; })[0];
      return (w ? w.label : "Last " + $scope.queue.hours + " hours").toLowerCase();
    };
    $scope.kpiValue = function (key) {
      var k = $scope.kpis;
      return k && k[key] != null ? k[key] : "-";
    };
    // "93% (27 rated)", or the plain statement that nobody has rated anything.
    $scope.agreementText = function () {
      var k = $scope.kpis;
      if (!k) return "-";
      if (k.agreement == null || !k.rated) return "No ratings yet";
      return Math.round(k.agreement * 100) + "% (" + k.rated + " rated)";
    };
    $scope.costTodayText = function () {
      var k = $scope.kpis;
      return k && k.cost_today_usd != null ? "$" + $scope.fmtCost(k.cost_today_usd) : "not available";
    };

    // Row text, in the analyst's words.
    var _ACTION_KIND_LABELS = { taken: "Done", would_have: "Not run (shadow mode)",
                                escalated: "Waiting for you", none: "No action" };
    $scope.actionKindLabel = function (r) { return _ACTION_KIND_LABELS[r && r.action_kind] || ""; };
    $scope.confText = function (r) {
      return r && r.confidence != null ? Math.round(r.confidence * 100) + "%" : "-";
    };
    $scope.sourcesText = function (r) {
      return r && r.sources && r.sources.length ? r.sources.join(", ") : "-";
    };
    $scope.queueAgo = function (r) { return $scope.sessionAgo({ last_activity: r && r.at }); };
    // Link to the record: /api/3/<module>/<uuid> -> the record's page.
    $scope.recordHref = function (r) {
      var m = /^\/api\/3\/([^/]+)\/([^/?#]+)/.exec((r && r.record_iri) || "");
      return m ? "#/main/modules/" + m[1] + "/" + m[2] : null;
    };

    // Undo from the queue reuses the autonomy tab's undo (one op, one state map).
    function _undoRef(r) {
      if (!r._undoRef) r._undoRef = { session_id: r.session_id, card_id: r.action_card_id };
      return r._undoRef;
    }
    $scope.queueUndoState = function (r) { return $scope.undoStateFor(_undoRef(r)); };
    $scope.canQueueUndo = function (r) {
      var st = r && r.undoable && $scope.queueUndoState(r);
      return !!(r && r.undoable && !(st && (st.state === "sending" || st.state === "done" || st.state === "taken")));
    };
    $scope.queueUndo = function (r) {
      var p = $scope.undoAction(_undoRef(r));
      if (p && p.then) p.then(function () {
        var st = $scope.queueUndoState(r);
        if (st && (st.state === "done" || st.state === "taken")) { $scope.loadQueue(); $scope.loadKpis(); }
      });
    };

    // Right / wrong feedback. The button answers at once (optimistic), the
    // connector's read-back replaces the row's feedback, and a failure puts the
    // previous state back with a plain message.
    var _FEEDBACK_ERRORS = {
      no_analyst: "Your account is not set up to rate decisions, so nothing was saved.",
      not_found: "That case could not be found, so nothing was saved.",
      bad_iri: "That case could not be found, so nothing was saved.",
      bad_rating: "That rating was not understood, so nothing was saved."
    };
    function _feedbackFailure(r, prev, err) {
      r.feedback = prev;
      r.feedbackSaving = false;
      var code = typeof err === "string" ? err : err && (err.code || (err.error && err.error.code));
      r.feedbackError = _FEEDBACK_ERRORS[code] || "Your rating could not be saved. Try again.";
    }
    function _sendFeedback(r, rating, note, prev) {
      r.feedbackSaving = true;
      r.feedbackError = "";
      var payload = { record: r.record_iri, rating: rating };
      if (note != null) payload.note = note;
      if ($scope.currentUser) payload.actor = $scope.currentUser;
      return fsrMonitorAgentService.submitFeedback(payload).then(function (res) {
        if (!res || res.ok === false || !res.feedback) {
          _feedbackFailure(r, prev, res && res.error);
          return;
        }
        r.feedback = res.feedback;
        r.feedbackSaving = false;
        if (note != null) { r.noteDraft = res.feedback.note || ""; r.noteSaved = true; }
        $scope.loadKpis();
      }, function (err) { _feedbackFailure(r, prev, err); });
    }
    $scope.rate = function (r, rating) {
      if (!r || r.feedbackSaving) return;
      var fb = r.feedback;
      var next = fb.mine === rating ? "" : rating;
      var prev = angular.copy(fb);
      if (fb.mine) fb[fb.mine] = Math.max(0, (fb[fb.mine] || 0) - 1);
      if (next) fb[next] = (fb[next] || 0) + 1;
      fb.mine = next || null;
      return _sendFeedback(r, next, null, prev);
    };
    $scope.toggleQueueDetail = function (r) {
      r.open = !r.open;
      if (r.open && r.noteDraft == null) r.noteDraft = (r.feedback && r.feedback.note) || "";
    };
    $scope.saveFeedbackNote = function (r) {
      if (!r || r.feedbackSaving || !r.feedback.mine) return;
      r.noteSaved = false;
      return _sendFeedback(r, r.feedback.mine, (r.noteDraft || "").slice(0, 500), angular.copy(r.feedback));
    };
    // ── Policy readiness (M4) and tuning (M5) ─────────────────────────────
    // The connector computes whether each rule is ready to enforce and whether
    // a noisy detection rule is safe to tune, from the thresholds it sends.
    // This only displays those answers; nothing is recomputed here. While the
    // answer is in flight, or when an older connector cannot give it, the
    // earlier shadow table and tuning counters stay on screen (state
    // "unavailable"), so the tab never goes blank.
    $scope.policyView = { state: "loading", mode: null, thresholds: null, rules: [], hours: 336 };
    $scope.tuningView = { state: "loading", thresholds: null, rules: [] };
    $scope.ruleDrawer = { open: false, rule: null, loading: false, failed: "", rows: [] };
    var _policySeq = 0;
    var _tuningSeq = 0;
    var _drawerSeq = 0;
    $scope.loadPolicyViews = function () {
      var pseq = ++_policySeq;
      var tseq = ++_tuningSeq;
      fsrMonitorAgentService.listCases({ view: "policy" }).then(function (res) {
        if (pseq !== _policySeq) return;
        if (!res || res.ok === false || !angular.isArray(res.rules)) { $scope.policyView.state = "unavailable"; return; }
        $scope.policyView = { state: "ready", mode: res.mode || null, thresholds: res.thresholds || null,
                              rules: res.rules, hours: res.hours || 336 };
      }, function () { if (pseq === _policySeq) $scope.policyView.state = "unavailable"; });
      fsrMonitorAgentService.listCases({ view: "tuning" }).then(function (res) {
        if (tseq !== _tuningSeq) return;
        if (!res || res.ok === false || !angular.isArray(res.rules)) { $scope.tuningView.state = "unavailable"; return; }
        $scope.tuningView = { state: "ready", thresholds: res.thresholds || null, rules: res.rules };
      }, function () { if (tseq === _tuningSeq) $scope.tuningView.state = "unavailable"; });
    };
    // The mode, in words.
    $scope.policyModeText = function () {
      var m = $scope.policyView.mode;
      if (m === "enforce") return "Enforcing: rules act on their own in unattended triage";
      if (m === "shadow") return "Recording only: nothing acts on its own yet";
      if (m === "off") return "Switched off";
      return "Not set";
    };
    function _pct(x) { return Math.round(x * 100) + "%"; }
    // "24 decisions, 96% agreement, 0% reopened"
    $scope.ruleNumbers = function (r) {
      var n = r.sample || 0;
      return n + (n === 1 ? " decision" : " decisions") + ", " +
        (r.agreement == null ? "agreement not known yet" : _pct(r.agreement) + " agreement") + ", " +
        (r.reopen_rate == null ? "reopens not known yet" : _pct(r.reopen_rate) + " reopened");
    };
    $scope.ruleName = function (r) { return r.label || r.rule_id; };
    $scope.readyBar = function () {
      var t = $scope.policyView.thresholds;
      if (!t) return "";
      return "A rule is ready to enforce at " + t.min_sample + " decisions or more, " + _pct(t.min_agreement) +
        " agreement or better, and " + _pct(t.max_reopen_rate) + " or fewer reopened.";
    };
    $scope.tuneBar = function () {
      var t = $scope.tuningView.thresholds;
      if (!t) return "";
      return "A detection rule is safe to tune at " + t.min_closes + " closes by the assistant or more, with " +
        _pct(t.max_reopen_rate) + " or fewer reopened. Tuning a noisy rule at its source stops the alerts; a reopened close means the assistant got one wrong.";
    };
    $scope.tuningRate = function (t) { return t.reopen_rate == null ? "-" : _pct(t.reopen_rate); };
    // The decision drawer: this rule's recent decisions, picked out of the
    // cases list on this side.
    function _loadDrawer(rule) {
      var seq = ++_drawerSeq;
      var d = $scope.ruleDrawer;
      d.loading = true;
      d.failed = "";
      fsrMonitorAgentService.listCases({ view: "list", bucket: "all", hours: $scope.policyView.hours, limit: 200 })
        .then(function (res) {
          if (seq !== _drawerSeq) return;
          d.loading = false;
          if (!res || res.ok === false || !angular.isArray(res.rows)) { d.failed = "The decisions for this rule could not be loaded."; return; }
          d.rows = res.rows.filter(function (r) { return r.rule_id === rule.rule_id; });
          d.rows.forEach(function (r) { if (!r.feedback) r.feedback = { mine: null, note: "", right: 0, wrong: 0 }; });
        }, function () {
          if (seq !== _drawerSeq) return;
          d.loading = false;
          d.failed = "The decisions for this rule could not be loaded.";
        });
    }
    $scope.openRuleDrawer = function (rule) {
      var d = $scope.ruleDrawer;
      if (d.open && d.rule && d.rule.rule_id === rule.rule_id) { $scope.closeRuleDrawer(); return; }
      d.open = true;
      d.rule = rule;
      d.rows = [];
      _loadDrawer(rule);
    };
    $scope.closeRuleDrawer = function () {
      _drawerSeq++;
      angular.extend($scope.ruleDrawer, { open: false, rule: null, loading: false, failed: "", rows: [] });
    };
    $scope.isRuleOpen = function (rule) {
      return !!($scope.ruleDrawer.open && $scope.ruleDrawer.rule && $scope.ruleDrawer.rule.rule_id === rule.rule_id);
    };
    $scope.drawerUndo = function (r) {
      var p = $scope.undoAction(_undoRef(r));
      if (p && p.then) p.then(function () {
        var st = $scope.queueUndoState(r);
        if (st && (st.state === "done" || st.state === "taken") && $scope.ruleDrawer.rule) {
          _loadDrawer($scope.ruleDrawer.rule);
          $scope.loadPolicyViews();
        }
      });
    };

    // ── Scheduled hunts (X6) ──────────────────────────────────────────────
    // A hunt is a saved question the assistant investigates on FortiSOAR's own
    // scheduler. The connector owns the schedule, the run and the case it
    // opens; this only lists, creates, edits, pauses, runs and deletes. The
    // list arrives with the schedule already in words and each run's outcome
    // already named, so nothing here interprets text.
    $scope.HUNT_SCHEDULES = [
      { key: "hourly", label: "Every hour", cron: "0 * * * *" },
      { key: "four", label: "Every 4 hours", cron: "0 */4 * * *" },
      { key: "daily", label: "Every day at 06:00", cron: "0 6 * * *" },
      { key: "weekdays", label: "Weekdays at 08:00", cron: "0 8 * * 1-5" },
      { key: "custom", label: "Custom schedule", cron: "" }
    ];
    $scope.HUNT_MODULES = [
      { key: "alerts", label: "An alert" },
      { key: "incidents", label: "An incident" }
    ];
    var _HUNT_OUTCOME_CLASS = { finding: "waiting", quiet: "on", inconclusive: "paused", error: "error" };
    $scope.huntOutcomeClass = function (h) { return _HUNT_OUTCOME_CLASS[h && h.last_outcome] || "paused"; };
    $scope.huntForm = null;          // the open create/edit form, or null
    $scope.huntDeleting = null;      // name of the hunt awaiting delete confirmation
    $scope.huntRowError = {};        // per-hunt failure text

    $scope.loadHunts = function () {
      _panelStart("hunts");
      fsrMonitorAgentService.listHunts().then(function (res) {
        if (!res || res.ok === false || !angular.isArray(res.hunts)) {
          _panelFail("hunts", null, "The scheduled hunts could not be loaded.");
          return;
        }
        $scope.hunts = res.hunts;
        _panelDone("hunts");
      }, function (err) { _panelFail("hunts", err, "The scheduled hunts could not be loaded."); });
    };
    $scope.huntLastRun = function (h) {
      return h && h.last_run_at ? $scope.sessionAgo({ last_activity: h.last_run_at }) : "Not run yet";
    };
    $scope.huntCaseHref = function (h) { return $scope.recordHref({ record_iri: h && h.case_iri }); };

    function _huntSchedKey(cron) {
      var m = $scope.HUNT_SCHEDULES.filter(function (s) { return s.cron && s.cron === cron; })[0];
      return m ? m.key : "custom";
    }
    $scope.newHunt = function () {
      $scope.huntForm = { editing: false, name: "", question: "", schedule: "hourly",
                          cron: "", module: "alerts", saving: false, error: "" };
    };
    $scope.editHunt = function (h) {
      var key = _huntSchedKey(h.cron);
      $scope.huntForm = { editing: true, name: h.name, question: h.question, schedule: key,
                          cron: key === "custom" ? h.cron : "", module: h.module || "alerts",
                          saving: false, error: "" };
    };
    $scope.cancelHunt = function () { $scope.huntForm = null; };
    // The cron the form stands for: a preset's own, or what was typed.
    $scope.huntFormCron = function () {
      var f = $scope.huntForm;
      if (!f) return "";
      if (f.schedule !== "custom") {
        var p = $scope.HUNT_SCHEDULES.filter(function (s) { return s.key === f.schedule; })[0];
        return p ? p.cron : "";
      }
      return (f.cron || "").trim();
    };
    $scope.huntFormValid = function () {
      var f = $scope.huntForm;
      return !!(f && (f.name || "").trim() && (f.question || "").trim() && $scope.huntFormCron());
    };
    function _failText(res, err) {
      var m = (res && res.error && res.error.message) || (err && (err.message || (err.data && err.data.message)));
      return m || "The connector did not answer.";
    }
    $scope.saveHunt = function () {
      var f = $scope.huntForm;
      if (!f || f.saving || !$scope.huntFormValid()) return;
      f.saving = true;
      f.error = "";
      fsrMonitorAgentService.saveHunt({
        name: f.name.trim(), question: f.question.trim(),
        cron: $scope.huntFormCron(), module: f.module
      }).then(function (res) {
        if (res && res.ok === false) { f.saving = false; f.error = "The hunt was not saved. " + _failText(res); return; }
        $scope.huntForm = null;
        $scope.loadHunts();
      }, function (err) { f.saving = false; f.error = "The hunt was not saved. " + _failText(null, err); });
    };
    // Pause or resume the schedule; the definition and its history stay.
    $scope.toggleHunt = function (h) {
      $scope.huntRowError[h.name] = "";
      fsrMonitorAgentService.saveHunt({ name: h.name, enabled: !h.enabled }).then(function (res) {
        if (res && res.ok === false) { $scope.huntRowError[h.name] = _failText(res); return; }
        $scope.loadHunts();
      }, function (err) { $scope.huntRowError[h.name] = _failText(null, err); });
    };
    $scope.askDeleteHunt = function (h) { $scope.huntDeleting = h.name; };
    $scope.cancelDeleteHunt = function () { $scope.huntDeleting = null; };
    $scope.deleteHunt = function (h) {
      $scope.huntRowError[h.name] = "";
      fsrMonitorAgentService.deleteHunt(h.name).then(function (res) {
        if (res && res.ok === false) { $scope.huntRowError[h.name] = _failText(res); return; }
        $scope.huntDeleting = null;
        $scope.loadHunts();
      }, function (err) { $scope.huntRowError[h.name] = _failText(null, err); });
    };
    $scope.runHuntNow = function (h) {
      var key = "hunt:" + h.name;
      if ($scope.runStateFor(key) && $scope.runStateFor(key).state === "running") return;
      _setRunState(key, "running", "Starting...");
      fsrMonitorAgentService.runHuntNow(h.name).then(function (res) {
        if (res && res.ok === false) { _setRunState(key, "error", _failText(res)); return; }
        _setRunState(key, "ok", "Started");
        // A hunt is a full investigation: its outcome lands minutes later, on the next refresh.
        $timeout(function () { $scope.loadHunts(); }, 4000);
      }, function (err) { _setRunState(key, "error", _failText(null, err)); });
    };

    // ── Shift summary (X6) ────────────────────────────────────────────────
    // The connector computes every number from stored data and renders the same
    // digest as plain text. The view shows the numbers by section; copy and
    // export hand over that text unchanged.
    $scope.SHIFT_WINDOWS = [
      { hours: 8, label: "Last 8 hours" },
      { hours: 12, label: "Last 12 hours" },
      { hours: 24, label: "Last 24 hours" },
      { hours: 168, label: "Last 7 days" }
    ];
    $scope.shift = { hours: 8, state: "loading", digest: null, notice: "" };
    var _shiftSeq = 0;
    $scope.loadShift = function () {
      var seq = ++_shiftSeq;
      var sh = $scope.shift;
      _panelStart("shift");
      fsrMonitorAgentService.getShiftSummary({ hours: sh.hours }).then(function (res) {
        if (seq !== _shiftSeq) return;
        if (!res || res.ok === false || !res.handled) {
          sh.state = "failed";
          _panelFail("shift", null, "The shift summary could not be loaded.");
          return;
        }
        sh.digest = res;
        sh.state = "ready";
        _panelDone("shift");
      }, function (err) {
        if (seq !== _shiftSeq) return;
        sh.state = "failed";
        _panelFail("shift", err, "The shift summary could not be loaded.");
      });
    };
    $scope.shiftWindowChanged = function () { $scope.shift.notice = ""; $scope.loadShift(); };
    $scope.shiftText = function () { return ($scope.shift.digest && $scope.shift.digest.text) || ""; };
    $scope.shiftConfText = function (c) {
      return c && c.confidence != null ? Math.round(c.confidence * 100) + "%" : "-";
    };
    $scope.shiftHref = function (iri) { return $scope.recordHref({ record_iri: iri }); };
    function _copyFallback(text) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
    $scope.copyShift = function () {
      var text = $scope.shiftText();
      if (!text) return;
      function done(ok) {
        $scope.$applyAsync(function () { $scope.shift.notice = ok ? "Copied to the clipboard." : "Could not copy. Use Download instead."; });
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(_copyFallback(text)); });
          return;
        }
      } catch (e) { /* fall through to the fallback */ }
      done(_copyFallback(text));
    };
    $scope.exportShift = function () {
      var text = $scope.shiftText();
      if (!text) return;
      var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "shift-summary.txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      $timeout(function () { URL.revokeObjectURL(url); }, 1000);
      $scope.shift.notice = "Downloaded shift-summary.txt.";
    };

    // ── Audit export (X6) ─────────────────────────────────────────────────
    // The connector builds the file (and masks it when redaction is on); this
    // only asks for a window and format and hands the text over as a download.
    $scope.AUDIT_EXPORT_WINDOWS = [
      { hours: 24, label: "Last 24 hours" },
      { hours: 168, label: "Last 7 days" },
      { hours: 720, label: "Last 30 days" }
    ];
    $scope.AUDIT_EXPORT_FORMATS = [{ id: "csv", label: "CSV" }, { id: "json", label: "JSON" }];
    $scope.auditExport = { hours: 24, format: "csv", busy: false, notice: "", failed: false };
    $scope.exportAudit = function () {
      var ex = $scope.auditExport;
      if (ex.busy) return;
      var format = ex.format === "json" ? "json" : "csv";
      ex.busy = true; ex.notice = ""; ex.failed = false;
      fsrMonitorAgentService.exportAudit({ hours: ex.hours, format: format }).then(function (res) {
        ex.busy = false;
        var text = res && res.ok !== false ? res[format] : null;
        if (typeof text !== "string") {
          ex.failed = true;
          ex.notice = "The audit could not be exported.";
          return;
        }
        var name = ((res && res.file_stem) || "agent-audit") + "." + format;
        var blob = new Blob([text], { type: format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        $timeout(function () { URL.revokeObjectURL(url); }, 1000);
        var masked = res.redaction && res.redaction !== "off";
        ex.notice = "Downloaded " + name + (masked ? " (sensitive values masked)." : ".");
      }, function () {
        ex.busy = false; ex.failed = true;
        ex.notice = "The audit could not be exported.";
      });
    };

    $scope.refresh = function () {
      $scope.loadOverview(); $scope.loadKpis(); $scope.loadWouldHelp(); _loadPanelFor($scope.activeTab);
    };

    // Fetch the other tab bodies once the first paint is done, so opening a tab
    // renders at once instead of showing an empty panel while its partial
    // downloads (a reader, or a test, that looks right after the click would
    // otherwise see nothing).
    $timeout(function () {
      var req;
      try { req = $injector.get("$templateRequest"); } catch (e) { return; }
      ["tab-pending", "tab-sessions", "tab-users", "tab-scheduled", "tab-hunts", "tab-shift", "tab-autonomy", "autonomy-rules", "autonomy-tuning", "tab-audit", "tab-overview"]
        .forEach(function (n) { try { req($scope.tpl(n)); } catch (e) { /* the tab fetches it on open */ } });
    }, 0);

    // Initial load + auto-refresh. The queue is the default tab, so it loads now.
    $scope.loadOverview();
    $scope.loadKpis();
    $scope.loadQueue();
    $scope.loadWouldHelp();
    var _timer = $interval($scope.refresh, ($scope.config.refreshSecs || 60) * 1000);
    $scope.$on("$destroy", function () { $interval.cancel(_timer); });
  }
})();
