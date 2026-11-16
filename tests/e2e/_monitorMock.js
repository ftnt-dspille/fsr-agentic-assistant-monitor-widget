'use strict';
// Network-level connector mock for the agenticAssistantMonitor e2e specs.
//
// The widget's whole data path is `fsrMonitorAgentService` ->
// `connectorService.executeConnectorAction` -> POST
// /api/integration/execute/?format=json. Intercepting at THAT boundary (rather
// than stubbing the Angular service) keeps the real service, the real
// controller and the real template in the test -- only the box is faked. Every
// defect this suite covers lived in one of those three layers, so none of them
// may be mocked away.
//
// `installMonitorMock(page, {...})` routes:
//   GET  /api/integration/connectors/?search=assistant  -> one connector + a
//        default config, so _resolveConnector() succeeds.
//   POST /api/integration/execute/?format=json          -> dispatches on the
//        `operation` field of the posted body.
//
// It also records every dispatched call so specs can assert on the WIRE PARAMS
// a panel sent -- the only way to catch a filter that is displayed but never
// forwarded.
//
// Recording is kept NODE-SIDE (a WeakMap keyed by page), never via
// page.evaluate() inside the route handler: that is a re-entrant call into a
// page that is itself blocked waiting for the very route being handled. With
// three concurrent calls from the controller's $q.all it intermittently stalled
// the mount, and the widget sat on its loading spinner until the spec timed
// out. That produced two different random failures per run -- flake caused by
// the harness, not the widget.

const CONNECTOR_NAME = 'connector-fsr-agentic-assistant';

// Per-page wire-call log, held in the Node process (see header).
const RECORDED = new WeakMap();

// A fixed "now" for the widget so bucket maths is deterministic. The specs
// freeze Date in the page to this instant; fixtures below sit inside the
// default 7d window relative to it.
const NOW_ISO = '2026-07-28T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

const ADMIN_IRI = '/api/3/people/3451141c-bac6-467c-8d72-85e0fab569ce';

// Usage rows: two active days (07-26, 07-27) inside a 7d window whose other
// five days are silent. This is the exact shape that produced the "smooth
// week-long decline" -- the fixture must keep the gap, or the zero-fill
// assertions prove nothing.
const USAGE = [
  { ts: '2026-07-26T10:00:00Z', session_id: 's1', user_name: 'CS Admin', user_iri: ADMIN_IRI,
    model: 'gpt-4.1-mini', intent: 'triage', input_tokens: 1000, output_tokens: 200,
    cost_usd: 0.02, status: 'success', prompt: 'triage this alert',
    response: 'Benign -- known-good IP.', approvals_count: 0,
    tool_call_detail: [
      { index: 0, turn: 1, tool_name: 'get_record', params: { module: 'alerts', id: '42' },
        result_status: 'success', result_summary: 'alert 42 loaded', latency_ms: 120 },
      { index: 1, turn: 1, tool_name: 'run_op', params: null,
        result_status: 'error', result_summary: 'bad args', latency_ms: 50 },
    ] },
  { ts: '2026-07-27T11:00:00Z', session_id: 's1', user_name: 'CS Admin', user_iri: ADMIN_IRI,
    model: 'gpt-4.1-mini', intent: 'triage', input_tokens: 2000, output_tokens: 400,
    cost_usd: 0.03, status: 'success', prompt: 'hunt for related activity',
    response: 'Two related alerts.', approvals_count: 0, tool_call_detail: [] },
  // No user_iri -> rolls up under "(unknown)" and must NOT be drillable.
  { ts: '2026-07-27T14:00:00Z', session_id: 's2', model: 'gpt-4.1-mini', intent: 'build',
    input_tokens: 500, output_tokens: 100, cost_usd: 0.005, status: 'error',
    prompt: 'add error handling', response: '', approvals_count: 1, tool_call_detail: [] },
];

// Only the days that HAVE rows, exactly like storage.usage_summary.
const SUMMARY_DAY = [
  { bucket: '2026-07-26', value: 0.02 },
  { bucket: '2026-07-27', value: 0.035 },
];
const SUMMARY_HOUR = [{ bucket: '2026-07-28T10:00:00', value: 0.005 }];

