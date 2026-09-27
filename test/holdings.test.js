const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const h = require('../holdings');

const TRADE_HEADER = '"ClientAccountID","AssetClass","Symbol","Description","Conid","ListingExchange","CurrencyPrimary","Quantity","LevelOfDetail"';
function trade(symbol, conid, quantity, extra) {
  return `"U1","${(extra && extra.asset) || 'STK'}","${symbol}","${symbol} INC, CLASS A","${conid}","NASDAQ","USD","${quantity}","${(extra && extra.detail) || 'EXECUTION'}"`;
}
function csv(sections) {
  const lines = ['"BOF","U1","q","2","20250101","20251231","20251231;120000","100","100"', '"BOA","U1"'];
  for (const [code, rows] of Object.entries(sections)) lines.push(`"BOS","${code}","x"`, ...rows, `"EOS","${code}","${rows.length - 1}"`);
  lines.push('"EOA","U1"', '"EOF","U1"');
  return lines.join('\n');
}

test('CSV parser keeps quoted commas and doubled quotes', () => {
  assert.deepEqual(h.parseCsv('"a,b","c""d",e\r\n1,2,3'), [['a,b', 'c"d', 'e'], ['1', '2', '3']]);
});

test('Open Positions section is authoritative, summary rows preferred, cash and options ignored', () => {
  const text = csv({
    POST: [
      '"ClientAccountID","AssetClass","Symbol","Description","Conid","ListingExchange","CurrencyPrimary","Position","LevelOfDetail"',
      '"U1","STK","MSFT","MICROSOFT CORP","1000001","NASDAQ","USD","500","SUMMARY"',
      '"U1","STK","MSFT","MICROSOFT CORP","1000001","NASDAQ","USD","250","LOT"',
      '"U1","STK","ASML","ASML HOLDING NV","1000002","AEB","EUR","20","SUMMARY"',
      '"U1","OPT","MSFT 260116C00400000","MSFT CALL","1000003","CBOE","USD","1","SUMMARY"'
    ],
    TRNT: [TRADE_HEADER, trade('KO', '1000004', 10)]
  });
  const result = h.holdingsFromStatement(text);
  assert.equal(result.source, 'positions');
  assert.deepEqual(result.holdings.map(x => x.symbol), ['ASML', 'MSFT']);
});

test('without positions, holdings are what was bought on net; sold-out and short-looking lines drop', () => {
  const text = csv({ TRNT: [TRADE_HEADER,
    trade('JNJ', '1000005', 10), trade('JNJ', '1000005', -10),
    trade('AAPL', '1000006', 100), trade('AAPL', '1000006', 100, { detail: 'ORDER' }),
    trade('PEP', '1000007', -50),
    trade('EUR.USD', '1000008', 1000, { asset: 'CASH' })] });
  const result = h.holdingsFromStatement(text);
  assert.equal(result.source, 'trades');
  assert.deepEqual(result.holdings.map(x => x.symbol), ['AAPL']);
});

test('XML statements are read too', () => {
  const xml = '<FlexQueryResponse><FlexStatements><FlexStatement><OpenPositions>' +
    '<OpenPosition assetCategory="STK" symbol="NOVN" description="NOVARTIS AG-REG" conid="1000009" listingExchange="EBS" currency="CHF" position="200" levelOfDetail="SUMMARY" />' +
    '<OpenPosition assetCategory="STK" symbol="JNJ" description="JOHNSON &amp; JOHNSON" conid="1000005" listingExchange="NYSE" currency="USD" position="0" levelOfDetail="SUMMARY" />' +
    '</OpenPositions></FlexStatement></FlexStatements></FlexQueryResponse>';
  assert.deepEqual(h.holdingsFromStatement(xml), { source: 'positions', holdings: [{ conid: '1000009', symbol: 'NOVN', description: 'NOVARTIS AG-REG', exchange: 'EBS', currency: 'CHF' }] });
  const empty = '<FlexQueryResponse><OpenPositions></OpenPositions></FlexQueryResponse>';
  assert.deepEqual(h.holdingsFromStatement(empty).holdings, []);
});

