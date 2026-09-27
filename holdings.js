/* Shared, dependency-free holdings logic. Runs in Node 10 (helper) and the mirror's browser. */
(function(root) {
  "use strict";

  /* ---------- Flex statement ---------- */

  function parseCsv(text) {
    var rows = [], row = [], field = "", quoted = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /** CSV statement → { sectionCode: [record, …] }, keyed by each section's own header row. */
  function csvSections(text) {
    var sections = {}, code = null, header = null;
    parseCsv(text).forEach(function(r) {
      if (r[0] === "BOS") { code = r[1]; header = null; sections[code] = sections[code] || []; return; }
      if (r[0] === "EOS") { code = null; header = null; return; }
      if (!code || r.length < 2) return;
      if (!header) { header = r; return; }
      var record = {};
      header.forEach(function(name, i) { record[name] = r[i]; });
      sections[code].push(record);
    });
    return sections;
  }

  function xmlAttributes(tag) {
    var record = {}, re = /([A-Za-z_][\w.-]*)="([^"]*)"/g, m;
    while ((m = re.exec(tag))) {
      record[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    }
    return record;
  }

  /** XML statement → the same shape as csvSections, with the CSV section codes. */
  function xmlSections(text) {
    function all(tag) {
      var out = [], re = new RegExp("<" + tag + "\\s[^>]*>", "g"), m;
      while ((m = re.exec(text))) out.push(xmlAttributes(m[0]));
      return out;
    }
    return { POST: all("OpenPosition"), TRNT: all("Trade") };
  }

  function pick(record, names) {
    for (var i = 0; i < names.length; i++) {
      if (record[names[i]] !== undefined && record[names[i]] !== "") return record[names[i]];
    }
    return "";
  }

  var EQUITY = ["STK", "ETF", "FUND"];

  function instrument(record) {
    return {
      conid: String(pick(record, ["Conid", "conid"])),
      symbol: pick(record, ["Symbol", "symbol"]),
      description: pick(record, ["Description", "description"]),
      exchange: pick(record, ["ListingExchange", "listingExchange"]),
      currency: pick(record, ["CurrencyPrimary", "currency", "currencyPrimary"])
    };
  }

  function isEquity(record) { return EQUITY.indexOf(pick(record, ["AssetClass", "assetCategory", "assetClass"])) !== -1; }
  function number(value) { var n = Number(String(value).replace(/,/g, "")); return isFinite(n) ? n : 0; }

  /**
   * Which instruments are held. Quantities are read only to decide that and
   * never leave this function: callers get symbols and names, nothing else.
   *
   * An Open Positions section is authoritative. Without one, holdings are
   * inferred from the statement's trades: every instrument bought on net
   * within the statement's period. That misses positions opened before the
   * period and ignores corporate actions, so it is marked as inferred.
   */
  function holdingsFromStatement(text) {
    var body = String(text || "").replace(/^﻿/, "");
    var sections = /^\s*</.test(body) ? xmlSections(body) : csvSections(body);
    var positions = sections.POST || [];
    var net = {}, meta = {}, source;
    if (positions.length || /<OpenPositions[\s>]/.test(body)) {
      source = "positions";
      var summaries = positions.filter(function(r) { return /^SUMMARY$/i.test(pick(r, ["LevelOfDetail", "levelOfDetail"])); });
      (summaries.length ? summaries : positions).forEach(function(r) {
        if (!isEquity(r)) return;
        var item = instrument(r);
        // A query without a quantity field lists only what is held, so every row counts.
        var quantity = pick(r, ["Position", "position", "Quantity", "quantity"]);
        net[item.conid] = (net[item.conid] || 0) + (quantity === "" ? 1 : number(quantity));
        meta[item.conid] = item;
      });
    } else if (sections.TRNT) {
      source = "trades";
      sections.TRNT.forEach(function(r) {
        var detail = pick(r, ["LevelOfDetail", "levelOfDetail"]);
        if (!isEquity(r) || (detail && !/^EXECUTION$/i.test(detail))) return;
        var item = instrument(r);
        net[item.conid] = (net[item.conid] || 0) + number(pick(r, ["Quantity", "quantity"]));
        meta[item.conid] = item;
      });
    } else {
      throw new Error("Statement has neither an Open Positions nor a Trades section");
    }
    var holdings = Object.keys(net).filter(function(conid) {
      return source === "positions" ? Math.abs(net[conid]) > 1e-9 : net[conid] > 1e-9;
    }).map(function(conid) { return meta[conid]; });
    holdings.sort(function(a, b) { return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0; });
    return { source: source, holdings: holdings };
  }

  /** The Flex Web Service's XML envelope: { status, code, message, reference }. */
  function flexEnvelope(text) {
    function tag(name) { var m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(text); return m ? m[1].trim() : ""; }
    return { status: tag("Status"), code: tag("ErrorCode"), message: tag("ErrorMessage"), reference: tag("ReferenceCode") };
  }

  /**
   * How long to leave the Flex service alone after the n-th failure in a row.
   * IBKR answers repeated attempts with 1025 ("too many failed attempts") and
   * locks the token, which also blocks every other tool using it, so retries
   * back off from 15 minutes and double up to 6 hours. Errors only a person
   * can fix (1012 expired, 1015 invalid token, 1025 lockout) wait 6 hours.
   */
  function flexRetryDelay(code, failures) {
    var cap = 6 * 3600000;
    if (/^(1012|1015|1025)$/.test(code)) return cap;
    return Math.min(cap, 900000 * Math.pow(2, Math.max(0, failures - 1)));
  }

  /* ---------- Yahoo ---------- */

  var SUFFIX = {
    IBIS: ".DE", IBIS2: ".DE", XETRA: ".DE", FWB: ".F", FWB2: ".F", SWB: ".SG",
    SWX: ".SW", EBS: ".SW", VIRTX: ".SW", LSE: ".L", LSEETF: ".L", AEB: ".AS", SBF: ".PA", ENEXT: ".PA",
    EBR: ".BR", BVME: ".MI", BM: ".MC", SFB: ".ST", OSE: ".OL", KFB: ".CO", HEX: ".HE", VSE: ".VI",
    TSE: ".TO", VENTURE: ".V", SEHK: ".HK", TSEJ: ".T", ASX: ".AX", SGX: ".SI"
  };

  function yahooSymbol(holding, overrides) {
    if (overrides && overrides[holding.symbol]) return overrides[holding.symbol];
    var suffix = SUFFIX[holding.exchange] || "";
    var base = holding.symbol.replace(/[ .]/g, "-");
    if (suffix === ".HK") base = ("0000" + base).slice(-4);
    return base + suffix;
  }

  function finite(value) { return typeof value === "number" && isFinite(value) ? value : null; }

  /** Yahoo's v8 chart answer → the day's quote and five-minute line, checked before it is believed. */
  function parseChart(body) {
    var result = body && body.chart && body.chart.result && body.chart.result[0];
    var meta = result && result.meta;
    if (!meta) throw new Error("Chart response has no result");
    var price = finite(meta.regularMarketPrice), time = finite(meta.regularMarketTime);
    if (price === null || price <= 0 || time === null) throw new Error("Chart response lacks a price or its time");
    var stamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    var quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
    var closes = quote && Array.isArray(quote.close) ? quote.close : [];
    var points = [];
    stamps.forEach(function(stamp, i) {
      var at = finite(stamp), close = finite(closes[i]);
      if (at !== null && close !== null && close > 0) points.push([at * 1000, close]);
    });
    var previous = finite(meta.chartPreviousClose);
    var regular = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
    var session = regular && finite(regular.start) !== null && finite(regular.end) !== null ? [regular.start * 1000, regular.end * 1000] : null;
    return {
      price: price, quoteAt: time * 1000,
      currency: typeof meta.currency === "string" ? meta.currency : "",
      previousClose: previous !== null && previous > 0 ? previous : null,
      name: typeof meta.shortName === "string" ? meta.shortName : "",
      session: session, points: points
    };
  }

  /* ---------- Display ---------- */

  function rounded(value) { var r = Math.round(value * 100) / 100; return r === 0 ? 0 : r; }

  /** A change that rounds to zero carries no sign and no colour, so a flat day never reads as a red −0.00%. */
  function signedPct(value) {
    var r = rounded(value);
    return (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r).toFixed(2) + "%";
  }

  function tone(value) { var r = rounded(value); return r > 0 ? "up" : r < 0 ? "down" : "flat"; }

  /** Change against the chart's reference: the previous close for one day, the close before the range for several. */
  function change(quote) {
    return quote && quote.previousClose ? (quote.price - quote.previousClose) / quote.previousClose * 100 : null;
  }

  var SYMBOLS = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", HKD: "HK$", CAD: "C$", AUD: "A$" };

  function formatPrice(value, currency) {
    var digits = value >= 1000 ? 0 : value >= 1 ? 2 : 4;
    var text = value.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
    if (currency === "GBp") return text + "p";
    return SYMBOLS[currency] ? SYMBOLS[currency] + text : (currency ? currency + " " : "") + text;
  }

  /** The day is drawn across its trading session, as Yahoo does, so a morning's line fills the morning. */
  function domain(quote) {
    var pts = quote.points, first = pts[0][0], last = pts[pts.length - 1][0];
    if (quote.session && first >= quote.session[0] - 600000 && last <= quote.session[1] + 600000) {
      return [Math.min(first, quote.session[0]), Math.max(last, quote.session[1])];
    }
    return [first, last];
  }

  /** Where one trading session ends and the next begins: a gap of more than three hours between bars. */
  var SESSION_GAP = 3 * 3600000;

  /**
   * The line and area in a width × height box, against the reference close:
   * { line, area, baseY, lastX, lastY, breaks } in SVG path syntax.
   *
   * One day is drawn against clock time, across its whole session. Several
   * days are drawn bar by bar, as Yahoo's 5D chart does, so nights and
   * weekends take no room; `breaks` are the x positions where a new session
   * starts, for a faint separator.
   */
  function geometry(quote, width, height, severalDays) {
    var pts = quote.points, ref = quote.previousClose !== null ? quote.previousClose : pts[0][1];
    var low = ref, high = ref;
    pts.forEach(function(p) { low = Math.min(low, p[1]); high = Math.max(high, p[1]); });
    var pad = (high - low) * 0.08 || Math.abs(high) * 0.001 || 1;
    var d = domain(quote), top = 2, bottom = 2;
    var xs = pts.map(function(p, i) {
      return severalDays ? i / Math.max(1, pts.length - 1) * width : (p[0] - d[0]) / Math.max(1, d[1] - d[0]) * width;
    });
    function y(p) { return top + (1 - (p - (low - pad)) / (high - low + 2 * pad)) * (height - top - bottom); }
    var line = pts.map(function(p, i) { return (i ? "L" : "M") + xs[i].toFixed(1) + "," + y(p[1]).toFixed(1); }).join("");
    var baseY = y(ref), lastX = xs[xs.length - 1];
    var area = line + "L" + lastX.toFixed(1) + "," + baseY.toFixed(1) + "L" + xs[0].toFixed(1) + "," + baseY.toFixed(1) + "Z";
    var breaks = [];
    if (severalDays) {
      for (var i = 1; i < pts.length; i++) if (pts[i][0] - pts[i - 1][0] > SESSION_GAP) breaks.push((xs[i - 1] + xs[i]) / 2);
    }
    return { line: line, area: area, baseY: baseY, lastX: lastX, lastY: y(pts[pts.length - 1][1]), breaks: breaks };
  }

  /** Short company name: Yahoo's, else IBKR's upper-case description in title case, without legal suffixes. */
  function displayName(holding, quote) {
    // Yahoo pads some names with a column of spaces and a stray letter ("EXAMPLE SE      N").
    var name = (quote && quote.name ? quote.name : holding.description).replace(/\s{2,}.*$/, "").trim();
    if (name === name.toUpperCase()) name = name.toLowerCase().replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    var suffix = /[ ,-]+(Inc\.?|Corp(oration)?\.?|Co\.?|Ltd\.?|Plc|S\.?E\.?|N\.?V\.?|AG|SA|Holdings?|Cl(ass)? [A-Z]|ADR)$/i;
    while (suffix.test(name)) name = name.replace(suffix, "");
    return name.trim();
  }

  /** Minimum sensible poll spacing: fast while any session is open, slow otherwise. */
  function quoteInterval(quotes, now, open, closed) {
    var trading = quotes.some(function(q) { return q && q.session && now >= q.session[0] && now <= q.session[1] + 300000; });
    return trading ? open : closed;
  }

  var api = {
    parseCsv: parseCsv, holdingsFromStatement: holdingsFromStatement, flexEnvelope: flexEnvelope, flexRetryDelay: flexRetryDelay,
    yahooSymbol: yahooSymbol, parseChart: parseChart, signedPct: signedPct, tone: tone, change: change,
    formatPrice: formatPrice, geometry: geometry, displayName: displayName, quoteInterval: quoteInterval
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IBKRHoldings = api;
})(typeof window !== "undefined" ? window : this);