const SESSIONS = [
  { session_id: 'sess-live-1', status: 'active', user: { name: 'CS Admin', iri: ADMIN_IRI },
    record_module: 'alerts', record_uuid: 'u1', current_prompt: 'triage this alert',
    turn_count: 3, last_activity: NOW_MS / 1000 - 120 },
  { session_id: 'sess-wait-1', status: 'waiting_approval', user: { name: 'CS Admin', iri: ADMIN_IRI },
    record_module: 'alerts', record_uuid: 'u2', current_prompt: 'block that IP',
    turn_count: 2, last_activity: NOW_MS / 1000 - 600 },
  { session_id: 'sess-idle-1', status: 'idle', user: null, record_module: null,
    record_uuid: null, current_prompt: '', turn_count: 1, last_activity: NOW_MS / 1000 - 90000 },
];

const PENDING = [
  { approval_id: 'apr-1', card_id: 'apr-1', session_id: 'sess-wait-1', parked_at: NOW_MS / 1000 - 5400,
    intent: 'triage', age_seconds: 5400, user: { name: 'CS Admin', iri: ADMIN_IRI },
    record_module: 'alerts', record_uuid: 'u2',
    card: { type: 'action_card', tool: 'update_record', summary: 'Update the template description',
            target: { module: 'ztpf_templates', uuid: 't1', name: 'Create Next Test Loopback Interface' },
            changes: [{ field: 'description', before: 'Loopback helper', after: 'Creates the next free loopback' }],
            batch_count: 0 } },
];

// An auto-triaged record that needs a human, and the action it proposed
// (listed in `pending` like any approval, in the same session). Served only
// by specs that opt in with `withEscalation` -- the default queue stays the
// one approval the older specs count.
const ESCALATION = {
  session_id: 'auto:alerts:u9', card_id: 'esc_u9', priority: 'P1', priority_rank: 1,
  created_at: NOW_MS / 1000 - 7200, age_seconds: 7200,
  record: { name: 'Outbound beacon to 198.51.100.7', module: 'alerts', uuid: 'u9', severity: 'High' },
  verdict: { disposition: 'true_positive', severity: 'critical', confidence: 0.92,
             summary: 'Known command-and-control address.' },
  reasons: ['1 action waiting for approval.'], approvals: 1,
};
const ESCALATED_ACTION = {
  approval_id: 'apr-9', card_id: 'apr-9', session_id: 'auto:alerts:u9', parked_at: NOW_MS / 1000 - 7100,
  intent: 'triage', age_seconds: 7100, user: { name: 'Auto-triage', iri: 'system:auto-triage' },
  record_module: 'alerts', record_uuid: 'u9',
  card: { type: 'action_card', tool: 'run_op', title: 'Block 198.51.100.7 on FortiGate',
          target: { module: 'alerts', uuid: 'u9', name: 'Outbound beacon to 198.51.100.7' } },
};

/** A `handle` that adds ESCALATION (and its action) to the queue. */
function withEscalation(op, params, base) {
  if (op === 'list_pending') return { pending: PENDING.concat([ESCALATED_ACTION]), escalations: [ESCALATION] };
  if (op === 'resolve_escalation') return { ok: true, session_id: params.session_id,
                                            card_id: params.card_id, outcome: params.outcome };
  return base(op, params);
}

const SCHEDULED = [
  { name: 'Daily alert review', cron: '0 9 * * 1', intent: 'triage', last_run_at: null,
    total_run_count: 0, schedule_enabled: true },
];

// Apply the filters the widget claims to send. A mock that ignores them would
// let a dropped-filter regression pass, which is exactly the bug being fixed.
function filterSessions(params) {
  let out = SESSIONS.slice();
  if (params.status) out = out.filter((s) => s.status === params.status);
  if (params.user_iri) out = out.filter((s) => (s.user || {}).iri === params.user_iri);
  return out.slice(0, params.limit || 50);
}
function filterUsage(params) {
  let out = USAGE.slice();
  if (params.status) out = out.filter((u) => u.status === params.status);
  if (params.user_iri) out = out.filter((u) => u.user_iri === params.user_iri);
  if (params.intent) out = out.filter((u) => u.intent === params.intent);
  if (params.model) out = out.filter((u) => u.model === params.model);
  return out.slice(0, params.limit || 200);
}


