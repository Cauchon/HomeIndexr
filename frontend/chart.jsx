// SVG chart for property detail page.
// AVM vendors stay as continuous monthly lines; Realtor market history renders
// as dated event markers so list/sale events do not imply continuous prices.

const { useState: useState_chart, useMemo: useMemo_chart, useRef: useRef_chart, useEffect: useEffect_chart } = React;

const VENDOR_STYLES = {
  "Cotality™": { color: "var(--accent)", dash: null },
  "Quantarium": { color: "var(--pos)", dash: "5 3" },
};

const EVENT_STYLES = {
  listed: { label: "Listed", color: "var(--info)", fill: "var(--info)" },
  sold: { label: "Sold", color: "var(--pos)", fill: "var(--pos)" },
  price: { label: "Price changed", color: "var(--warn)", fill: "var(--bg-elev)" },
  relisted: { label: "Relisted", color: "var(--accent)", fill: "var(--bg-elev)" },
  removed: { label: "Removed", color: "var(--text-muted)", fill: "var(--bg-elev)" },
  rent: { label: "Rent event", color: "var(--info)", fill: "var(--bg-elev)" },
  other: { label: "Event", color: "var(--text-muted)", fill: "var(--bg-elev)" },
};

function _toMs(dateStr) {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
}

function _monthCenter(yearMonthStr) {
  const [y, m] = yearMonthStr.split("-").map(Number);
  return Date.UTC(y, m - 1, 15, 12, 0, 0);
}

