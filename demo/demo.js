/* Just enough of MagicMirror² (Module.register, file, getScripts, updateDom and the
 * socket) to run the real module front end against the demo server's invented holdings.
 * URL options: ?days=7|1 sets the chart span, ?market=open|closed the scenario. */
(function() {
  "use strict";
  var definition = null;

  window.Module = {
    register: function(name, module) { definition = module; }
  };

  function load(src, done) {
    var script = document.createElement("script");
    script.src = src;
    script.onload = done;
    document.head.appendChild(script);
  }

  window.IBKRHoldingsDemo = {
    start: function() {
      var params = new URLSearchParams(location.search);
      var module = Object.create(definition);
      module.identifier = "demo";
      module.config = Object.assign({}, definition.defaults);
      if (params.get("days")) module.config.days = +params.get("days");
      module.file = function(name) { return "/" + name; };
      module.updateDom = function() {
        var content = document.getElementById("content");
        content.innerHTML = "";
        content.appendChild(module.getDom());
      };
      module.sendSocketNotification = function() {
        fetch("/data?days=" + module.config.days + "&market=" + (params.get("market") || "closed"))
          .then(function(response) { return response.json(); })
          .then(function(payload) { module.socketNotificationReceived("IBKR_HOLDINGS_DATA", payload); });
      };
      var scripts = module.getScripts().slice();
      (function next() {
        if (scripts.length) return load(scripts.shift(), next);
        module.start();
        module.updateDom();
      })();
    }
  };
}());