// ── Handled-cases queue (monitor_cases / monitor_feedback) ───────────────
// One row per auto-triaged case, as the connector returns them. Ages are
// seconds before NOW. H4 is older than a day, so it only appears when the
// window is widened: that is how a spec proves `hours` reaches the wire.
const _iri = (module, id) => `/api/3/${module}/${id}`;
const CASES = [
  { key: 'H1', bucket: 'handled', record_iri: _iri('alerts', 'a1000000-0000-4000-8000-000000000001'),
    record_module: 'alerts', record_name: 'Outbound beacon to 198.51.100.7',
    session_id: 'auto:alerts:a1', verdict: 'True positive', confidence: 0.92,
    sources: ['FortiSIEM', 'FortiEDR', 'Threat intelligence'], action: 'Blocked the address',
    action_kind: 'taken', action_card_id: 'card-a1', undoable: true,
    reasons: ['The address is on a known command-and-control list.', 'FortiEDR saw the same host contact it.'],
    age: 300, group_size: 1, rule_id: 'block-external-ip', others: { right: 0, wrong: 0 }, seedMine: null },
  { key: 'H2', bucket: 'handled', record_iri: _iri('alerts', 'a2000000-0000-4000-8000-000000000002'),
    record_module: 'alerts', record_name: 'Login burst from 203.0.113.9',
    session_id: 'auto:alerts:a2', verdict: 'Benign', confidence: 0.88,
    sources: ['FortiSIEM', 'Earlier cases'], action: 'Closed the record',
    action_kind: 'taken', action_card_id: 'card-a2', undoable: false,
    reasons: ['Four earlier cases from this address were benign.'],
    age: 7200, group_size: 4, rule_id: 'close-benign', others: { right: 1, wrong: 0 }, seedMine: null },
  { key: 'H3', bucket: 'handled', record_iri: _iri('alerts', 'a3000000-0000-4000-8000-000000000003'),
    record_module: 'alerts', record_name: 'New CDN host',
    session_id: 'auto:alerts:a3', verdict: 'Benign', confidence: 0.81,
    sources: ['Threat intelligence', 'The record'], action: 'Would have closed the record',
    action_kind: 'would_have', action_card_id: null, undoable: false,
    reasons: [], age: 10800, group_size: 1, rule_id: 'close-benign',
    others: { right: 1, wrong: 0 }, seedMine: 'right', seedNote: 'Matches what I saw.' },
  { key: 'H4', bucket: 'handled', record_iri: _iri('alerts', 'a4000000-0000-4000-8000-000000000004'),
    record_module: 'alerts', record_name: 'Nightly backup warning',
    session_id: 'auto:alerts:a4', verdict: 'Benign', confidence: 0.95,
    sources: ['The record'], action: 'Closed the record', action_kind: 'taken',
    action_card_id: 'card-a4', undoable: false, reasons: ['It is the scheduled backup window.'],
    age: 108000, group_size: 1, rule_id: 'close-benign', others: { right: 0, wrong: 0 }, seedMine: null },
  { key: 'N1', bucket: 'needs_you', record_iri: _iri('alerts', 'b1000000-0000-4000-8000-000000000011'),
    record_module: 'alerts', record_name: 'Phish report from finance',
    session_id: 'auto:alerts:b1', verdict: 'Needs more info', confidence: null,
    sources: ['The record'], action: 'Sent to you', action_kind: 'escalated',
    action_card_id: null, undoable: false, reasons: ['The mail gateway was not checked.'],
    age: 600, group_size: 1, rule_id: null, others: { right: 0, wrong: 0 }, seedMine: null },
  { key: 'N2', bucket: 'needs_you', record_iri: _iri('alerts', 'b2000000-0000-4000-8000-000000000012'),
    record_module: 'alerts', record_name: 'Impossible travel for jdoe',
    session_id: 'auto:alerts:b2', verdict: 'False positive', confidence: 0.67,
    sources: ['FortiSIEM'], action: 'No action taken', action_kind: 'none',
    action_card_id: null, undoable: false, reasons: ['Confidence is below the closing threshold.'],
    age: 1800, group_size: 1, rule_id: null, others: { right: 0, wrong: 0 }, seedMine: null },
  { key: 'R1', bucket: 'reopened', record_iri: _iri('alerts', 'c1000000-0000-4000-8000-000000000021'),
    record_module: 'alerts', record_name: 'Odd PowerShell on host fin-07',
    session_id: 'auto:alerts:c1', verdict: 'Benign', confidence: 0.79,
    sources: ['FortiEDR'], action: 'Closed the record', action_kind: 'taken',
    action_card_id: 'card-c1', undoable: false, reasons: ['The script is a known admin tool.'],
    age: 14400, group_size: 1, rule_id: 'close-benign', others: { right: 0, wrong: 1 }, seedMine: null },
];
// Ratings by other analysts before the window: 25 right and 2 wrong in total,
// seeded so the agreement tile reads "93% (27 rated)" until the test rates.
const BASE_RATED = { right: 22, wrong: 1 }; // plus the per-row `others` and seeds
let MINE = {};      // record_iri -> { mine, note }
let FEEDBACK_FAIL = null; // null, or the error code the next writes return