test('a statement without either section is refused rather than read as no holdings', () => {
  assert.throws(() => h.holdingsFromStatement(csv({ CTRN: ['"ClientAccountID","Amount"', '"U1","5"'] })));
});

test('holdings carry no quantity', () => {
  const text = csv({ POST: ['"ClientAccountID","AssetClass","Symbol","Description","Conid","ListingExchange","CurrencyPrimary","Position","MarkPrice","PositionValue"',
    '"U1","STK","NESN","NESTLE SA-REG","1000010","EBS","CHF","4321","81.23","350995"'] });
  const serialized = JSON.stringify(h.holdingsFromStatement(text));
  assert.ok(!/4321|350995|81\.23/.test(serialized), serialized);
});

test('Flex envelopes', () => {
  assert.deepEqual(h.flexEnvelope('<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode><ErrorMessage>Statement generation in progress.</ErrorMessage></FlexStatementResponse>'),
    { status: 'Warn', code: '1019', message: 'Statement generation in progress.', reference: '' });
});

test('IBKR listings map to Yahoo symbols', () => {
  assert.equal(h.yahooSymbol({ symbol: 'SAP', exchange: 'IBIS' }), 'SAP.DE');
  assert.equal(h.yahooSymbol({ symbol: 'BRK B', exchange: 'NYSE' }), 'BRK-B');
  assert.equal(h.yahooSymbol({ symbol: 'NESN', exchange: 'EBS' }), 'NESN.SW');
  assert.equal(h.yahooSymbol({ symbol: '5', exchange: 'SEHK' }), '0005.HK');
  assert.equal(h.yahooSymbol({ symbol: 'ASML', exchange: 'AEB' }), 'ASML.AS');
  assert.equal(h.yahooSymbol({ symbol: 'ASML', exchange: 'NASDAQ' }, { ASML: 'ASML.AS' }), 'ASML.AS');
});

function chart(extra) {
  return { chart: { result: [Object.assign({
    meta: { currency: 'USD', regularMarketPrice: 102, regularMarketTime: 1790000000, chartPreviousClose: 100, shortName: 'Apple Inc.',
      currentTradingPeriod: { regular: { start: 1789997400, end: 1790020800 } } },
    timestamp: [1789997400, 1789997700, 1789998000],
    indicators: { quote: [{ close: [99, null, 102] }] }
  }, extra)] } };
}

test('Yahoo chart: missing closes are dropped, the session is kept', () => {
  const q = h.parseChart(chart());
  assert.deepEqual(q.points, [[1789997400000, 99], [1789998000000, 102]]);
  assert.equal(q.previousClose, 100);
  assert.deepEqual(q.session, [1789997400000, 1790020800000]);
  assert.throws(() => h.parseChart({ chart: { result: [{ meta: { regularMarketPrice: 0, regularMarketTime: 1 } }] } }));
  assert.throws(() => h.parseChart({ chart: { result: null, error: { code: 'Not Found' } } }));
});

test('the morning line fills only the morning, the reference sits between high and low', () => {
  const q = h.parseChart(chart());
  const g = h.geometry(q, 150, 30);
  assert.ok(g.lastX > 0 && g.lastX < 10, String(g.lastX));
  assert.ok(g.baseY > 2 && g.baseY < 28);
  assert.ok(g.lastY < g.baseY, 'up day ends above the previous close');
});

test('changes: rounding to zero is flat, not red', () => {
  assert.equal(h.signedPct(-0.001), '0.00%');
  assert.equal(h.tone(-0.001), 'flat');
  assert.equal(h.signedPct(2), '+2.00%');
  assert.equal(h.signedPct(-1.234), '−1.23%');
  assert.equal(h.change({ price: 102, previousClose: 100 }), 2);
  assert.equal(h.formatPrice(1082.75, 'USD'), "$1'083");
  assert.equal(h.formatPrice(35, 'EUR'), '€35.00');
  assert.equal(h.formatPrice(12.3, 'CHF'), 'CHF 12.30');
});

