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
  SKHYNIX: "000660.KS",
  ANET: "ANET",
  AMKR: "AMKR",
  AMAT: "AMAT",
  COHR: "COHR",
  ALAB: "ALAB",
  VST: "VST",
  CEG: "CEG",
  ETN: "ETN",
  VRT: "VRT",
  NOW: "NOW",
  DDOG: "DDOG"
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

const signedPct = (value) => {
  const n = round(value, 1);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n}%`;
};

const crossed = (previous, current, previousAverage, currentAverage) => {
  if (![previous, current, previousAverage, currentAverage].every(Number.isFinite)) return 0;
  if (previous <= previousAverage && current > currentAverage) return 1;
  if (previous >= previousAverage && current < currentAverage) return -1;
  return 0;
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
    // 行情源偶尔会在停牌、公司行动或接口抖动时返回 0。零价会制造
    // -100% 假信号并污染均线，因此必须在任何计算前剔除。
    if (!Number.isFinite(close) || close <= 0) continue;
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
  const previousCloses = fullCloses.slice(0, -1);

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
    previous_ma20: round(average(previousCloses, 20), 2),
    previous_ma50: round(average(previousCloses, 50), 2),
    previous_ma200: previousCloses.length >= 200 ? round(average(previousCloses, 200), 2) : null,
    amp5: amplitude(fullCloses, 5),
    amp20: amplitude(fullCloses, 20),
    peak20: round(peak20, 2),
    dd_from_peak20: change(latest.close, peak20),
    dates: recent.map((point) => point.date),
    closes: recent.map((point) => round(point.close, 4)),
    source: "Yahoo Finance chart"
  };
}

function buildDailyBrief(allQuotes) {
  const allRows = Object.values(allQuotes).filter((quote) =>
    Number.isFinite(Number(quote.last)) && Number.isFinite(Number(quote.chg_pct))
  );
  const suspicious = allRows.filter((quote) => Math.abs(Number(quote.chg_pct)) > 35);
  const rows = allRows.filter((quote) => Math.abs(Number(quote.chg_pct)) <= 35);
  if (!rows.length) return null;

  const dates = rows.map((quote) => quote.asof).filter(Boolean).sort();
  const previousDates = rows.map((quote) => quote.dates?.at(-2)).filter(Boolean).sort();
  const date = dates.at(-1);
  const previousDate = previousDates.at(-1) || "";
  const up = rows.filter((quote) => Number(quote.chg_pct) > 0.05).length;
  const down = rows.filter((quote) => Number(quote.chg_pct) < -0.05).length;
  const flat = rows.length - up - down;
  const averageChange = rows.reduce((sum, quote) => sum + Number(quote.chg_pct), 0) / rows.length;
  const sorted = rows.slice().sort((a, b) => Number(b.chg_pct) - Number(a.chg_pct));
  const leader = sorted[0];
  const laggard = sorted.at(-1);
  const candidates = [];

  rows.forEach((quote) => {
    const ticker = quote.ticker;
    const dailyMove = Number(quote.chg_pct);
    const cross200 = crossed(Number(quote.previous_close), Number(quote.last), Number(quote.previous_ma200), Number(quote.ma200));
    const cross50 = crossed(Number(quote.previous_close), Number(quote.last), Number(quote.previous_ma50), Number(quote.ma50));
    const cross20 = crossed(Number(quote.previous_close), Number(quote.last), Number(quote.previous_ma20), Number(quote.ma20));

    if (cross200) {
      candidates.push({
        tag: cross200 > 0 ? "趋势" : "风险",
        priority: "高",
        score: 100,
        tickers: [ticker],
        text: `${ticker} ${cross200 > 0 ? "上穿" : "跌破"} MA200，长期趋势状态发生变化；收盘 ${quote.last}，距 MA200 ${signedPct((quote.last / quote.ma200 - 1) * 100)}。`
      });
    } else if (cross50) {
      candidates.push({
        tag: cross50 > 0 ? "趋势" : "风险",
        priority: "中",
        score: 82,
        tickers: [ticker],
        text: `${ticker} ${cross50 > 0 ? "上穿" : "跌破"} MA50，中期动能转${cross50 > 0 ? "强" : "弱"}；单日 ${signedPct(dailyMove)}。`
      });
    } else if (cross20) {
      candidates.push({
        tag: "趋势",
        priority: "观察",
        score: 58,
        tickers: [ticker],
        text: `${ticker} ${cross20 > 0 ? "上穿" : "跌破"} MA20，短线动能${cross20 > 0 ? "改善" : "走弱"}；需结合基本面确认。`
      });
    }

    if (Math.abs(dailyMove) >= 4) {
      candidates.push({
        tag: dailyMove > 0 ? "异动" : "风险",
        priority: Math.abs(dailyMove) >= 6 ? "高" : "中",
        score: 70 + Math.abs(dailyMove),
        tickers: [ticker],
        text: `${ticker} 单日 ${signedPct(dailyMove)}，属于覆盖池显著异动；20 日回报 ${signedPct(quote.ret20)}，距 20 日高点 ${signedPct(quote.dd_from_peak20)}。`
      });
    }

    const currentInMa50Zone = Number.isFinite(Number(quote.ma50)) &&
      quote.last >= quote.ma50 * 0.98 && quote.last <= quote.ma50 * 1.03;
    const previousInMa50Zone = Number.isFinite(Number(quote.previous_ma50)) &&
      quote.previous_close >= quote.previous_ma50 * 0.98 && quote.previous_close <= quote.previous_ma50 * 1.03;
    if (currentInMa50Zone && !previousInMa50Zone) {
      candidates.push({
        tag: "机会",
        priority: "中",
        score: 76,
        tickers: [ticker],
        text: `${ticker} 新进入 MA50 技术观察区（±3%）；这不是自动买入信号，需再核对 EPS 与估值安全边际。`
      });
    }
  });

  const deduped = [];
  const seen = new Set();
  candidates.sort((a, b) => b.score - a.score).forEach((item) => {
    const key = `${item.tag}:${item.tickers.join(",")}`;
    if (seen.has(key) || deduped.length >= 5) return;
    seen.add(key);
    const { score, ...publicItem } = item;
    deduped.push(publicItem);
  });

  const items = [];
  if (suspicious.length) {
    items.push({
      tag: "数据校验",
      priority: "高",
      tickers: suspicious.map((quote) => quote.ticker),
      text: `${suspicious.map((quote) => `${quote.ticker} ${signedPct(quote.chg_pct)}`).join("、")} 超过单日 ±35% 质量阈值，已从市场宽度与交易信号中隔离，等待人工核验。`
    });
  }
  items.push({
    tag: "市场宽度",
    priority: Math.abs(averageChange) >= 1.5 ? "中" : "观察",
    tickers: [],
    text: `覆盖 ${rows.length} 个标的：${up} 涨 / ${down} 跌 / ${flat} 平，等权平均 ${signedPct(averageChange)}；领涨 ${leader.ticker} ${signedPct(leader.chg_pct)}，领跌 ${laggard.ticker} ${signedPct(laggard.chg_pct)}。`
  }, ...deduped);

  if (deduped.length === 0) {
    items.push({
      tag: "结论",
      priority: "观察",
      tickers: [leader.ticker, laggard.ticker],
      text: "今日未出现 ≥4% 异动、MA20/50/200 穿越或新进入 MA50 观察区；暂未形成需要升级仓位动作的价格信号。"
    });
  }

  return {
    id: `market-${date}`,
    date,
    previous_date: previousDate,
    generated_at: new Date().toISOString(),
    title: "今日关键变化",
    summary: `${up} 涨 / ${down} 跌 · ${deduped.filter((item) => item.priority === "高").length} 个高优先级变化`,
    scope_note: "基于最新可用收盘、涨跌幅与均线穿越自动生成；不包含未经更新的新闻、财报或 13F。",
    source: "Yahoo Finance chart",
    coverage: { total: rows.length, up, down, flat, average_change_pct: round(averageChange, 2) },
    items
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
const dailyBrief = buildDailyBrief(quotes);
const payload = {
  schema_version: 1,
  status: failures.length ? "partial" : "ok",
  generated_at: new Date().toISOString(),
  quote_asof: quoteAsOf,
  source: "Yahoo Finance chart · latest available daily close",
  source_url: "https://finance.yahoo.com/",
  update_scope: "价格、涨跌、均线、回撤、买入区间与价格型交易状态；不自动改写研究信号、新闻、财报判断或 13F",
  daily_brief: dailyBrief,
  quotes,
  failures
};

const outputPath = path.resolve("assets/market-latest.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), outputPath)} with ${Object.keys(quotes).length} quotes as of ${quoteAsOf}`);