function _resetCases() {
  MINE = {};
  CASES.forEach((c) => { if (c.seedMine) MINE[c.record_iri] = { mine: c.seedMine, note: c.seedNote || '' }; });
  CASES.forEach((c) => { if (!c.others0) c.others0 = { ...c.others }; c.others = { ...c.others0 }; });
  FEEDBACK_FAIL = null;
}
/** Make monitor_feedback fail with this error code (null restores it). */
function failFeedback(code) { FEEDBACK_FAIL = code; }

function _fb(c) {
  const m = MINE[c.record_iri] || { mine: null, note: '' };
  return { mine: m.mine, note: m.note,
           right: c.others.right + (m.mine === 'right' ? 1 : 0),
           wrong: c.others.wrong + (m.mine === 'wrong' ? 1 : 0) };
}
function _inWindow(hours) { return CASES.filter((c) => c.age <= hours * 3600); }
function _caseRow(c) {
  const { key, others, others0, seedMine, seedNote, age, ...wire } = c;
  return { ...wire, at: NOW_MS / 1000 - age, feedback: _fb(c) };
}
// ── Policy readiness and tuning views (monitor_cases view=policy / tuning) ──
// The connector computes ready / safe_to_tune; the mock serves its answers
// verbatim, one ready rule and two that are not, so the widget has to DISPLAY
// the verdict rather than derive it. Rule ids match the CASES rows above, so
// the decision drawer has real rows to pick out (and one rule with none).
const POLICY_THRESHOLDS = { min_sample: 20, min_agreement: 0.95, max_reopen_rate: 0.05 };
const POLICY_RULES = [
  { rule_id: 'close-benign', label: 'Close benign alerts', ready: true, sample: 24, agreement: 0.96,
    reopen_rate: 0, blockers: [],
    inputs: { approved: 23, rejected: 1, right: 22, wrong: 1, acted: 24, reopened: 0 },
    thresholds: POLICY_THRESHOLDS },
  { rule_id: 'block-external-ip', label: 'Block external addresses', ready: false, sample: 7, agreement: 0.86,
    reopen_rate: 0.14, blockers: ['Only 7 decisions so far; at least 20 are needed.',
      'Reviewers agreed 86% of the time; at least 95% is needed.',
      '14% of its closes were reopened; at most 5% is allowed.'],
    inputs: { approved: 6, rejected: 1, right: 6, wrong: 1, acted: 7, reopened: 1 },
    thresholds: POLICY_THRESHOLDS },
  { rule_id: 'quarantine-host', label: 'Quarantine infected hosts', ready: false, sample: 0, agreement: null,
    reopen_rate: null, blockers: ['This rule has not made a decision yet.'],
    inputs: { approved: 0, rejected: 0, right: 0, wrong: 0, acted: 0, reopened: 0 },
    thresholds: POLICY_THRESHOLDS },
];
const TUNING_THRESHOLDS = { min_closes: 5, max_reopen_rate: 0.1 };
const TUNING_RULES = [
  { source: 'FortiSIEM', rule: 'Port scan from scanner subnet', last_at: 1785000000, count: 12, reopened: 0,
    reopen_rate: 0, safe_to_tune: true, note: 'Closed 12 times and never reopened, so it is safe to tune.' },
  { source: 'FortiEDR', rule: 'Suspicious Process', last_at: 1784990000, count: 6, reopened: 2,
    reopen_rate: 0.33, safe_to_tune: false, note: 'A third of its closes were reopened, so keep watching.' },
  { source: '', rule: '', last_at: 1784980000, count: 2, reopened: 0, reopen_rate: 0,
    safe_to_tune: false, note: 'Only 2 closes so far; at least 5 are needed.' },
];