test('names are short', () => {
  assert.equal(h.displayName({ description: 'MICROSOFT CORP' }, null), 'Microsoft');
  assert.equal(h.displayName({ description: 'X' }, { name: 'Novartis AG' }), 'Novartis');
  assert.equal(h.displayName({ description: 'EXAMPLE MOTORS INC - ADR' }, null), 'Example Motors');
  assert.equal(h.displayName({ description: 'BERKSHIRE HATHAWAY INC-CLASS B' }, null), 'Berkshire Hathaway');
  assert.equal(h.displayName({ description: 'COCA-COLA CO' }, null), 'Coca-Cola');
});

test('quotes poll fast only while a session is open', () => {
  const q = { session: [1000, 2000] };
  assert.equal(h.quoteInterval([q, null], 1500, 1, 2), 1);
  assert.equal(h.quoteInterval([q], 5000000, 1, 2), 2);
});

test('helper sends the display symbols, names and quotes only', async () => {
  let helper;
  const sent = [];
  const statement = csv({ POST: ['"ClientAccountID","AssetClass","Symbol","Description","Conid","ListingExchange","CurrencyPrimary","Position","CostBasisMoney","FifoPnlUnrealized"',
    '"U1","STK","AAPL","APPLE INC","1000006","NASDAQ","USD","300","98765","12345"'] });
  const files = {};
  const fakeFs = {
    readFileSync: p => { if (p.endsWith('credentials.json')) return '{"token":"t","queryId":"q"}'; if (files[p]) return files[p]; throw new Error('ENOENT'); },
    writeFile: (p, data, opts, cb) => { files[p] = data; cb(); }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../node_helper'), 'utf8'), {
    require: name => name === 'node_helper' ? { create: x => (helper = x) } : name === './holdings' ? h : name === 'fs' ? fakeFs : name === 'path' ? require('path') : name === 'os' ? require('os')
      : { fetchStatement: async () => statement, fetchChart: async () => h.parseChart(chart()) },
    module: {}, console, process: { env: { IBKR_HOLDINGS_HOME: '/m' } }, setTimeout: () => 0, clearTimeout: () => {}, Date, JSON, Math
  });
  helper.sendSocketNotification = (name, payload) => sent.push(payload);
  helper.start();
  helper.socketNotificationReceived('IBKR_HOLDINGS_START', { holdingsInterval: 1, openInterval: 1, closedInterval: 1, symbols: {} });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  const last = sent[sent.length - 1];
  assert.equal(last.holdings[0].symbol, 'AAPL');
  assert.equal(last.holdings[0].name, 'Apple');
  assert.equal(last.holdings[0].quote.price, 102);
  const everything = JSON.stringify(sent) + JSON.stringify(files);
  assert.ok(!/98765|12345|"300"/.test(everything), everything);
});

test('padded, upper-case Yahoo names are cleaned', () => {
  assert.equal(h.displayName({ description: 'EXAMPLE SE' }, { name: 'EXAMPLE SE                    N' }), 'Example');
  assert.equal(h.displayName({ description: '' }, { name: 'ASML Holding N.V.' }), 'ASML');
  assert.equal(h.displayName({ description: '' }, { name: 'Example.com, Inc.' }), 'Example.com');
});

test('Flex retries back off, and lockouts wait six hours', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(n => h.flexRetryDelay('1001', n) / 60000), [15, 30, 60, 120, 240, 360, 360]);
  for (const code of ['1012', '1015', '1025']) assert.equal(h.flexRetryDelay(code, 1), 6 * 3600000);
});

