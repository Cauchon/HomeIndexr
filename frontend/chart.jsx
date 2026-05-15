// SVG chart for property detail page
// Renders: estimate line + optional low/high band, list price step, sale price point.

const { useState: useState_chart, useMemo: useMemo_chart, useRef: useRef_chart, useEffect: useEffect_chart } = React;

function PriceChart({ snapshots, mode = "band", height = 280 }) {
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

  if (!data.length || !allYs.length) {
    return <div ref={containerRef} className="empty" style={{ height }}>No timeline data yet.</div>;
  }

  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
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

  // Hover handler
  const onMouseMove = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < padding.l || mx > w - padding.r) { setHover(null); return; }
    // Find nearest snapshot
    let nearest = data[0], nd = Infinity;
    for (const s of data) {
      const d = Math.abs(xScale(s.fetched_at) - mx);
      if (d < nd) { nd = d; nearest = s; }
    }
    setHover(nearest);
  };

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
            <line x1={xScale(hover.fetched_at)} x2={xScale(hover.fetched_at)} y1={padding.t} y2={height - padding.b} stroke="var(--border-strong)" strokeWidth="1" />
            {hover.best_current_estimate != null && (
              <circle cx={xScale(hover.fetched_at)} cy={yScale(hover.best_current_estimate)} r="4" fill="var(--accent)" stroke="var(--bg-elev)" strokeWidth="2" />
            )}
          </g>
        )}
      </svg>

      {hover && (
        <div style={{
          position: "absolute",
          left: Math.min(w - 200, Math.max(8, xScale(hover.fetched_at) + 12)),
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
          <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>{fmt.date(hover.fetched_at)}</div>
          {hover.best_current_estimate != null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>Estimate</span>
              <span className="mono" style={{ fontWeight: 600 }}>{fmt.usd(hover.best_current_estimate)}</span>
            </div>
          )}
          {hover.estimate_low != null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: "var(--text-muted)" }}>
              <span>Range</span>
              <span className="mono">{fmt.usd(hover.estimate_low, {compact:true})} – {fmt.usd(hover.estimate_high, {compact:true})}</span>
            </div>
          )}
          {hover.list_price != null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span>List</span>
              <span className="mono" style={{ fontWeight: 500 }}>{fmt.usd(hover.list_price)}</span>
            </div>
          )}
          {hover.sold_price != null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: "var(--pos)" }}>
              <span>Sold</span>
              <span className="mono" style={{ fontWeight: 600 }}>{fmt.usd(hover.sold_price)}</span>
            </div>
          )}
        </div>
      )}

      <div className="chart-legend" style={{ marginTop: 8 }}>
        <span className="item"><span className="swatch" /> Estimate</span>
        {mode === "band" && <span className="item"><span className="swatch band" /> Low / high range</span>}
        <span className="item"><span className="swatch dashed" /> List price</span>
        <span className="item"><span className="swatch dot" /> Sold</span>
      </div>
    </div>
  );
}

window.PriceChart = PriceChart;
