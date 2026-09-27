"use strict";
const fs = require("fs");
const path = require("path");
const NodeHelper = require("node_helper");
const holdings = require("./holdings");
const sources = require("./sources");

const os = require("os");

// Outside the module directory: MagicMirror serves modules/ over HTTP to the whole LAN.
const HOME = process.env.IBKR_HOLDINGS_HOME || path.join(os.homedir(), ".config", "MMM-IBKRHoldings");
const CREDENTIALS = path.join(HOME, "credentials.json");
const CACHE = path.join(HOME, "cache.json");
// When the Flex service may next be asked, kept across restarts so a restarted mirror does not retry early.
const BACKOFF = path.join(HOME, "backoff.json");

/*
 * Holds the Flex token and reads the statement; the display only ever
 * receives symbols, names and public market quotes. No quantity, value or
 * P&L leaves this process.
 */
module.exports = NodeHelper.create({
  start: function() {
    this.options = null;
    this.list = [];
    this.source = null;
    this.holdingsAt = null;
    this.holdingsError = null;
    this.quotes = {};
    this.quotesAt = null;
    this.quotesError = false;
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
      if (Array.isArray(cache.holdings)) {
        this.list = cache.holdings; this.source = cache.source; this.holdingsAt = cache.at;
      }
    } catch (error) { /* first start */ }
    this.failures = 0; this.nextAttemptAt = 0;
    try {
      const backoff = JSON.parse(fs.readFileSync(BACKOFF, "utf8"));
      this.failures = backoff.failures || 0; this.nextAttemptAt = backoff.nextAttemptAt || 0;
      if (this.failures) this.holdingsError = "Unavailable";
    } catch (error) { /* no failures recorded */ }
  },

  credentials: function() {
    try {
      const value = JSON.parse(fs.readFileSync(CREDENTIALS, "utf8"));
      return value.token && value.queryId ? value : null;
    } catch (error) { return null; }
  },

  socketNotificationReceived: function(name, payload) {
    if (name !== "IBKR_HOLDINGS_START" || !payload) return;
    const first = !this.options;
    this.options = payload;
    if (first) { this.refreshHoldings(); this.refreshQuotes(); }
    else this.send();
  },

  refreshHoldings: async function() {
    clearTimeout(this.holdingsTimer);
    const self = this, credentials = this.credentials();
    let retry = this.options.holdingsInterval;
    if (!credentials) {
      this.holdingsError = "No credentials";
      console.error("[MMM-IBKRHoldings] Missing token/queryId in " + CREDENTIALS);
    } else if (this.holdingsAt && Date.now() - this.holdingsAt < this.options.holdingsInterval) {
      retry = this.holdingsAt + this.options.holdingsInterval - Date.now();
    } else if (Date.now() < this.nextAttemptAt) {
      retry = this.nextAttemptAt - Date.now();
    } else {
      try {
        const statement = await sources.fetchStatement(credentials.token, credentials.queryId);
        const result = holdings.holdingsFromStatement(statement);
        const known = this.list.map(function(h) { return h.conid; }).join();
        this.list = result.holdings; this.source = result.source; this.holdingsAt = Date.now(); this.holdingsError = null;
        if (result.source === "trades") console.warn("[MMM-IBKRHoldings] Statement has no Open Positions section; holdings inferred from trades");
        fs.writeFile(CACHE, JSON.stringify({ at: this.holdingsAt, source: this.source, holdings: this.list }), { mode: 0o600 }, function() {});
        if (known !== this.list.map(function(h) { return h.conid; }).join()) this.refreshQuotes();
        if (this.failures) { this.failures = 0; this.nextAttemptAt = 0; fs.unlink(BACKOFF, function() {}); }
      } catch (error) {
        this.failures++;
        retry = holdings.flexRetryDelay(error.code, this.failures);
        this.nextAttemptAt = Date.now() + retry;
        this.holdingsError = /^(1012|1015|1025)$/.test(error.code) ? "Token rejected" : "Unavailable";
        fs.writeFile(BACKOFF, JSON.stringify({ failures: this.failures, nextAttemptAt: this.nextAttemptAt }), { mode: 0o600 }, function() {});
        console.error("[MMM-IBKRHoldings] Holdings: " + error.message + " (retry in " + Math.round(retry / 60000) + " min)");
      }
    }
    this.send();
    this.holdingsTimer = setTimeout(function() { self.refreshHoldings(); }, Math.max(60000, retry));
  },

  refreshQuotes: async function() {
    clearTimeout(this.quotesTimer);
    if (this.quoting) return;
    this.quoting = true;
    const self = this, options = this.options;
    let failures = 0;
    for (const holding of this.list) {
      const symbol = holdings.yahooSymbol(holding, options.symbols);
      try {
        this.quotes[symbol] = await sources.fetchChart(symbol, options.days);
      } catch (error) {
        failures++;
        console.error("[MMM-IBKRHoldings] " + error.message);
      }
    }
    this.quoting = false;
    this.quotesError = this.list.length > 0 && failures === this.list.length;
    if (!this.quotesError) this.quotesAt = Date.now();
    this.send();
    const quotes = this.list.map(function(h) { return self.quotes[holdings.yahooSymbol(h, options.symbols)]; });
    const next = this.quotesError ? Math.max(120000, options.openInterval) : holdings.quoteInterval(quotes, Date.now(), options.openInterval, options.closedInterval);
    this.quotesTimer = setTimeout(function() { self.refreshQuotes(); }, next);
  },

  send: function() {
    const self = this, options = this.options;
    this.sendSocketNotification("IBKR_HOLDINGS_DATA", {
      holdingsAt: this.holdingsAt, holdingsError: this.holdingsError, source: this.source,
      quotesAt: this.quotesAt, quotesError: this.quotesError,
      holdings: this.list.map(function(h) {
        const symbol = holdings.yahooSymbol(h, options.symbols), quote = self.quotes[symbol] || null;
        return { symbol: h.symbol, name: holdings.displayName(h, quote), currency: h.currency, quote: quote };
      })
    });
  }
});