test('a restart honours the recorded backoff instead of asking IBKR again', async () => {
  let helper, asked = 0;
  const files = { '/m/backoff.json': JSON.stringify({ failures: 3, nextAttemptAt: Date.now() + 3600000 }) };
  const fakeFs = {
    readFileSync: p => { if (p.endsWith('credentials.json')) return '{"token":"t","queryId":"q"}'; if (files[p]) return files[p]; throw new Error('ENOENT'); },
    writeFile: (p, data, opts, cb) => { files[p] = data; cb(); }, unlink: (p, cb) => cb()
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../node_helper'), 'utf8'), {
    require: name => name === 'node_helper' ? { create: x => (helper = x) } : name === './holdings' ? h : name === 'fs' ? fakeFs : name === 'path' ? require('path') : name === 'os' ? require('os')
      : { fetchStatement: async () => { asked++; throw Object.assign(new Error('x'), { code: '1025' }); }, fetchChart: async () => h.parseChart(chart()) },
    module: {}, console: { error() {}, warn() {}, log() {} }, process: { env: { IBKR_HOLDINGS_HOME: '/m' } }, setTimeout: () => 0, clearTimeout: () => {}, Date, JSON, Math
  });
  helper.sendSocketNotification = () => {};
  helper.start();
  helper.socketNotificationReceived('IBKR_HOLDINGS_START', { holdingsInterval: 1, openInterval: 1, closedInterval: 1, symbols: {} });
  await new Promise(r => setImmediate(r));
  assert.equal(asked, 0);
  helper.nextAttemptAt = 0;
  await helper.refreshHoldings();
  assert.equal(asked, 1);
  assert.equal(JSON.parse(files['/m/backoff.json']).failures, 4);
});

test('an Open Positions query without a quantity field still lists its rows', () => {
  const xml = '<FlexQueryResponse><OpenPositions>' +
    '<OpenPosition assetCategory="STK" symbol="NOVN" description="NOVARTIS AG-REG" conid="1000009" listingExchange="EBS" currency="CHF" />' +
    '<OpenPosition assetCategory="STK" symbol="ASML" conid="1000002" listingExchange="AEB" currency="EUR" />' +
    '</OpenPositions></FlexQueryResponse>';
  assert.deepEqual(h.holdingsFromStatement(xml).holdings.map(x => x.symbol), ['ASML', 'NOVN']);
});

test('several days are drawn bar by bar, with a break where each session starts', () => {
  const day = 86400000, open = Date.parse('2026-09-21T13:30:00Z');
  const points = [];
  for (let d = 0; d < 3; d++) for (let b = 0; b < 4; b++) points.push([open + d * day + b * 900000, 100 + d + b / 10]);
  const g = h.geometry({ points, previousClose: 99, session: null }, 110, 30, true);
  assert.equal(g.lastX, 110);
  assert.equal(g.breaks.length, 2);
  assert.ok(Math.abs(g.breaks[0] - 35) < 0.01, String(g.breaks[0]));
  assert.deepEqual(h.geometry({ points, previousClose: 99, session: null }, 110, 30, false).breaks, []);
});

test('runtime files stay within what the mirror runs (Node 10, Electron 16)', () => {
  for (const file of ['holdings.js', 'sources.js', 'node_helper.js', 'MMM-IBKRHoldings.js']) {
    const code = fs.readFileSync(require.resolve('../' + file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/\?\.[A-Za-z_$[(]|\?\?/.test(code), file + ' uses optional chaining or nullish coalescing');
    if (file !== 'MMM-IBKRHoldings.js') assert.ok(!/\bfetch\(/.test(code), file + ' uses fetch, which Node 10 lacks');
  }
});

test('the demo shows invented holdings through the real parser, without quantities', async () => {
  const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [require.resolve('../demo/server.js')], { env: Object.assign({}, process.env, { PORT: String(port) }) });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    for (const q of ['days=7&market=closed', 'days=1&market=open']) {
      const body = await (await fetch(`http://127.0.0.1:${port}/data?${q}`)).json();
      assert.deepEqual(body.holdings.map(x => x.symbol), ['AAPL', 'ASML', 'MSFT', 'NESN', 'NOVN']);
      for (const x of body.holdings) {
        assert.deepEqual(Object.keys(x).sort(), ['currency', 'name', 'quote', 'symbol']);
        assert.ok(x.quote.points.length > 10);
      }
      const now = Date.now(), live = body.holdings.some(x => now >= x.quote.session[0] && now <= x.quote.session[1]);
      assert.equal(live, q.includes('open'));
    }
  } finally { child.kill(); }
});
