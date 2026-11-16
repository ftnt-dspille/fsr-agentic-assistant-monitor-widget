'use strict';
// Monitor retry logic: generic failures are not retried, stale-resolution
// errors are (the service retries once). Runs the REAL detector from
// fsrMonitorAgent.service.js, so a change to the service's regex or its
// status check fails here. (It used to be a copy, which could never fail.)

require('angular');
require('angular-mocks');
angular.module('cybersponse', []); // eslint-disable-line no-undef
const { isStaleResolutionError: _isStaleResolutionError } =
  require('../widget/widgetAssets/js/fsrMonitorAgent.service.js');

describe('Monitor _isStaleResolutionError detection', function () {
    test('detects 404 as stale-resolution error', function () {
        var err = { status: 404 };
        expect(_isStaleResolutionError(err)).toBe(true);
    });

    test('detects "connector was not found" as stale-resolution error', function () {
        var err = { status: 500, data: { message: 'Connector was not found' } };
        expect(_isStaleResolutionError(err)).toBe(true);
    });

    test('detects "connector not configured" as stale-resolution error', function () {
        var err = { status: 500, data: { message: 'Connector not configured' } };
        expect(_isStaleResolutionError(err)).toBe(true);
    });

    test('detects "configuration not found" as stale-resolution error', function () {
        var err = { status: 500, data: { message: 'The configuration was not found' } };
        expect(_isStaleResolutionError(err)).toBe(true);
    });

    test('does not detect generic 500 error as stale-resolution', function () {
        var err = { status: 500, data: { message: 'Internal server error' } };
        expect(_isStaleResolutionError(err)).toBe(false);
    });

    test('does not detect timeout as stale-resolution error', function () {
        var err = { status: 408, data: { message: 'Request timeout' } };
        expect(_isStaleResolutionError(err)).toBe(false);
    });

    test('handles null/undefined error gracefully', function () {
        expect(_isStaleResolutionError(null)).toBe(false);
        expect(_isStaleResolutionError(undefined)).toBe(false);
    });
});
