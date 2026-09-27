"use strict";
const https = require("https");
const holdings = require("./holdings");

const FLEX = "https://gdcdyn.interactivebrokers.com/Universal/servlet/FlexStatementService";
const CHART = "https://query2.finance.yahoo.com/v8/finance/chart/";

function get(url, headers, timeout) {
  return new Promise(function(resolve, reject) {
    const req = https.get(url, { headers: headers }, function(res) {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", function(chunk) {
        body += chunk;
        if (body.length > 20000000) req.destroy(new Error("Response too large"));
      });
      res.on("error", reject);
      res.on("end", function() { resolve({ status: res.statusCode, body: body }); });
    });
    req.setTimeout(timeout, function() { req.destroy(new Error("Request timed out")); });
    req.on("error", reject);
  });
}

function wait(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

class FlexError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * One Flex Web Service statement: SendRequest buys a reference, GetStatement
 * is polled until the statement is generated. Large transaction queries can
 * take minutes; an Open Positions query answers in seconds.
 */
async function fetchStatement(token, queryId, options) {
  const poll = (options && options.poll) || 10000, deadline = Date.now() + ((options && options.timeout) || 1800000);
  const headers = { "User-Agent": "MMM-IBKRHoldings/1.0" };
  const qs = function(q) { return "?t=" + encodeURIComponent(token) + "&q=" + encodeURIComponent(q) + "&v=3"; };
  const sent = await get(FLEX + ".SendRequest" + qs(queryId), headers, 30000);
  const envelope = holdings.flexEnvelope(sent.body);
  if (envelope.status !== "Success" || !envelope.reference) {
    throw new FlexError(envelope.code || "http", "SendRequest failed: " + (envelope.code || sent.status) + " " + envelope.message);
  }
  for (;;) {
    await wait(poll);
    const answer = await get(FLEX + ".GetStatement" + qs(envelope.reference), headers, 60000);
    if (!/^\s*<FlexStatementResponse/.test(answer.body)) {
      if (answer.status !== 200) throw new FlexError("http", "GetStatement answered HTTP " + answer.status);
      return answer.body;
    }
    const status = holdings.flexEnvelope(answer.body);
    // 1019: still generating. 1018: too many requests, wait longer.
    if (status.code !== "1019" && status.code !== "1018") throw new FlexError(status.code, "GetStatement failed: " + status.code + " " + status.message);
    if (Date.now() > deadline) throw new FlexError("timeout", "Statement was not generated in time");
    if (status.code === "1018") await wait(poll * 3);
  }
}

/**
 * One day: the session's five-minute bars against the previous close. Several
 * days: fifteen-minute bars from midnight UTC `days - 1` days ago (usually five
 * sessions for a week) against the close before them.
 */
async function fetchChart(symbol, days) {
  const now = Date.now(), midnight = now - now % 86400000;
  const query = days > 1
    ? "?period1=" + Math.floor((midnight - (days - 1) * 86400000) / 1000) + "&period2=" + Math.floor(now / 1000) + "&interval=15m"
    : "?range=1d&interval=5m";
  // A full browser user agent over Node's TLS handshake is what Yahoo throttles
  // (HTTP 429); the bare token is answered.
  const response = await get(CHART + encodeURIComponent(symbol) + query, { "User-Agent": "Mozilla/5.0" }, 12000);
  if (response.status !== 200) throw new Error("Yahoo chart for " + symbol + " answered HTTP " + response.status);
  return holdings.parseChart(JSON.parse(response.body));
}

module.exports = { fetchStatement: fetchStatement, fetchChart: fetchChart, FlexError: FlexError };