// What the connector answers for the would-help view: three sources ranked by
// the uncertain cases each would have helped. Served verbatim, so the panel has
// to DISPLAY the ranking, not derive it.
const WOULD_HELP = { uncertain: 9, with_help: 8, items: [
  { kind: 'tickets', state: 'not_connected', label: 'Ticket system',
    problem: 'Ticket system is not connected', cases: 7 },
  { kind: 'source_failed', state: 'failed', label: 'FortiSIEM',
    problem: 'FortiSIEM returned an error', cases: 2 },
  { kind: 'data_gap', state: 'no_data', label: 'FortiAnalyzer',
    problem: 'FortiAnalyzer was searched and returned nothing', cases: 1 },
] };

function monitorCases(params) {
  const hours = params.hours || 24;
  const view = params.view || 'list';
  const win = _inWindow(hours);
  if (view === 'would_help') {
    return { ok: true, view: 'would_help', hours, ...WOULD_HELP };
  }
  if (view === 'policy') {
    return { ok: true, view: 'policy', hours: params.hours || 336, mode: 'shadow',
             thresholds: POLICY_THRESHOLDS, rules: POLICY_RULES };
  }
  if (view === 'tuning') {
    return { ok: true, view: 'tuning', hours: params.hours || 336, thresholds: TUNING_THRESHOLDS,
             rules: TUNING_RULES };
  }
  if (view === 'kpis') {
    // right/wrong across the window: the fixed history plus this window's rows.
    let right = BASE_RATED.right, wrong = BASE_RATED.wrong;
    CASES.forEach((c) => {
      const f = _fb(c); right += f.right; wrong += f.wrong;
    });
    const rated = right + wrong;
    return { ok: true, view: 'kpis', hours, kpis: {
      handled: win.filter((c) => c.bucket === 'handled').length,
      auto_closed: win.filter((c) => c.action_kind === 'taken' && /^Closed/.test(c.action)).length,
      escalated: win.filter((c) => c.action_kind === 'escalated').length,
      needs_you: win.filter((c) => c.bucket === 'needs_you').length,
      reopened: win.filter((c) => c.bucket === 'reopened').length,
      rated, right, wrong, agreement: rated ? right / rated : null, deferred: 0,
      cost_today_usd: 0.84 } };
  }
  const bucket = params.bucket || 'all';
  const rows = win.filter((c) => bucket === 'all' || c.bucket === bucket).sort((a, b) => a.age - b.age);
  return { ok: true, view: 'list', hours, bucket, total: rows.length,
    counts: { handled: win.filter((c) => c.bucket === 'handled').length,
              needs_you: win.filter((c) => c.bucket === 'needs_you').length,
              reopened: win.filter((c) => c.bucket === 'reopened').length },
    rows: rows.slice(0, params.limit || 50).map(_caseRow) };
}
function monitorFeedback(params) {
  if (FEEDBACK_FAIL) return { ok: false, error: { code: FEEDBACK_FAIL, message: FEEDBACK_FAIL } };
  const c = CASES.find((x) => x.record_iri === params.record);
  if (!c) return { ok: false, error: { code: 'not_found', message: 'not found' } };
  if (!['right', 'wrong', ''].includes(params.rating)) return { ok: false, error: { code: 'bad_rating', message: 'bad rating' } };
  // A colleague rated the lead case wrong at the same moment: the read-back
  // must carry their rating, which an optimistic count cannot know.
  if (c.key === 'H1' && params.rating === 'wrong') c.others = { right: 0, wrong: 1 };
  const prevNote = (MINE[c.record_iri] || {}).note || '';
  MINE[c.record_iri] = { mine: params.rating || null, note: params.note != null ? params.note : (params.rating ? prevNote : '') };
  return { ok: true, record: c.record_iri, session_id: c.session_id, feedback: _fb(c) };
}


