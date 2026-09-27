# Changelog

## 1.0.0 — first public release

- List the stocks, ETFs and funds held at Interactive Brokers, read from a Flex Web Service
  statement: an Open Positions query (authoritative), or holdings inferred from a Trades query.
- Yahoo Finance–style line per holding: the last 7 days bar by bar with a faint mark at each
  session start (default), or the current session with `days: 1`; dotted reference close,
  green above and red below.
- Last price in the listing currency and the change over the range; a change that rounds to
  zero is shown grey and unsigned.
- *Live* / *Closed* / *Stale* / *Offline* status; quotes refresh every 2 minutes while any
  holding's exchange is open, every 15 minutes otherwise.
- No quantity, value, cost basis or P&L leaves the node helper, reaches the browser or is
  written to disk.
- Flex token read from `~/.config/MMM-IBKRHoldings/credentials.json`, outside `config.js` and
  the module directory that MagicMirror serves to the LAN.
- Flex failures back off from 15 minutes to 6 hours, persisted across restarts, so IBKR's
  "too many failed attempts" lockout (1025) is not prolonged.
- Dependency-free runtime for Node 10 / Electron 16; demo with invented holdings and generated
  prices; `node --test` suite and GitHub Actions workflow.
