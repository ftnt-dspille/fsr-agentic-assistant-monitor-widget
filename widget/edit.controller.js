/* Copyright start
   MIT License
   Copyright (c) 2026 Fortinet Inc
   Copyright end */
'use strict';
(function () {
  angular
    .module('cybersponse')
    .controller('editAgenticAssistantMonitor115DevCtrl', editAgenticAssistantMonitor115DevCtrl);

  // The dashboard opens this form with $uibModal and passes `config` and
  // `$uibModalInstance` as controller LOCALS. They are not injector services,
  // so $injector.get() throws for both and Save silently does nothing; they
  // must be listed in $inject. (KNOWLEDGEBASE.md 5.2)
  editAgenticAssistantMonitor115DevCtrl.$inject = ['$scope', '$uibModalInstance', 'config'];

  function editAgenticAssistantMonitor115DevCtrl($scope, $uibModalInstance, config) {
    var defaults = { title: 'Agentic Assistant Monitor', range: '7d', refreshSecs: 60 };
    $scope.config = angular.extend({}, defaults, config || {});

    $scope.save = function () { $uibModalInstance.close($scope.config); };
    $scope.cancel = function () { $uibModalInstance.dismiss('cancel'); };
  }
})();
