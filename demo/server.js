"use strict";
// Preview of the real module front end with made-up holdings and generated prices.
// No IBKR account, Yahoo or MagicMirror needed: `npm run demo`, then open http://localhost:3400.
//
//   /?days=7&market=closed   seven days, after every exchange has closed (the README screenshot)
//   /?days=1&market=open     one day, US session running, European sessions over
//
// The holdings and every price are invented. They go through the module's own
// Yahoo parser (holdings.parseChart) and name cleaner, so the page receives
// exactly the shape the node_helper would send.
const http = require("http");
const fs = require("fs");
const path = require("path");
const holdings = require("../holdings");

const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// Example holdings only. `change` is the synthetic move over the range, in percent.
const HOLDINGS = [
  { symbol: "AAPL", yahooName: "Apple Inc.", exchange: "NASDAQ", currency: "USD", region: "us", close: 228.4, change: { 7: 2.84, 1: 1.12 } },
  { symbol: "ASML", yahooName: "ASML Holding N.V.", exchange: "AEB", currency: "EUR", region: "eu", close: 706.2, change: { 7: -3.37, 1: -0.86 } },
  { symbol: "MSFT", yahooName: "Microsoft Corporation", exchange: "NASDAQ", currency: "USD", region: "us", close: 431.9, change: { 7: 1.46, 1: -0.41 } },
  { symbol: "NESN", yahooName: "Nestlé SA", exchange: "EBS", currency: "CHF", region: "eu", close: 81.36, change: { 7: -1.72, 1: 0.004 } },
  { symbol: "NOVN", yahooName: "Novartis AG", exchange: "EBS", currency: "CHF", region: "eu", close: 98.12, change: { 7: 0.93, 1: 0.58 } }
];

// Session end relative to "now", and length, per scenario and region.
const SESSIONS = {
  open: { us: { end: 4.5 * HOUR, length: 6.5 * HOUR }, eu: { end: -0.5 * HOUR, length: 8.5 * HOUR } },
  closed: { us: { end: -1.5 * HOUR, length: 6.5 * HOUR }, eu: { end: -6 * HOUR, length: 8.5 * HOUR } }
};

// Small deterministic generator, so the screenshots are reproducible.
function random(seed) {
  let s = seed >>> 0;
  return function() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h;
}

/** Bar times of the last `sessions` sessions, up to now; the latest one may still be running. */
function bars(now, session, sessions, step) {
  const stamps = [];
  for (let d = sessions - 1; d >= 0; d--) {
    const end = now + session.end - d * DAY, start = end - session.length;
    for (let t = start; t < end && t <= now; t += step) stamps.push(t);
  }
  return stamps;
}

/**
 * A random walk pinned to the reference close at the start and to the target
 * change at the end (a Brownian bridge plus drift), with a small jump at each
 * session start, so the line wanders like a real one and ends where asked.
 */
function series(stamps, reference, change, seed) {
  const rnd = random(seed), walk = [0];
  for (let i = 1; i < stamps.length; i++) {
    const gap = stamps[i] - stamps[i - 1] > 3 * HOUR ? 3 : 1;
    walk.push(walk[i - 1] + (rnd() - 0.5) * 0.0042 * gap);
  }
  const n = stamps.length - 1, last = walk[n];
  return walk.map(function(w, i) {
    const f = n ? i / n : 1;
    return +(reference * (1 + (w - last * f) + change / 100 * f)).toFixed(2);
  });
}

function scenario(days, market) {
  const now = Date.now(), several = days > 1;
  return HOLDINGS.map(function(h, index) {
    const session = SESSIONS[market][h.region];
    const stamps = bars(now, session, several ? 5 : 1, several ? 15 * MINUTE : 5 * MINUTE);
    const closes = series(stamps, h.close, h.change[several ? 7 : 1], seedOf(h.symbol + days + market) + index);
    const end = now + session.end, start = end - session.length;
    // What Yahoo's v8 chart endpoint answers, reduced to the fields the module reads.
    const yahoo = { chart: { result: [{
      meta: {
        currency: h.currency, shortName: h.yahooName, chartPreviousClose: h.close,
        regularMarketPrice: closes[closes.length - 1], regularMarketTime: Math.floor(Math.min(now, end) / 1000),
        currentTradingPeriod: { regular: { start: Math.floor(start / 1000), end: Math.floor(end / 1000) } }
      },
      timestamp: stamps.map(function(t) { return Math.floor(t / 1000); }),
      indicators: { quote: [{ close: closes }] }
    }] } };
    const quote = holdings.parseChart(yahoo);
    const holding = { symbol: h.symbol, description: h.yahooName.toUpperCase(), exchange: h.exchange, currency: h.currency };
    return { symbol: h.symbol, name: holdings.displayName(holding, quote), currency: h.currency, quote: quote };
  });
}

const FILES = {
  "/": ["demo/index.html", "text/html"],
  "/demo.js": ["demo/demo.js", "text/javascript"],
  "/holdings.js": ["holdings.js", "text/javascript"],
  "/MMM-IBKRHoldings.js": ["MMM-IBKRHoldings.js", "text/javascript"],
  "/MMM-IBKRHoldings.css": ["MMM-IBKRHoldings.css", "text/css"]
};

const port = Number(process.env.PORT || 3400);
http.createServer(function(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/data") {
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days")) || 7));
    const market = url.searchParams.get("market") === "open" ? "open" : "closed";
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({
      holdingsAt: Date.now(), holdingsError: null, source: "positions",
      quotesAt: Date.now(), quotesError: false, holdings: scenario(days, market)
    }));
  }
  const file = FILES[url.pathname];
  if (!file) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", file[1]);
  res.setHeader("Cache-Control", "no-store");
  res.end(fs.readFileSync(path.join(__dirname, "..", file[0])));
}).listen(port, "127.0.0.1", function() {
  console.log("MMM-IBKRHoldings demo: http://localhost:" + port + "/?days=7&market=closed");
  console.log("                       http://localhost:" + port + "/?days=1&market=open");
});
