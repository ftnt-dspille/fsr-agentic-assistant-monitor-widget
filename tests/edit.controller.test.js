'use strict';
// The dashboard opens the settings form with $uibModal and passes `config` and
// `$uibModalInstance` as controller LOCALS. The controller once fetched them
// with $injector.get(), which throws in the real modal, so Save did nothing.
// Built here with locals only (no global providers) to match the platform.

global.jasmine = global.jasmine || {};
require('angular');
require('angular-mocks');
angular.module('cybersponse', []); // eslint-disable-line no-undef
require('../widget/edit.controller.js');

const widgetInfo = require('../widget/info.json');
const editCtrlName =
  'edit' + widgetInfo.name.charAt(0).toUpperCase() + widgetInfo.name.slice(1) +
  widgetInfo.version.replace(/\./g, '') + 'DevCtrl';
const ng = window.angular; // eslint-disable-line no-undef

function openModal(config) {
  let $controller, $rootScope;
  ng.mock.module('cybersponse');
  ng.mock.inject((_$controller_, _$rootScope_) => {
    $controller = _$controller_; $rootScope = _$rootScope_;
  });
  const $scope = $rootScope.$new();
  const modal = { close: jest.fn(), dismiss: jest.fn() };
  $controller(editCtrlName, { $scope, $uibModalInstance: modal, config });
  return { $scope, modal };
}

describe('Monitor settings modal', () => {
  test('a new widget gets the defaults', () => {
    const { $scope } = openModal({});
    expect($scope.config).toMatchObject({ title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 60 });
  });

  test('a saved config is loaded, not replaced by defaults', () => {
    const { $scope } = openModal({ title: 'Tier 1', range: '24h', refreshSecs: 30, wid: 'w1' });
    expect($scope.config).toEqual({ title: 'Tier 1', range: '24h', refreshSecs: 30, wid: 'w1' });
  });

  test('Save closes the modal with the edited config', () => {
    const { $scope, modal } = openModal({ wid: 'w1' });
    $scope.config.range = '30d';
    $scope.save();
    expect(modal.close).toHaveBeenCalledTimes(1);
    expect(modal.close.mock.calls[0][0]).toEqual({ title: 'Agentic Assistant Monitor', range: '30d', refreshSecs: 60, wid: 'w1' });
  });

  test('Close dismisses without saving', () => {
    const { $scope, modal } = openModal({});
    $scope.cancel();
    expect(modal.dismiss).toHaveBeenCalledWith('cancel');
    expect(modal.close).not.toHaveBeenCalled();
  });
});