// Scheduled hunts: what the connector answers for list_hunts (the schedule is
// already in words, the outcome already named; served verbatim).
const HUNTS = [
  { name: 'c2-sweep', question: 'Any host talking to a known command-and-control address in the last hour',
    cron: '0 * * * *', timezone: 'UTC', schedule_label: 'Every hour', module: 'alerts', enabled: true,
    case_iri: _iri('alerts', 'f1000000-0000-4000-8000-000000000001'),
    last_run_at: NOW_MS / 1000 - 1800, last_outcome: 'finding', last_outcome_label: 'Found something',
    last_summary: 'Host h1 beaconed to a known command-and-control address.', runs: [] },
  { name: 'dns-tunnel', question: 'Unusually long DNS queries from one host overnight',
    cron: '0 6 * * *', timezone: 'UTC', schedule_label: 'Every day at 06:00 UTC', module: 'incidents', enabled: false,
    case_iri: null, last_run_at: NOW_MS / 1000 - 86400, last_outcome: 'quiet', last_outcome_label: 'Quiet run',
    last_summary: 'Searched the DNS logs and found nothing unusual.', runs: [] },
  { name: 'new-hunt', question: 'Never run yet', cron: '15 3 1 * *', timezone: 'UTC',
    schedule_label: 'Custom schedule', module: 'alerts', enabled: true, case_iri: null,
    last_run_at: null, last_outcome: null, last_outcome_label: null, last_summary: null, runs: [] },
];

// The shift digest the connector computes (served verbatim): the numbers the
// view shows and the same digest as plain text for copy and export.
const SHIFT_TEXT = 'Shift summary: window\n\nWhat the assistant handled\n- Triaged 6 cases: 3 handled, 2 closed for you, 1 sent to you.\n';
// export_audit answers with the content as strings plus the redaction mode.
const AUDIT_CSV = 'at,kind,session_id,actor,name,status,detail\n2026-01-01T00:00:00Z,turn,auto:alerts:a1,analyst,triage,success,"{}"\n';
function exportAudit(params) {
  const format = params.format || 'both';
  const data = { from: 'f', to: 't', redaction: 'off', sessions: [], turns: [{ session_id: 'auto:alerts:a1' }], tool_calls: [], decisions: [], notifications: [] };
  const out = { ok: true, redaction: 'off', file_stem: 'agent-audit-test', counts: { sessions: 0, turns: 1, tool_calls: 0, decisions: 0, notifications: 0 } };
  if (format !== 'csv') out.json = JSON.stringify(data, null, 2);
  if (format !== 'json') out.csv = AUDIT_CSV;
  return out;
}
function shiftSummary(params) {
  const hours = params.hours || 8;
  return { ok: true, hours, subject: 'Shift summary: window', text: SHIFT_TEXT + '- Window: ' + hours + ' hours.\n',
    handled: { triaged: 6, closed: 2, handled: 3, sent_to_you: 1, grouped: 2, deferred: 1, would_have_acted: 1, reopened: 0 },
    waiting: { total: 3, cases: [
      { record_name: 'Phish report', record_iri: _iri('alerts', 'f2000000-0000-4000-8000-000000000002'), priority: 'P2',
        reasons: ['The verdict needs review: needs more information.'] },
      { record_name: 'Odd login', record_iri: _iri('alerts', 'f3000000-0000-4000-8000-000000000003'), priority: null, reasons: [] }] },
    notable: { total: 2, cases: [
      { record_name: 'Outbound C2', record_iri: _iri('alerts', 'f4000000-0000-4000-8000-000000000004'), verdict: 'True positive', confidence: 0.92 },
      { record_name: 'Odd login', record_iri: _iri('alerts', 'f3000000-0000-4000-8000-000000000003'), verdict: 'Suspicious', confidence: 0.6 }] },
    would_help: { uncertain: 1, with_help: 1, items: [
      { label: 'FortiSIEM', problem: 'FortiSIEM returned an error', cases: 1 }] },
    hunts: { runs: 7, findings: 2, quiet: 3, inconclusive: 1, failed: 1, cases: [
      { hunt: 'c2-sweep', summary: 'Host h1 beaconed to a known command-and-control address.',
        case_iri: _iri('alerts', 'f1000000-0000-4000-8000-000000000001') }] } };
}

