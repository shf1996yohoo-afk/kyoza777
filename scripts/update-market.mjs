import fs from "node:fs";
import path from "node:path";

const symbols = {
  NVDA: "NVDA",
  AMD: "AMD",
  TSM: "TSM",
  ASML: "ASML",
  MU: "MU",
  AVGO: "AVGO",
  QCOM: "QCOM",
  AMZN: "AMZN",
  MSFT: "MSFT",
  SKHYNIX: "000660.KS"
};

const round = (value, digits = 2) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
};

const average = (values, count) => {
  const rows = values.slice(-count);
  if (!rows.length) return null;
  return rows.reduce((sum, value) => sum + value, 0) / rows.length;
};

const change = (last, previous) => {
  if (!Number.isFinite(last) || !Number.isFinite(previous) || previous === 0) return null;
  return round((last / previous - 1) * 100, 2);
};

const amplitude = (values, count) => {
  const rows = values.slice(-count);
  if (rows.length < 2) return null;
  const low = Math.min(...rows);
  const high = Math.max(...rows);
  return low > 0 ? round((high / low - 1) * 100, 1) : null;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchChart(marketSymbol) {
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(marketSymbol)}?range=1y&interval=1d&events=div%2Csplits`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          "User-Agent": "Mozilla/5.0 AI-chain-dashboard-market-refresh/1.0",
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(attempt * 900);
    }
  }
  throw lastError;
}

function normalizeChart(ticker, marketSymbol, json) {
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const rawCloses = result?.indicators?.adjclose?.[0]?.adjclose ||
    result?.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let index = 0; index < Math.min(timestamps.length, rawCloses.length); index++) {
    const close = Number(rawCloses[index]);
    if (!Number.isFinite(close)) continue;
    points.push({
      date: new Date(Number(timestamps[index]) * 1000).toISOString().slice(0, 10),
      close
    });
  }
  if (points.length < 20) throw new Error(`${ticker} only returned ${points.length} usable closes`);

  const fullCloses = points.map((point) => point.close);
  const latest = points.at(-1);
  const previous = points.at(-2);
  const monthStart = points.find((point) => point.date.slice(0, 7) === latest.date.slice(0, 7)) || points.at(-22);
  const peak20 = Math.max(...fullCloses.slice(-20));
  const recent = points.slice(-60);

  return {
    ticker,
    market_symbol: marketSymbol,
    currency: result?.meta?.currency || (marketSymbol.endsWith(".KS") ? "KRW" : "USD"),
    exchange: result?.meta?.exchangeName || "",
    asof: latest.date,
    last: round(latest.close, 2),
    previous_close: round(previous.close, 2),
    chg_pct: change(latest.close, previous.close),
    ret5: fullCloses.length > 5 ? change(latest.close, fullCloses.at(-6)) : null,
    ret20: fullCloses.length > 20 ? change(latest.close, fullCloses.at(-21)) : null,
    mtd_pct: monthStart ? change(latest.close, monthStart.close) : null,
    ma20: round(average(fullCloses, 20), 2),
    ma50: round(average(fullCloses, 50), 2),
    ma200: fullCloses.length >= 200 ? round(average(fullCloses, 200), 2) : null,
    amp5: amplitude(fullCloses, 5),
    amp20: amplitude(fullCloses, 20),
    peak20: round(peak20, 2),
    dd_from_peak20: change(latest.close, peak20),
    dates: recent.map((point) => point.date),
    closes: recent.map((point) => round(point.close, 4)),
    source: "Yahoo Finance chart"
  };
}

const quotes = {};
const failures = [];

for (const [ticker, marketSymbol] of Object.entries(symbols)) {
  try {
    const json = await fetchChart(marketSymbol);
    quotes[ticker] = normalizeChart(ticker, marketSymbol, json);
    console.log(`updated ${ticker} ${quotes[ticker].asof} ${quotes[ticker].last}`);
  } catch (error) {
    failures.push({ ticker, error: String(error?.message || error) });
    console.error(`failed ${ticker}: ${error?.message || error}`);
  }
}

if (Object.keys(quotes).length < 7) {
  throw new Error(`Only ${Object.keys(quotes).length} symbols updated; refusing to publish a partial market file.`);
}

const quoteAsOf = Object.values(quotes).map((quote) => quote.asof).sort().at(-1);
const payload = {
  schema_version: 1,
  status: failures.length ? "partial" : "ok",
  generated_at: new Date().toISOString(),
  quote_asof: quoteAsOf,
  source: "Yahoo Finance chart · latest available daily close",
  source_url: "https://finance.yahoo.com/",
  update_scope: "价格、涨跌、均线、回撤、买入区间与价格型交易状态；不自动改写研究信号、新闻、财报判断或 13F",
  quotes,
  failures
};

const outputPath = path.resolve("assets/market-latest.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), outputPath)} with ${Object.keys(quotes).length} quotes as of ${quoteAsOf}`);
