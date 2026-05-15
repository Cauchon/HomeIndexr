// SVG chart for property detail page
// Renders: estimate line + optional low/high band, list price step, sale price point.

const { useState: useState_chart, useMemo: useMemo_chart, useRef: useRef_chart, useEffect: useEffect_chart } = React;

const VENDOR_STYLES = {
  "Cotality™": { color: "var(--accent)", dash: null },
  "Quantarium": { color: "var(--pos)", dash: "5 3" },
};

function _toMs(dateStr) {
  if (!dateStr) return null;
  // Parse YYYY-MM-DD as UTC noon to avoid TZ slippage
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
}

function PriceChart({ snapshots, historical = [], mode = "band", height = 280 }) {
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

  const data = useMemo_chart(() => {
    return [...snapshots]
      .filter((s) => s.fetched_at)
      .sort((a, b) => a.fetched_at - b.fetched_at);
  }, [snapshots]);

  const histSeries = useMemo_chart(() => {
    const bySrc = new Map();
    for (const r of historical || []) {
      const t = _toMs(r.date);
      if (t == null || r.estimate == null) continue;
      if (!bySrc.has(r.source)) bySrc.set(r.source, []);
      bySrc.get(r.source).push({ t, v: r.estimate });
    }
    return Array.from(bySrc.entries())
      .map(([source, pts]) => ({
        source,
        points: pts.sort((a, b) => a.t - b.t),
      }))
      .filter((s) => s.points.length >= 2);
  }, [historical]);

  const padding = { l: 56, r: 16, t: 14, b: 28 };
  const innerW = Math.max(60, w - padding.l - padding.r);
  const innerH = height - padding.t - padding.b;

  const xs = data.map((s) => s.fetched_at);
  const allYs = [];
  data.forEach((s) => {
    if (s.best_current_estimate != null) allYs.push(s.best_current_estimate);
    if (mode === "band") {
      if (s.estimate_low != null) allYs.push(s.estimate_low);
      if (s.estimate_high != null) allYs.push(s.estimate_high);
    }
    if (s.list_price != null) allYs.push(s.list_price);
    if (s.sold_price != null) allYs.push(s.sold_price);
  });
  histSeries.forEach((s) => {
    s.points.forEach((p) => {
      xs.push(p.t);
      allYs.push(p.v);
    });
  });

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

  // Y ticks
  const yTicks = [];
  const tickCount = 4;
  for (let i = 0; i <= tickCount; i++) {
    const v = yMin + ((yMax - yMin) * i) / tickCount;
    yTicks.push(v);
  }
  // X ticks: ~5 evenly spaced
  const xTickCount = Math.min(5, data.length);
  const xTicks = [];
  for (let i = 0; i < xTickCount; i++) {
    const t = xMin + ((xMax - xMin) * i) / (xTickCount - 1 || 1);
    xTicks.push(t);
  }

  // Build estimate path
  const estPts = data.filter((s) => s.best_current_estimate != null);
  const estPath = estPts.map((s, i) =>
    (i ? "L" : "M") + xScale(s.fetched_at).toFixed(1) + " " + yScale(s.best_current_estimate).toFixed(1)
  ).join(" ");

  // Band area (low / high)
  let bandPath = null;
  if (mode === "band") {
    const band = data.filter((s) => s.estimate_low != null && s.estimate_high != null);
    if (band.length >= 2) {
      const up = band.map((s, i) => (i ? "L" : "M") + xScale(s.fetched_at).toFixed(1) + " " + yScale(s.estimate_high).toFixed(1)).join(" ");
      const down = band.slice().reverse().map((s) => "L" + xScale(s.fetched_at).toFixed(1) + " " + yScale(s.estimate_low).toFixed(1)).join(" ");
      bandPath = `${up} ${down} Z`;
    }
  }

  // List price step path (only when present)
  const listPts = data.filter((s) => s.list_price != null);
  let listPath = "";
  for (let i = 0; i < listPts.length; i++) {
    const x = xScale(listPts[i].fetched_at);
    const y = yScale(listPts[i].list_price);
    if (i === 0) listPath += `M${x.toFixed(1)} ${y.toFixed(1)}`;
    else {
      const prevY = yScale(listPts[i - 1].list_price);
      listPath += ` L${x.toFixed(1)} ${prevY.toFixed(1)} L${x.toFixed(1)} ${y.toFixed(1)}`;
    }
  }

  const soldPts = data.filter((s) => s.sold_price != null);
  const soldEvent = soldPts.length ? soldPts[0] : null;

  // Hover handler: snap to nearest plotted point across snapshots + historical series
  const onMouseMove = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < padding.l || mx > w - padding.r) { setHover(null); return; }
    const candidates = [];
    for (const s of data) candidates.push(s.fetched_at);
    for (const series of histSeries) for (const p of series.points) candidates.push(p.t);
    if (!candidates.length) { setHover(null); return; }
    let nearestT = candidates[0], nd = Infinity;
    for (const t of candidates) {
      const d = Math.abs(xScale(t) - mx);
      if (d < nd) { nd = d; nearestT = t; }
    }
    setHover({ t: nearestT });
  };

  const hoverSnap = hover ? data.find((s) => s.fetched_at === hover.t) : null;
  const hoverHist = hover
    ? histSeries
        .map((s) => ({ source: s.source, point: s.points.find((p) => p.t === hover.t) }))
        .filter((x) => x.point)
    : [];

  return (
    <div ref={containerRef} className="chart-wrap" style={{ width: "100%" }}>
      <svg width={w} height={height} onMouseMove={onMouseMove} onMouseLeave={() => setHover(null)}>
        {/* Y grid */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padding.l} x2={w - padding.r} y1={yScale(v)} y2={yScale(v)} stroke="var(--border)" strokeDasharray="2 3" />
            <text x={padding.l - 8} y={yScale(v) + 3} fontSize="10" textAnchor="end" fill="var(--text-faint)" style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmt.usd(Math.round(v / 1000) * 1000, { compact: true })}
            </text>
          </g>
        ))}
        {/* X ticks */}
        {xTicks.map((t, i) => (
          <text key={i} x={xScale(t)} y={height - 8} fontSize="10" textAnchor="middle" fill="var(--text-faint)">
            {fmt.shortDate(t)}
          </text>
        ))}

        {/* Band */}
        {bandPath && (
          <path d={bandPath} fill="color-mix(in oklab, var(--accent) 14%, transparent)" stroke="none" />
        )}

        {/* List price step */}
        {listPath && (
          <path d={listPath} fill="none" stroke="var(--text-muted)" strokeWidth="1.25" strokeDasharray="4 3" />
        )}

        {/* Historical vendor lines */}
        {histSeries.map((s) => {
          const style = VENDOR_STYLES[s.source] || { color: "var(--text-muted)", dash: null };
          const d = s.points.map((p, i) =>
            (i ? "L" : "M") + xScale(p.t).toFixed(1) + " " + yScale(p.v).toFixed(1)
          ).join(" ");
          return (
            <path
              key={s.source}
              d={d}
              fill="none"
              stroke={style.color}
              strokeWidth="1.5"
              strokeDasharray={style.dash || undefined}
              opacity={0.85}
            />
          );
        })}

        {/* Estimate line */}
        {estPath && (
          <path d={estPath} fill="none" stroke="var(--accent)" strokeWidth="2" />
        )}

        {/* Estimate dots */}
        {estPts.map((s, i) => (
          <circle key={i} cx={xScale(s.fetched_at)} cy={yScale(s.best_current_estimate)} r="2.5" fill="var(--accent)" />
        ))}

        {/* Sold marker */}
        {soldEvent && (
          <g>
            <line x1={xScale(soldEvent.fetched_at)} x2={xScale(soldEvent.fetched_at)} y1={padding.t} y2={height - padding.b} stroke="var(--pos)" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />
            <circle cx={xScale(soldEvent.fetched_at)} cy={yScale(soldEvent.sold_price)} r="5" fill="var(--pos)" stroke="var(--bg-elev)" strokeWidth="2" />
            <text x={xScale(soldEvent.fetched_at) + 8} y={yScale(soldEvent.sold_price) - 6} fontSize="10" fill="var(--pos)" fontWeight="600">
              Sold {fmt.usd(soldEvent.sold_price, { compact: true })}
            </text>
          </g>
        )}

        {/* Hover crosshair + tooltip */}
        {hover && (
          <g>
            <line x1={xScale(hover.t)} x2={xScale(hover.t)} y1={padding.t} y2={height - padding.b} stroke="var(--border-strong)" strokeWidth="1" />
            {hoverSnap && hoverSnap.best_current_estimate != null && (
              <circle cx={xScale(hover.t)} cy={yScale(hoverSnap.best_current_estimate)} r="4" fill="var(--accent)" stroke="var(--bg-elev)" strokeWidth="2" />
            )}
            {hoverHist.map(({ source, point }) => {
              const style = VENDOR_STYLES[source] || { color: "var(--text-muted)" };
              return (
                <circle key={source} cx={xScale(point.t)} cy={yScale(point.v)} r="4" fill={style.color} stroke="var(--bg-elev)" strokeWidth="2" />
              );
            })}
          </g>
        )}
      </svg>

      {hover && (hoverSnap || hoverHist.length > 0) && (
        <div style={{
          position: "absolute",
          left: Math.min(w - 200, Math.max(8, xScale(hover.t) + 12)),
          top: 10,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-md)",
          borderRadius: "6px",
          padding: "8px 10px",
          fontSize: "11px",
          pointerEvents: "none",
          minWidth: "180px",
          zIndex: 2,
        }}>
          <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>{fmt.date(hover.t)}</div>
          {hoverSnap && hoverSnap.best_current_estimate != null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>Estimate</span>
              <span className="mono" style={{ fontWeight: 600 }}>{fmt.usd(hoverSnap.best_current_estimate)}</span>
            </div>
          )}
          {hoverSnap && hoverSnap.estimate_low != null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: "var(--text-muted)" }}>
              <span>Range</span>
              <span className="mono">{fmt.usd(hoverSnap.estimate_low, {compact:true})} – {fmt.usd(hoverSnap.estimate_high, {compact:true})}</span>
            </div>
          )}
          {hoverSnap && hoverSnap.list_price != null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>List</span>
              <span className="mono" style={{ fontWeight: 500 }}>{fmt.usd(hoverSnap.list_price)}</span>
            </div>
          )}
          {hoverSnap && hoverSnap.sold_price != null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: "var(--pos)" }}>
              <span>Sold</span>
              <span className="mono" style={{ fontWeight: 600 }}>{fmt.usd(hoverSnap.sold_price)}</span>
            </div>
          )}
          {hoverHist.map(({ source, point }) => {
            const style = VENDOR_STYLES[source] || { color: "var(--text-muted)" };
            return (
              <div key={source} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ color: style.color }}>{source}</span>
                <span className="mono" style={{ fontWeight: 500 }}>{fmt.usd(point.v)}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="chart-legend" style={{ marginTop: 8 }}>
        <span className="item"><span className="swatch" /> Estimate</span>
        {mode === "band" && <span className="item"><span className="swatch band" /> Low / high range</span>}
        {histSeries.map((s) => {
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
              {s.source} history
            </span>
          );
        })}
        <span className="item"><span className="swatch dashed" /> List price</span>
        <span className="item"><span className="swatch dot" /> Sold</span>
      </div>
    </div>
  );
}

window.PriceChart = PriceChart;