function handle(operation, params) {
  switch (operation) {
    case 'list_usage':          return { usage: filterUsage(params) };
    case 'get_usage_summary': {
      // Metric-aware: cost is the base series; turns/tokens are distinct
      // scalings so a tile sourced from the wrong metric is visible.
      const base = params.bucket === 'hour' ? SUMMARY_HOUR : SUMMARY_DAY;
      const scale = params.metric === 'turns' ? 100 : params.metric === 'tokens' ? 10000 : 1;
      return { summary: base.map((b) => ({ bucket: b.bucket, value: Math.round(b.value * scale * 1e6) / 1e6 })) };
    }
    case 'list_pending':        return { pending: PENDING };
    case 'monitor_cases':       return monitorCases(params);
    case 'monitor_feedback':    return monitorFeedback(params);
    case 'undo_action':         return { ok: true };
    case 'get_audit_trail':     return { usage: filterUsage(params) };
    case 'list_active_sessions':return { sessions: filterSessions(params) };
    case 'list_scheduled_tasks':return { tasks: SCHEDULED };
    case 'run_scheduled_task_now': return { ok: true };
    case 'list_hunts':          return { ok: true, hunts: HUNTS };
    case 'save_hunt':           return { ok: true, name: params.name };
    case 'delete_hunt':         return { ok: true, name: params.name, deleted: true };
    case 'run_hunt':            return { ok: true, name: params.name, triggered: true };
    case 'shift_summary':       return shiftSummary(params);
    case 'export_audit':        return exportAudit(params);
    case 'chat_resume':         return { ok: true, stop_reason: 'end_turn', transcript: [] };
    default: return {};
  }
}

/**
 * Install the connector mock + freeze the page clock. Call BEFORE mounting.
 * @param {import('@playwright/test').Page} page
 */
async function installMonitorMock(page, opts = {}) {
  RECORDED.set(page, []);
  _resetCases();
  // Freeze Date so bucket ranges (and therefore label text and vertex counts)
  // are stable regardless of when CI runs.
  await page.addInitScript((nowMs) => {
    const RealDate = Date;
    function FrozenDate(...args) {
      if (args.length === 0) return new RealDate(nowMs);
      return new RealDate(...args);
    }
    FrozenDate.prototype = RealDate.prototype;
    FrozenDate.now = () => nowMs;
    FrozenDate.parse = RealDate.parse;
    FrozenDate.UTC = RealDate.UTC;
    window.Date = FrozenDate;
  }, NOW_MS);

  await page.route('**/api/integration/connectors/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{
          name: CONNECTOR_NAME,
          version: '0.5.51',
          configuration: [{ config_id: 'cfg-default', name: 'fsrpb-41mini', default: true }],
        }],
      }),
    });
  });

  await page.route('**/api/integration/execute/**', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) { /* empty */ }
    const operation = body.operation;
    const params = body.params || {};
    // Record Node-side. Never page.evaluate() here -- see the header note.
    (RECORDED.get(page) || []).push({ operation, params });
    const data = opts.handle ? opts.handle(operation, params, handle) : handle(operation, params);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'Success', data }),
    });
  });
}

/** Wire calls recorded so far, newest last. Async so specs read uniformly. */
async function calls(page, operation) {
  const all = RECORDED.get(page) || [];
  return operation ? all.filter((c) => c.operation === operation) : all.slice();
}
/** The most recent call for an operation, or undefined. */
async function lastCall(page, operation) {
  const list = await calls(page, operation);
  return list[list.length - 1];
}

module.exports = {
  installMonitorMock, calls, lastCall,
  CONNECTOR_NAME, NOW_ISO, NOW_MS, ADMIN_IRI,
  USAGE, SUMMARY_DAY, SESSIONS, PENDING, SCHEDULED, HUNTS, SHIFT_TEXT, shiftSummary, AUDIT_CSV,
  ESCALATION, ESCALATED_ACTION, withEscalation,
  CASES, failFeedback, WOULD_HELP, POLICY_RULES, POLICY_THRESHOLDS, TUNING_RULES, TUNING_THRESHOLDS,
};
