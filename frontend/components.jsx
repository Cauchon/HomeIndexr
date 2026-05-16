// Shared components and helpers for HomeTracker

const { useState, useEffect, useMemo, useRef, useCallback } = React;

// ---------- Icons (Lucide-style inline SVG) ----------
const Icon = ({ name, size = 14, ...rest }) => {
  const paths = {
    home: <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    refresh: <><path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" /><path d="M4 4v4.5H8.5" /><path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5" /><path d="M20 20v-4.5h-4.5" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
    filter: <><path d="M3 5h18l-7 9v6l-4 2v-8z" /></>,
    chevronRight: <path d="M9 6l6 6-6 6" />,
    chevronLeft: <path d="M15 6l-6 6 6 6" />,
    chevronDown: <path d="M6 9l6 6 6-6" />,
    arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
    arrowDown: <path d="M12 5v14M5 12l7 7 7-7" />,
    arrowUpRight: <><path d="M7 17L17 7" /><path d="M8 7h9v9" /></>,
    check: <path d="M5 12l5 5 9-12" />,
    x: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
    moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
    list: <><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></>,
    activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
    alert: <><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    map: <><path d="M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2z" /><path d="M9 4v14" /><path d="M15 6v14" /></>,
    code: <><path d="M16 18l6-6-6-6" /><path d="M8 6l-6 6 6 6" /></>,
    copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>,
    download: <><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></>,
    eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></>,
    bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
    play: <path d="M6 4l14 8-14 8z" />,
    menu: <><path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {paths[name] || null}
    </svg>
  );
};

// ---------- Formatters ----------
const fmt = {
  usd(n, opts = {}) {
    if (n == null) return "—";
    const compact = opts.compact;
    if (compact) {
      if (Math.abs(n) >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2).replace(/\.0+$/, "") + "M";
      if (Math.abs(n) >= 1_000) return "$" + Math.round(n / 1000) + "K";
    }
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  },
  delta(n) {
    if (n == null) return "—";
    const sign = n > 0 ? "+" : (n < 0 ? "−" : "");
    return sign + "$" + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  },
  pct(n) {
    if (n == null) return "—";
    const sign = n > 0 ? "+" : (n < 0 ? "−" : "");
    return sign + Math.abs(n * 100).toFixed(1) + "%";
  },
  date(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  },
  shortDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  },
  datetime(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " +
           d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  },
  relative(ts, now = Date.now()) {
    const diff = now - ts;
    const m = Math.round(diff / 60000);
    if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.round(d / 30);
    return `${mo}mo ago`;
  },
  num(n) {
    if (n == null) return "—";
    return n.toLocaleString("en-US");
  },
  baths(n) {
    if (n == null) return "—";
    return n % 1 === 0 ? n.toString() : n.toFixed(1);
  },
};

// ---------- Address split ----------
function splitAddress(addr) {
  // "123 Maple Ave, Austin, TX 78704"
  const m = addr.match(/^(.+?),\s*(.+?),\s*([A-Z]{2})\s*(\d{5})$/);
  if (!m) return { line1: addr, line2: "" };
  return { line1: m[1], line2: `${m[2]}, ${m[3]} ${m[4]}` };
}

function displayAddress(property) {
  return (property && (property.canonical_address || property.input_address)) || "";
}