function _monthLabel(monthX) {
  return new Date(monthX).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function _eventKind(name) {
  const s = (name || "").toLowerCase();
  if (s.includes("sold")) return "sold";
  if (s.includes("price")) return "price";
  if (s.includes("relisted")) return "relisted";
  if (s.includes("removed")) return "removed";
  if (s.includes("rent")) return "rent";
  if (s.includes("listed")) return "listed";
  return "other";
}

function _yearMonthFromMs(t) {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function PriceChart({ snapshots, historical = [], events = [], height = 280 }) {
  const containerRef = useRef_chart(null);
  const [w, setW] = useState_chart(720);
  const [hover, setHover] = useState_chart(null);

  useEffect_chart(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.floor(e.contentRect.width));
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const monthlySeries = useMemo_chart(() => {
    const bySrc = new Map();
    const add = (date, source, value) => {
      if (!date || !source || value == null) return;
      const t = _toMs(date);
      if (t == null) return;
      const month = date.slice(0, 7);
      if (!bySrc.has(source)) bySrc.set(source, new Map());
      const m = bySrc.get(source);
      const prev = m.get(month);
      if (!prev || t > prev.t) m.set(month, { t, v: value });
    };
    for (const h of historical || []) add(h.date, h.source, h.estimate);
    for (const s of snapshots || []) {
      if (Array.isArray(s.all_estimates) && s.all_estimates.length) {
        for (const e of s.all_estimates) add(e.date, e.source, e.estimate);
      } else {
        add(s.estimate_date, s.estimate_source, s.best_current_estimate);
      }
    }
    return Array.from(bySrc.entries())
      .map(([source, monthMap]) => ({
        source,
        points: Array.from(monthMap.entries())
          .map(([month, p]) => ({ monthX: _monthCenter(month), month, v: p.v }))
          .sort((a, b) => a.monthX - b.monthX),
      }))
      .filter((s) => s.points.length);
  }, [snapshots, historical]);

  const marketEvents = useMemo_chart(() => {
    const seen = new Set();
    return (events || [])
      .map((e) => ({
        ...e,
        t: _toMs(e.date),
        kind: _eventKind(e.event_name),
      }))
      .filter((e) => {
        if (e.t == null || e.price == null) return false;
        const key = `${e.date}|${e.event_name}|${e.price}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.t - b.t);
  }, [events]);

  const monthXs = useMemo_chart(() => {
    const set = new Set();
    monthlySeries.forEach((s) => s.points.forEach((p) => set.add(p.monthX)));
    return [...set].sort((a, b) => a - b);
  }, [monthlySeries]);

  const padding = { l: 56, r: 16, t: 14, b: 28 };
  const innerW = Math.max(60, w - padding.l - padding.r);
  const innerH = height - padding.t - padding.b;

  const eventXs = marketEvents.map((e) => e.t);
  const xs = [...monthXs, ...eventXs];
  const allYs = [];
  monthlySeries.forEach((s) => s.points.forEach((p) => allYs.push(p.v)));
  marketEvents.forEach((e) => allYs.push(e.price));

  if (!xs.length || !allYs.length) {
    return <div ref={containerRef} className="empty" style={{ height }}>No timeline data yet.</div>;
  }

  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xRange = xMax - xMin || 1;
  let yMin = Math.min(...allYs);
  let yMax = Math.max(...allYs);
  const ySpan = yMax - yMin || 1;
  yMin -= ySpan * 0.08;
  yMax += ySpan * 0.08;

  const xScale = (t) => padding.l + ((t - xMin) / xRange) * innerW;
  const yScale = (v) => padding.t + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const yTicks = [];
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    yTicks.push(yMin + ((yMax - yMin) * i) / tickCount);
  }
  const xTickCount = Math.min(6, Math.max(2, xs.length));
  const xTicks = [];
  for (let i = 0; i < xTickCount; i++) {
    const t = xMin + ((xMax - xMin) * i) / (xTickCount - 1 || 1);
    xTicks.push(t);
  }

  const onMouseMove = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < padding.l || mx > w - padding.r) { setHover(null); return; }
    const choices = [...monthXs, ...eventXs];
    if (!choices.length) { setHover(null); return; }
    let nearestX = choices[0], nd = Infinity;
    for (const t of choices) {
      const d = Math.abs(xScale(t) - mx);
      if (d < nd) { nd = d; nearestX = t; }
    }
    setHover({ t: nearestX });
  };

  const hoverMonth = hover ? _yearMonthFromMs(hover.t) : null;
  const hoverRows = hover
    ? monthlySeries.map((s) => ({
        source: s.source,
        point: s.points.find((p) => p.month === hoverMonth) || null,
      }))
    : [];
  const hoverEvents = hover
    ? marketEvents.filter((e) => e.date && e.date.slice(0, 7) === hoverMonth)
    : [];

  return (
    <div ref={containerRef} className="chart-wrap" style={{ width: "100%" }}>
      <svg width={w} height={height} onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)}>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padding.l} x2={w - padding.r} y1={yScale(v)} y2={yScale(v)} stroke="var(--border)" strokeDasharray="2 3" />
            <text x={padding.l - 8} y={yScale(v) + 3} fontSize="10" textAnchor="end" fill="var(--text-faint)" style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmt.usd(Math.round(v / 1000) * 1000, { compact: true })}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={xScale(t)} y={height - 8} fontSize="10" textAnchor="middle" fill="var(--text-faint)">
            {_monthLabel(t)}
          </text>
        ))}

        {monthlySeries.map((s) => {
          const style = VENDOR_STYLES[s.source] || { color: "var(--text-muted)", dash: null };
          const d = s.points.map((p, i) =>
            (i ? "L" : "M") + xScale(p.monthX).toFixed(1) + " " + yScale(p.v).toFixed(1)
          ).join(" ");
          return (
            <g key={s.source}>
              <path
                d={d}
                fill="none"
                stroke={style.color}
                strokeWidth="1.75"
                strokeDasharray={style.dash || undefined}
                opacity={0.95}
              />
              {s.points.map((p, i) => (
                <circle key={i} cx={xScale(p.monthX)} cy={yScale(p.v)} r="2.5" fill={style.color} />
              ))}
            </g>
          );
        })}

        {marketEvents.map((e, i) => {
          const style = EVENT_STYLES[e.kind] || EVENT_STYLES.other;
          const r = e.kind === "sold" ? 5 : 4;
          return (
            <g key={`${e.date}-${e.event_name}-${e.price}-${i}`}>
              <line x1={xScale(e.t)} x2={xScale(e.t)} y1={padding.t} y2={height - padding.b} stroke={style.color} strokeWidth="1" strokeDasharray="2 4" opacity="0.28" />
              <circle cx={xScale(e.t)} cy={yScale(e.price)} r={r} fill={style.fill} stroke={style.color} strokeWidth="2" />
            </g>
          );
        })}

        {hover && (
          <g>
            <line x1={xScale(hover.t)} x2={xScale(hover.t)} y1={padding.t} y2={height - padding.b} stroke="var(--border-strong)" strokeWidth="1" />
            {hoverRows.filter((r) => r.point).map(({ source, point }) => {
              const style = VENDOR_STYLES[source] || { color: "var(--text-muted)" };
              return (
                <circle key={source} cx={xScale(point.monthX)} cy={yScale(point.v)} r="4" fill={style.color} stroke="var(--bg-elev)" strokeWidth="2" />
              );
            })}
            {hoverEvents.map((e, i) => {
              const style = EVENT_STYLES[e.kind] || EVENT_STYLES.other;
              return (
                <circle key={`${e.date}-${e.event_name}-${i}`} cx={xScale(e.t)} cy={yScale(e.price)} r="6" fill="transparent" stroke={style.color} strokeWidth="1.5" />
              );
            })}
          </g>
        )}
      </svg>

      {hover && (hoverRows.some((r) => r.point) || hoverEvents.length > 0) && (
        <div style={{
          position: "absolute",
          left: Math.min(w - 240, Math.max(8, xScale(hover.t) + 12)),
          top: 10,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-md)",
          borderRadius: "6px",
          padding: "8px 10px",
          fontSize: "11px",
          pointerEvents: "none",
          minWidth: "220px",
          zIndex: 2,
        }}>
          <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>{_monthLabel(hover.t)}</div>
          {hoverRows.map(({ source, point }) => {
            const style = VENDOR_STYLES[source] || { color: "var(--text-muted)" };
            return (
              <div key={source} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ color: style.color }}>{source}</span>
                <span className="mono" style={{ fontWeight: 500 }}>
                  {point ? fmt.usd(point.v) : <span style={{ color: "var(--text-faint)" }}>—</span>}
                </span>
              </div>
            );
          })}
          {hoverEvents.map((e, i) => {
            const style = EVENT_STYLES[e.kind] || EVENT_STYLES.other;
            return (
              <div key={`${e.date}-${e.event_name}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 4, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
                <span style={{ color: style.color }}>{e.event_name}</span>
                <span className="mono" style={{ fontWeight: 500 }}>{fmt.usd(e.price)}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="chart-legend" style={{ marginTop: 8 }}>
        {monthlySeries.map((s) => {
          const style = VENDOR_STYLES[s.source] || { color: "var(--text-muted)", dash: null };
          return (
            <span key={s.source} className="item">
              <span
                className="swatch"
                style={{
                  background: "transparent",
                  borderTop: `2px ${style.dash ? "dashed" : "solid"} ${style.color}`,
                  width: 14, height: 0, marginRight: 4,
                }}
              />
              {s.source}
            </span>
          );
        })}
        <span className="item"><span className="swatch dot" style={{ background: "var(--info)" }} /> Listed</span>
        <span className="item"><span className="swatch dot" style={{ background: "var(--pos)" }} /> Sold</span>
        <span className="item"><span className="swatch dot" style={{ background: "var(--bg-elev)", border: "2px solid var(--warn)" }} /> Price change</span>
      </div>
    </div>
  );
}

window.PriceChart = PriceChart;
