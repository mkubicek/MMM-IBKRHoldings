/* global Module, IBKRHoldings */
Module.register("MMM-IBKRHoldings", {
  defaults: {
    title: "Holdings",
    days: 7,
    holdingsInterval: 6 * 3600000,
    openInterval: 120000,
    closedInterval: 900000,
    maximumEntries: 12,
    exclude: [],
    symbols: {},
    chartWidth: 240,
    chartHeight: 36
  },
  getScripts: function() { return [this.file("holdings.js")]; },
  getStyles: function() { return ["MMM-IBKRHoldings.css"]; },
  start: function() {
    this.state = null;
    this.sendSocketNotification("IBKR_HOLDINGS_START", {
      holdingsInterval: this.config.holdingsInterval, openInterval: this.config.openInterval,
      closedInterval: this.config.closedInterval, symbols: this.config.symbols, days: this.config.days
    });
    var self = this;
    // Re-evaluate staleness and market status without new data.
    this.renderTimer = setInterval(function() { self.updateDom(0); }, 60000);
  },
  socketNotificationReceived: function(name, payload) {
    if (name !== "IBKR_HOLDINGS_DATA") return;
    this.state = payload;
    this.updateDom(0);
  },
  svg: function(tag, attrs, parent) {
    var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(function(k) { node.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(node);
    return node;
  },
  chart: function(quote, id) {
    var w = this.config.chartWidth, h = this.config.chartHeight;
    var root = this.svg("svg", { width: w, height: h, viewBox: "0 0 " + w + " " + h, "class": "ih-chart" });
    if (!quote || quote.points.length < 2) return root;
    var g = IBKRHoldings.geometry(quote, w, h, this.config.days > 1);
    var defs = this.svg("defs", {}, root);
    this.svg("rect", { x: 0, y: -h, width: w, height: Math.max(0, g.baseY + h) }, this.svg("clipPath", { id: id + "-up" }, defs));
    this.svg("rect", { x: 0, y: g.baseY, width: w, height: h * 2 }, this.svg("clipPath", { id: id + "-down" }, defs));
    var self = this;
    g.breaks.forEach(function(x) { self.svg("line", { x1: x, x2: x, y1: 0, y2: h, "class": "ih-break" }, root); });
    this.svg("line", { x1: 0, x2: w, y1: g.baseY, y2: g.baseY, "class": "ih-reference" }, root);
    this.svg("path", { d: g.area, "class": "ih-area ih-up", "clip-path": "url(#" + id + "-up)" }, root);
    this.svg("path", { d: g.area, "class": "ih-area ih-down", "clip-path": "url(#" + id + "-down)" }, root);
    this.svg("path", { d: g.line, "class": "ih-line ih-up", "clip-path": "url(#" + id + "-up)" }, root);
    this.svg("path", { d: g.line, "class": "ih-line ih-down", "clip-path": "url(#" + id + "-down)" }, root);
    var change = IBKRHoldings.change(quote);
    this.svg("circle", { cx: g.lastX, cy: g.lastY, r: 2.2, "class": "ih-dot ih-" + (change === null ? "flat" : IBKRHoldings.tone(change)) }, root);
    return root;
  },
  getDom: function() {
    var self = this, now = Date.now(), state = this.state, root = document.createElement("div");
    root.className = "ibkr-holdings";
    root.style.width = (this.config.chartWidth + 220) + "px";
    function el(tag, text, cls, parent) {
      var node = document.createElement(tag); node.textContent = text;
      if (cls) node.className = cls;
      parent.appendChild(node); return node;
    }
    var heading = el("div", this.config.title, "ih-title", root);
    if (!state || !state.holdings.length) {
      el("div", state && state.holdingsError ? "Holdings unavailable · retrying" : "Loading holdings …", "ih-meta", root);
      return root;
    }
    var rows = state.holdings.filter(function(h) { return self.config.exclude.indexOf(h.symbol) === -1; }).slice(0, this.config.maximumEntries);
    var trading = rows.some(function(h) { return h.quote && h.quote.session && now >= h.quote.session[0] && now <= h.quote.session[1]; });
    var stale = !state.quotesAt || now - state.quotesAt > 3 * (trading ? this.config.openInterval : this.config.closedInterval);
    var status = state.quotesError && stale ? "Offline" : stale ? "Stale" : trading ? "Live" : "Closed";
    var right = el("span", this.config.days > 1 ? this.config.days + " days · " : "", "ih-range", heading);
    el("span", "● " + status, "ih-health" + (stale ? " ih-warning" : trading ? " ih-live" : ""), right);

    rows.forEach(function(h, i) {
      var row = el("div", "", "ih-row", root);
      var label = el("div", "", "ih-label", row);
      el("div", h.symbol, "ih-symbol", label);
      el("div", h.name, "ih-name", label);
      row.appendChild(self.chart(h.quote, "ih" + self.identifier + "-" + i));
      var numbers = el("div", "", "ih-numbers", row);
      if (!h.quote) { el("div", "—", "ih-price", numbers); return; }
      var change = IBKRHoldings.change(h.quote);
      el("div", IBKRHoldings.formatPrice(h.quote.price, h.quote.currency || h.currency), "ih-price", numbers);
      el("div", change === null ? "" : IBKRHoldings.signedPct(change), "ih-change ih-" + (change === null ? "flat" : IBKRHoldings.tone(change)), numbers);
    });
    return root;
  }
});
