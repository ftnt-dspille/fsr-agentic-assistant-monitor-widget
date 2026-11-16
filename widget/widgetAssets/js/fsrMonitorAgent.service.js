/* Copyright start
   MIT License
   Copyright (c) 2026 Fortinet Inc
   Copyright end */
'use strict';
// Lean connector bridge for the Agentic Assistant Monitor widget -- resolves the
// fsr-agentic-assistant connector + dispatches its monitoring ops. Mirrors the
// chat widget's fsrPbAgent.service dispatch (connectorService.executeConnectorAction)
// but exposes only the read-side ops the dashboard needs.
(function () {
    angular
        .module('cybersponse')
        .factory('fsrMonitorAgentService', fsrMonitorAgentService);

    fsrMonitorAgentService.$inject = ['$q', '$http', '$injector'];

    // Detect stale connector-resolution errors (404, connector-not-found,
    // config-not-found). These can occur mid-session if the connector is
    // redeployed, renamed, or its config changes. A stale-resolution error
    // may self-heal with a retry; other errors should surface as-is.
    function _isStaleResolutionError(err) {
        if (!err) return false;
        if (err.status === 404) return true;
        var msg = (err.data && (err.data.message
                    || (err.data.error && (err.data.error.message || err.data.error.code))))
               || err.message || '';
        return /unknown connector|connector (?:was )?not (?:found|installed|configured)|no such connector|configuration.*not (?:found|exist)|invalid config/i
            .test(String(msg));
    }

    function fsrMonitorAgentService($q, $http, $injector) {
        var CONNECTOR_NAME = 'connector-fsr-agentic-assistant';
        var CONNECTOR_SEARCH = 'assistant';
        var _resolved = null;

        function _resolveConnector() {
            if (_resolved) return _resolved;
            _resolved = $http.get('/api/integration/connectors/?search=' + CONNECTOR_SEARCH)
                .then(function (resp) {
                    var list = (resp.data && resp.data.data) || [];
                    var rec = list.filter(function (c) { return c.name === CONNECTOR_NAME; })[0];
                    if (!rec) {
                        return $q.reject({ code: 'connector_not_installed',
                            message: 'Connector "' + CONNECTOR_NAME + '" is not installed.' });
                    }
                    var cfgs = (rec.configuration || []).map(function (c) {
                        return { config_id: c.config_id, name: c.name, default: !!c.default };
                    });
                    var chosen = (cfgs.filter(function (c) { return c.default; })[0]) || cfgs[0];
                    if (!chosen) {
                        return $q.reject({ code: 'no_config',
                            message: 'Connector has no configuration.' });
                    }
                    return { name: CONNECTOR_NAME, version: rec.version, configId: chosen.config_id };
                }, function (err) {
                    return $q.reject({ code: 'connector_lookup_failed',
                        message: 'Could not query connectors (HTTP ' + (err && err.status) + ').' });
                });
            _resolved.catch(function () { _resolved = null; });
            return _resolved;
        }

        function _unwrap(resp) {
            if (resp && resp.data != null && typeof resp.status === 'string') return resp.data;
            return resp;
        }

        // Dispatch to the live connector through the cached resolution, with ONE
        // self-heal retry: if the call fails with a stale-resolution error, drop
        // `_resolved` and re-resolve once. A second failure or a non-stale error
        // surfaces to the caller unchanged.
        function _dispatch(action, payload, _retried) {
            var connectorService = $injector.get('connectorService');
            return _resolveConnector().then(function (res) {
                return connectorService.executeConnectorAction(res.name, res.version, action, res.configId, payload);
            }).then(_unwrap, function (err) {
                if (!_retried && _isStaleResolutionError(err)) {
                    _resolved = null;
                    return _dispatch(action, payload, true);
                }
                return $q.reject(err);
            });
        }

        return {
            connectorName: CONNECTOR_NAME,
            listUsage: function (filters) { return _dispatch('list_usage', filters || {}); },
            getUsageSummary: function (params) { return _dispatch('get_usage_summary', params || {}); },
            listPending: function () { return _dispatch('list_pending', {}); },
            // The autonomy policy's shadow table: what each rule would have done,
            // next to what the reviewer decided. Read-only; nothing is enforced.
            listShadowDecisions: function (params) { return _dispatch('list_shadow_decisions', params || {}); },
            // Read the full autonomy policy document (fresh) for the editor.
            getAutonomyPolicy: function () { return _dispatch('get_autonomy_policy', {}); },
            // Validate + save the autonomy policy. Reviewer-role gated and
            // validated connector-side; refuses an invalid policy without writing.
            setAutonomyPolicy: function (policy) { return _dispatch('set_autonomy_policy', { policy: policy }); },
            // Answer a pending approval from the queue, the same chat_resume the
            // chat drawer sends. The connector claims each card once, so a card
            // already answered in the chat comes back as `already_decided`.
            decidePending: function (payload) { return _dispatch('chat_resume', payload || {}); },
            // Take an auto-triage escalation off the queue (handled / dismissed),
            // decided once like an approval.
            resolveEscalation: function (payload) { return _dispatch('resolve_escalation', payload || {}); },
            // The handled-cases queue and its outcome KPIs (view: list | kpis).
            listCases: function (params) { return _dispatch('monitor_cases', params || {}); },
            // Right / wrong feedback on one decision, read back by the connector.
            submitFeedback: function (payload) { return _dispatch('monitor_feedback', payload || {}); },
            undoAction: function (payload) { return _dispatch('undo_action', payload || {}); },
            getAuditTrail: function (filters) { return _dispatch('get_audit_trail', filters || {}); },
            listScheduledTasks: function () { return _dispatch('list_scheduled_tasks', {}); },
            runScheduledTaskNow: function (name) { return _dispatch('run_scheduled_task_now', { name: name }); },
            // Scheduled hunts: saved questions the assistant runs on FortiSOAR's scheduler.
            listHunts: function () { return _dispatch('list_hunts', {}); },
            // Create or edit; an omitted field keeps its stored value, enabled false pauses.
            saveHunt: function (hunt) { return _dispatch('save_hunt', hunt || {}); },
            deleteHunt: function (name) { return _dispatch('delete_hunt', { name: name }); },
            // Ask the scheduler to fire the hunt now (it runs unattended, in the background).
            runHuntNow: function (name) { return _dispatch('run_hunt', { name: name, trigger: true }); },
            // The end-of-shift digest for the last `hours` (numbers from stored data, plus its text).
            getShiftSummary: function (params) { return _dispatch('shift_summary', params || {}); },
            // The agent audit for the last `hours` as csv or json text (redaction mode applied by the connector).
            exportAudit: function (params) { return _dispatch('export_audit', params || {}); },
            // Accepts the panel's filters (status / user_iri) alongside limit;
            // the controller projects them via _panelFilters('sessions').
            listActiveSessions: function (params) { return _dispatch('list_active_sessions', params || {}); }
        };
    }

    // Test seam only. The widget ships as a plain script, so `module` is
    // undefined in the browser and this is skipped. Jest reads the real
    // detector from here (same guard as fsrPbRender.js).
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { isStaleResolutionError: _isStaleResolutionError };
    }
})();