// ---------- Status badge ----------
const STATUS_META = {
  matched:            { label: "Matched",   cls: "ok" },
  candidate_mismatch: { label: "Mismatch",  cls: "warn" },
  no_candidates:      { label: "No match",  cls: "neutral" },
  error:              { label: "Error",     cls: "err" },
};
const LISTING_META = {
  for_sale:   { label: "For sale",   cls: "info" },
  pending:    { label: "Pending",    cls: "warn" },
  sold:       { label: "Sold",       cls: "ok" },
  off_market: { label: "Off market", cls: "neutral" },
};

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.matched;
  return (
    <span className={`badge ${m.cls}`}>
      <span className="dot" />
      {m.label}
    </span>
  );
}
function ListingBadge({ state }) {
  const m = LISTING_META[state] || LISTING_META.off_market;
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

// ---------- Delta cell ----------
function DeltaCell({ value, base, mode = "bar" }) {
  if (value == null || base == null) {
    return <span className="faint">—</span>;
  }
  const diff = value - base;
  const pct = base ? diff / base : 0;
  const cls = Math.abs(pct) < 0.005 ? "flat" : (diff > 0 ? "pos" : "neg");
  // bar scale: max ±15% maps to full width
  const ratio = Math.max(-1, Math.min(1, pct / 0.15));
  const half = 28; // px, half width of 56
  const fillW = Math.abs(ratio) * half;
  const fillLeft = diff >= 0 ? "50%" : `calc(50% - ${fillW}px)`;
  return (
    <span className={`delta ${cls}`}>
      <span className="num">{fmt.delta(diff)} <span className="muted" style={{fontWeight: 400}}>({fmt.pct(pct)})</span></span>
      {mode === "bar" && (
        <span className="bar">
          <span className="fill" style={{ left: fillLeft, width: fillW + "px" }} />
        </span>
      )}
    </span>
  );
}

// ---------- Range pill ----------
function RangePill({ low, mid, high }) {
  return (
    <span className="range-pill">
      <span>{fmt.usd(low, { compact: true })}</span>
      <span className="mid">·</span>
      <span>{fmt.usd(high, { compact: true })}</span>
    </span>
  );
}

// ---------- Sortable Header ----------
function SortHeader({ label, k, sort, setSort, align = "left", style }) {
  const active = sort.key === k;
  return (
    <th
      style={{ textAlign: align, ...style }}
      onClick={() => setSort({ key: k, dir: active && sort.dir === "asc" ? "desc" : "asc" })}
    >
      {label}
      <span className="sort">{active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span>
    </th>
  );
}

// ---------- Toast ----------
const ToastContext = React.createContext(null);
function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((s) => [...s, { ...t, id }]);
    setTimeout(() => setToasts((s) => s.filter((x) => x.id !== id)), t.duration || 3000);
  }, []);
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind || ""}`}>
            <span className="icon">
              <Icon name={t.kind === "err" ? "alert" : (t.kind === "ok" ? "check" : "activity")} />
            </span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
function useToast() { return React.useContext(ToastContext); }

// ---------- JSON viewer with syntax color ----------
function JsonViewer({ data, maxHeight }) {
  const str = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const html = useMemo(() => {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"([^"\\]*(?:\\.[^"\\]*)*)"(\s*:)/g, '<span class="k">"$1"</span>$2')
      .replace(/: "([^"\\]*(?:\\.[^"\\]*)*)"/g, ': <span class="s">"$1"</span>')
      .replace(/: (true|false)/g, ': <span class="b">$1</span>')
      .replace(/: (null)/g, ': <span class="nul">$1</span>')
      .replace(/: (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g, ': <span class="n">$1</span>');
  }, [str]);
  return <pre className="json-viewer" style={{ maxHeight: maxHeight }} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------- Sparkline ----------
function Sparkline({ values, width = 60, height = 16, color }) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => [i * step, height - ((v - min) / range) * (height - 2) - 1]);
  const d = points.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path d={d} fill="none" stroke={color || "var(--accent)"} strokeWidth="1.25" />
    </svg>
  );
}

// ---------- Reduce / normalize helpers ----------
function bestEstimate(rawOrSnap) {
  // helper to demonstrate normalization on raw json
  const raw = rawOrSnap.raw_json || rawOrSnap;
  if (raw.current_estimates && raw.current_estimates.length) {
    const first = raw.current_estimates[0];
    return {
      best: first.estimate,
      source: first.source,
      low: first.estimate_low,
      high: first.estimate_high,
      date: first.date,
    };
  }
  if (raw.estimates && raw.estimates.currentValues && raw.estimates.currentValues.length) {
    const first = raw.estimates.currentValues[0];
    return {
      best: first.estimate,
      source: first.source,
      low: first.estimateLow,
      high: first.estimateHigh,
      date: first.date,
    };
  }
  return null;
}

// expose
Object.assign(window, {
  Icon, fmt, splitAddress, displayAddress,
  StatusBadge, ListingBadge, DeltaCell, RangePill, SortHeader,
  ToastProvider, useToast, JsonViewer, Sparkline, bestEstimate,
  STATUS_META, LISTING_META,
});
