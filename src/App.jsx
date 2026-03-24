import { useEffect, useMemo, useState } from "react";

function parseCSV(text) {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.toLowerCase().includes("date"))
    .map(line => {
      const parts = line.split(/[,\t]/);

      const date = parts[0]?.trim().replace(/\//g, "-");
      const close = Number(parts[1]);

      return { date, close };
    })
    .filter(x => x.date && !isNaN(x.close))
    .sort((a,b)=> new Date(a.date)-new Date(b.date));
}

function toCsvText(rows) {
  const header = "Date,Close";
  const body = rows.map((r) => `${r.date},${r.close}`).join("\n");
  return body ? `${header}\n${body}` : `${header}\n`;
}

function mergeRows(existingRows, newRows) {
  const map = new Map();
  [...existingRows, ...newRows].forEach((row) => {
    if (row?.date && Number.isFinite(row?.close)) map.set(row.date, { date: row.date, close: row.close });
  });
  return Array.from(map.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function getWeekKey(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-${week}`;
}

function toWeekly(data) {
  const map = {};
  data.forEach((d) => {
    map[getWeekKey(d.date)] = { date: d.date, close: d.close };
  });
  return Object.values(map).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function rsi(closes, period) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function solvePrice(base, period, target) {
  if (!base.length || base.length < period + 1) return null;

  let low = Math.max(0.01, base[base.length - 1] * 0.2);
  let high = base[base.length - 1] * 3;

  const getRsi = (p) => rsi([...base, p], period);
  let lowRsi = getRsi(low);
  let highRsi = getRsi(high);

  let expandCount = 0;
  while ((lowRsi === null || highRsi === null || target < lowRsi || target > highRsi) && expandCount < 20) {
    low *= 0.7;
    high *= 1.3;
    lowRsi = getRsi(low);
    highRsi = getRsi(high);
    expandCount += 1;
  }

  if (lowRsi === null || highRsi === null || target < lowRsi || target > highRsi) return null;

  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    const val = getRsi(mid);
    if (val === null) return null;
    if (val > target) high = mid;
    else low = mid;
  }

  return Number(((low + high) / 2).toFixed(2));
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function weeklyReturns(weeklyRows) {
  const out = [];
  for (let i = 1; i < weeklyRows.length; i++) {
    const prev = weeklyRows[i - 1].close;
    const curr = weeklyRows[i].close;
    if (prev > 0) out.push(curr / prev - 1);
  }
  return out;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (s[base + 1] !== undefined) return s[base] + rest * (s[base + 1] - s[base]);
  return s[base];
}

function estimateTQQQFromQQQTarget(qqqWeeklyRows, tqqqWeeklyRows, qqqTargetPrice) {
  if (!qqqWeeklyRows.length || !tqqqWeeklyRows.length || qqqTargetPrice == null) return null;
  const lastQQQ = qqqWeeklyRows[qqqWeeklyRows.length - 1]?.close;
  const lastTQQQ = tqqqWeeklyRows[tqqqWeeklyRows.length - 1]?.close;
  if (!lastQQQ || !lastTQQQ) return null;

  const targetQqqReturn = qqqTargetPrice / lastQQQ - 1;
  const qqqRets = weeklyReturns(qqqWeeklyRows);
  const tqqqRets = weeklyReturns(tqqqWeeklyRows);
  const len = Math.min(qqqRets.length, tqqqRets.length, 26);

  if (len < 8) {
    const simple = lastTQQQ * (1 + targetQqqReturn * 3);
    return {
      center: Number(simple.toFixed(2)),
      low: Number((simple * 0.97).toFixed(2)),
      high: Number((simple * 1.03).toFixed(2)),
      beta: 3,
    };
  }

  const pairs = [];
  for (let i = qqqRets.length - len, j = tqqqRets.length - len; i < qqqRets.length && j < tqqqRets.length; i++, j++) {
    pairs.push({ q: qqqRets[i], t: tqqqRets[j] });
  }

  const betas = pairs.filter((p) => Math.abs(p.q) > 1e-9).map((p) => p.t / p.q).filter((x) => Number.isFinite(x));
  const betaMid = median(betas) ?? 3;
  const betaLow = quantile(betas, 0.2) ?? Math.max(2.4, betaMid - 0.5);
  const betaHigh = quantile(betas, 0.8) ?? Math.min(3.6, betaMid + 0.5);

  const centerRet = betaMid * targetQqqReturn;
  const lowRet = betaLow * targetQqqReturn;
  const highRet = betaHigh * targetQqqReturn;

  const rawA = lastTQQQ * (1 + lowRet);
  const rawB = lastTQQQ * (1 + highRet);
  return {
    center: Number((lastTQQQ * (1 + centerRet)).toFixed(2)),
    low: Number(Math.min(rawA, rawB).toFixed(2)),
    high: Number(Math.max(rawA, rawB).toFixed(2)),
    beta: Number(betaMid.toFixed(2)),
  };
}

const qqqSample = `Date,Close
2024-01-02,409.52
2024-01-03,403.72
2024-01-04,401.74
2024-01-05,405.99
2024-01-08,412.60
2024-01-09,411.45
2024-01-10,414.42
2024-01-11,417.35
2024-01-12,418.23`;

const tqqqSample = `Date,Close
2024-01-02,51.82
2024-01-03,49.57
2024-01-04,48.86
2024-01-05,50.62
2024-01-08,53.13
2024-01-09,52.68
2024-01-10,53.79
2024-01-11,54.92
2024-01-12,55.31`;

const qqqStorageKey = "qqq-rsi-tool-qqq";
const tqqqStorageKey = "qqq-rsi-tool-tqqq";
const periodStorageKey = "qqq-rsi-tool-period";

function DataBox({ title, value, onChange, onAppend, placeholder }) {
  return (
    <div>
      <h3 style={{ marginBottom: 8 }}>{title}</h3>
      <textarea
        rows={12}
        style={{ width: "100%", fontFamily: "monospace", padding: 10, borderRadius: 8, border: "1px solid #ccc" }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <div style={{ marginTop: 8, fontSize: 13, color: "#666" }}>
        아래 한 줄 추가 기능을 쓰면 기존 데이터는 유지되고, 같은 날짜는 자동 덮어쓴다.
      </div>
      <AppendRowForm onAppend={onAppend} />
    </div>
  );
}

function AppendRowForm({ onAppend }) {
  const [date, setDate] = useState("");
  const [close, setClose] = useState("");

  return (
    <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
      <input type="number" step="0.01" value={close} onChange={(e) => setClose(e.target.value)} placeholder="Close" style={inputStyle} />
      <button
        onClick={() => {
          if (!date || !close) return;
          onAppend([{ date, close: Number(close) }]);
          setDate("");
          setClose("");
        }}
        style={buttonStyle}
      >
        날짜 추가
      </button>
    </div>
  );
}

export default function App() {
  const [qqqCsv, setQqqCsv] = useState(() => localStorage.getItem(qqqStorageKey) || qqqSample);
  const [tqqqCsv, setTqqqCsv] = useState(() => localStorage.getItem(tqqqStorageKey) || tqqqSample);
  const [period, setPeriod] = useState(() => Number(localStorage.getItem(periodStorageKey)) || 23);

  useEffect(() => {
    localStorage.setItem(qqqStorageKey, qqqCsv);
  }, [qqqCsv]);

  useEffect(() => {
    localStorage.setItem(tqqqStorageKey, tqqqCsv);
  }, [tqqqCsv]);

  useEffect(() => {
    localStorage.setItem(periodStorageKey, String(period));
  }, [period]);

  const targets = Array.from({ length: 17 }, (_, i) => 10 + i * 5).reverse();

  const qqqDaily = useMemo(() => parseCSV(qqqCsv), [qqqCsv]);
  const tqqqDaily = useMemo(() => parseCSV(tqqqCsv), [tqqqCsv]);
  const qqqWeeklyRows = useMemo(() => toWeekly(qqqDaily), [qqqDaily]);
  const tqqqWeeklyRows = useMemo(() => toWeekly(tqqqDaily), [tqqqDaily]);
  const qqqWeeklyCloses = useMemo(() => qqqWeeklyRows.map((x) => x.close), [qqqWeeklyRows]);
  const currentQqqRsi = useMemo(() => rsi(qqqWeeklyCloses, period), [qqqWeeklyCloses, period]);

  const rows = useMemo(() => {
    return targets.map((target) => {
      const qqqTarget = solvePrice(qqqWeeklyCloses, period, target);
      const tqqqEstimate = estimateTQQQFromQQQTarget(qqqWeeklyRows, tqqqWeeklyRows, qqqTarget);
      return {
        target,
        qqqTarget,
        tqqqCenter: tqqqEstimate?.center ?? null,
        tqqqLow: tqqqEstimate?.low ?? null,
        tqqqHigh: tqqqEstimate?.high ?? null,
      };
    });
  }, [targets, qqqWeeklyCloses, qqqWeeklyRows, tqqqWeeklyRows, period]);

  const lastQQQ = qqqDaily[qqqDaily.length - 1]?.close ?? null;
  const lastTQQQ = tqqqDaily[tqqqDaily.length - 1]?.close ?? null;
  const betaInfo = useMemo(() => estimateTQQQFromQQQTarget(qqqWeeklyRows, tqqqWeeklyRows, lastQQQ), [qqqWeeklyRows, tqqqWeeklyRows, lastQQQ]);

  const appendQqqRows = (newRows) => setQqqCsv(toCsvText(mergeRows(qqqDaily, newRows)));
  const appendTqqqRows = (newRows) => setTqqqCsv(toCsvText(mergeRows(tqqqDaily, newRows)));

  return (
    <div style={{ padding: 16, maxWidth: 1180, margin: "auto", fontFamily: "Arial, sans-serif" }}>
      <h2 style={{ marginBottom: 8 }}>QQQ → TQQQ RSI 목표가 추정기</h2>
      <p style={{ color: "#555", lineHeight: 1.5, marginTop: 0 }}>
        한 번 넣은 데이터는 브라우저에 저장된다. 다음엔 전체를 다시 붙여넣지 않고 새 날짜만 추가해도 된다. 같은 날짜를 다시 넣으면 자동으로 최신 값으로 덮어쓴다.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <button onClick={() => setQqqCsv(toCsvText(qqqDaily))} style={buttonStyle}>QQQ 정렬/정리</button>
        <button onClick={() => setTqqqCsv(toCsvText(tqqqDaily))} style={buttonStyle}>TQQQ 정렬/정리</button>
        <button onClick={() => { localStorage.clear(); setQqqCsv(qqqSample); setTqqqCsv(tqqqSample); setPeriod(23); }} style={dangerButtonStyle}>저장 데이터 초기화</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <DataBox
          title="QQQ 일봉 데이터"
          value={qqqCsv}
          onChange={setQqqCsv}
          onAppend={appendQqqRows}
          placeholder="Date,Close"
        />
        <DataBox
          title="TQQQ 일봉 데이터"
          value={tqqqCsv}
          onChange={setTqqqCsv}
          onAppend={appendTqqqRows}
          placeholder="Date,Close"
        />
      </div>

      <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label>
          RSI 기간:
          <input
            type="number"
            value={period}
            onChange={(e) => setPeriod(Math.max(1, Number(e.target.value) || 1))}
            style={{ marginLeft: 8, width: 80, ...inputStyle }}
          />
        </label>
        <div>현재 QQQ 종가: <strong>{formatNumber(lastQQQ)}</strong></div>
        <div>현재 TQQQ 종가: <strong>{formatNumber(lastTQQQ)}</strong></div>
        <div>현재 QQQ RSI: <strong>{formatNumber(currentQqqRsi)}</strong></div>
        <div>최근 추정 배수 중앙값: <strong>{formatNumber(betaInfo?.beta)}</strong></div>
      </div>

      <div style={{ marginTop: 20, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
          <thead>
            <tr style={{ background: "#f4f4f4" }}>
              <th style={thStyle}>QQQ 목표 RSI</th>
              <th style={thStyle}>QQQ 목표가</th>
              <th style={thStyle}>TQQQ 중심 추정가</th>
              <th style={thStyle}>TQQQ 하단</th>
              <th style={thStyle}>TQQQ 상단</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.target}>
                <td style={tdStyle}>{row.target}</td>
                <td style={tdStyle}>{formatNumber(row.qqqTarget)}</td>
                <td style={tdStyle}>{formatNumber(row.tqqqCenter)}</td>
                <td style={tdStyle}>{formatNumber(row.tqqqLow)}</td>
                <td style={tdStyle}>{formatNumber(row.tqqqHigh)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 18, padding: 12, background: "#fafafa", border: "1px solid #e5e5e5", borderRadius: 8, lineHeight: 1.55 }}>
        <div><strong>폰에서 보기</strong></div>
        <div style={{ marginTop: 6, color: "#555" }}>
          이 앱은 반응형으로 바꿔놔서 배포만 하면 폰 브라우저에서도 볼 수 있다. 가장 쉬운 방법은 Vercel이나 Netlify에 올리는 거다. 한 번 배포하면 휴대폰에서 주소만 열면 된다.
        </div>
      </div>
    </div>
  );
}

const thStyle = {
  border: "1px solid #ddd",
  padding: "10px 8px",
  textAlign: "center",
};

const tdStyle = {
  border: "1px solid #ddd",
  padding: "8px",
  textAlign: "center",
};

const inputStyle = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid #ccc",
};

const buttonStyle = {
  padding: "9px 12px",
  borderRadius: 8,
  border: "1px solid #777",
  background: "#f3f4f6",
  color: "#111827",
  fontWeight: 600,
  cursor: "pointer",
};

const dangerButtonStyle = {
  ...buttonStyle,
  border: "1px solid #b91c1c",
  background: "#fef2f2",
  color: "#991b1b",
};
