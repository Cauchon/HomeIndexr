// HomeTracker — pages (Dashboard, Add Property, Property Detail)
// All data flows through `window.API`; no client-side scraping.

const { useState: useState_p, useMemo: useMemo_p, useEffect: useEffect_p } = React;

// ---------- Dashboard ----------
function DashboardPage({ properties, loading, navigate, onRefreshAll, refreshingAll }) {
  const [q, setQ] = useState_p("");
  const [city, setCity] = useState_p("all");
  const [state, setState] = useState_p("all");
  const [status, setStatus] = useState_p("all");
  const [listingState, setListingState] = useState_p("all");
  const [sort, setSort] = useState_p({ key: "updated_at", dir: "desc" });

  const cities = useMemo_p(
    () => Array.from(new Set(properties.map((p) => p.city).filter(Boolean))).sort(),
    [properties]
  );
  const states = useMemo_p(
    () => Array.from(new Set(properties.map((p) => p.state).filter(Boolean))).sort(),
    [properties]
  );

  const rows = useMemo_p(() => {
    let arr = properties.map((p) => {
      const last = p.snapshots && p.snapshots.length
        ? p.snapshots[p.snapshots.length - 1]
        : {};
      return {
        ...p,
        display_address: displayAddress(p),
        last,
        estimate: last.best_current_estimate,
        list: last.list_price,
        sold: last.sold_price,
        estVsList:
          last.best_current_estimate != null && last.list_price != null
            ? last.best_current_estimate - last.list_price
            : null,
        estVsSold:
          last.best_current_estimate != null && last.sold_price != null
            ? last.best_current_estimate - last.sold_price
            : null,
      };
    });

    const ql = q.trim().toLowerCase();
    if (ql) {
      arr = arr.filter((r) => (
        (r.display_address || "").toLowerCase().includes(ql) ||
        (r.input_address || "").toLowerCase().includes(ql)
      ));
    }
    if (city !== "all") arr = arr.filter((r) => r.city === city);
    if (state !== "all") arr = arr.filter((r) => r.state === state);
    if (status !== "all") arr = arr.filter((r) => r.status === status);
    if (listingState !== "all") arr = arr.filter((r) => r.listing_state === listingState);

    arr.sort((a, b) => {
      const k = sort.key;
      const av = a[k], bv = b[k];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return sort.dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return sort.dir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [properties, q, city, state, status, listingState, sort]);

  const lastSweep = properties.length
    ? Math.max(...properties.map((p) => p.updated_at || 0))
    : null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Properties</h1>
          <div className="page-subtitle">
            {properties.length === 0
              ? "No properties yet — add one to start tracking."
              : <>Tracking {properties.length} {properties.length === 1 ? "address" : "addresses"} · last sweep {fmt.relative(lastSweep)}</>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={onRefreshAll}
                  disabled={refreshingAll || properties.length === 0}>
            <Icon name="refresh" /> {refreshingAll ? "Refreshing…" : "Refresh all"}
          </button>
          <button className="btn btn-primary" onClick={() => navigate("add")}>
            <Icon name="plus" /> Add property
          </button>
        </div>
      </div>

      <div className="filterbar">
        <div className="field grow">
          <Icon name="search" />
          <input placeholder="Search address" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field has-select">
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="all">All states</option>
            {states.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field has-select">
          <select value={city} onChange={(e) => setCity(e.target.value)}>
            <option value="all">All cities</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="divider" />
        <div className="field has-select">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All match status</option>
            <option value="matched">Matched</option>
            <option value="candidate_mismatch">Mismatch</option>
            <option value="no_candidates">No candidates</option>
            <option value="error">Error</option>
          </select>
        </div>
        <div className="field has-select">
          <select value={listingState} onChange={(e) => setListingState(e.target.value)}>
            <option value="all">All listing states</option>
            <option value="for_sale">For sale</option>
            <option value="pending">Pending</option>
            <option value="sold">Sold</option>
            <option value="off_market">Off market</option>
          </select>
        </div>
        <div className="results-count">{rows.length} of {properties.length}</div>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <SortHeader label="Address"      k="display_address" sort={sort} setSort={setSort} />
              <SortHeader label="Listing"      k="listing_state" sort={sort} setSort={setSort} />
              <SortHeader label="Est. value"   k="estimate"      sort={sort} setSort={setSort} align="right" />
              <SortHeader label="List price"   k="list"          sort={sort} setSort={setSort} align="right" />
              <SortHeader label="Sale price"   k="sold"          sort={sort} setSort={setSort} align="right" />
              <SortHeader label="Est − List"   k="estVsList"     sort={sort} setSort={setSort} align="right" />
              <SortHeader label="Est − Sale"   k="estVsSold"     sort={sort} setSort={setSort} align="right" />
              <SortHeader label="Last refresh" k="updated_at"    sort={sort} setSort={setSort} />
              <SortHeader label="Status"       k="status"        sort={sort} setSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {loading && properties.length === 0 && (
              <tr><td colSpan={9} className="empty">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9}>
                <div className="empty">
                  <div className="title">{properties.length === 0 ? "No properties yet" : "No matches"}</div>
                  <div>
                    {properties.length === 0
                      ? <>Click <b>Add property</b> to fetch a snapshot from HomeHarvest.</>
                      : "Adjust the filters or search above."}
                  </div>
                </div>
              </td></tr>
            )}
            {rows.map((r) => {
              const sp = splitAddress(r.display_address || "");
              return (
                <tr key={r.id} onClick={() => navigate("detail", r.id)}>
                  <td className="address-cell">
                    {sp.line1} <span className="sub">· {sp.line2}</span>
                  </td>
                  <td><ListingBadge state={r.listing_state} /></td>
                  <td className="num">{fmt.usd(r.estimate)}</td>
                  <td className="num">{fmt.usd(r.list)}</td>
                  <td className="num">{r.sold ? fmt.usd(r.sold) : <span className="faint">—</span>}</td>
                  <td className="num"><DeltaCell value={r.estimate} base={r.list} /></td>
                  <td className="num"><DeltaCell value={r.estimate} base={r.sold} /></td>
                  <td className="muted">
                    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                      <span style={{ color: "var(--text)" }}>{fmt.relative(r.updated_at)}</span>
                      <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{fmt.shortDate(r.updated_at)}</span>
                    </div>
                  </td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Add Property ----------
function AddPropertyPage({ navigate, onAdded }) {
  const [addr, setAddr] = useState_p("");
  const [phase, setPhase] = useState_p("idle"); // idle | searching | matched | mismatch | none | error | saving
  const [result, setResult] = useState_p(null);
  const [errorMsg, setErrorMsg] = useState_p(null);
  const toast = useToast();

  async function runLookup(input) {
    const t = (input || "").trim();
    if (!t) return;
    setPhase("searching");
    setResult(null);
    setErrorMsg(null);
    try {
      const res = await API.addProperty(t, false);
      if (res.status === "matched") {
        // Created (or appended) — done.
        toast.push({ kind: "ok", text: `Added ${splitAddress(displayAddress(res.property)).line1}` });
        onAdded(res.property);
        navigate("dashboard");
        return;
      }
      if (res.status === "candidate_mismatch") {
        setResult({ input: t, candidate: res.candidate });
        setPhase("mismatch");
        return;
      }
      if (res.status === "no_candidates") { setPhase("none"); return; }
      if (res.status === "error") { setErrorMsg(res.error || "Unknown error"); setPhase("error"); return; }
    } catch (e) {
      setErrorMsg(e.message || "Request failed");
      setPhase("error");
    }
  }

  async function confirmMismatch() {
    if (!result) return;
    setPhase("saving");
    try {
      const res = await API.addProperty(result.input, true);
      if (res.property) {
        toast.push({ kind: "ok", text: `Tracking ${splitAddress(displayAddress(res.property)).line1}` });
        onAdded(res.property);
        navigate("dashboard");
      } else {
        setErrorMsg("Could not save");
        setPhase("error");
      }
    } catch (e) {
      setErrorMsg(e.message || "Save failed");
      setPhase("error");
    }
  }

  return (
    <div className="center-narrow">
      <button className="btn btn-ghost" onClick={() => navigate("dashboard")} style={{ marginBottom: 12 }}>
        <Icon name="chevronLeft" /> Back to properties
      </button>
      <h1 className="page-title">Track a new property</h1>
      <div className="page-subtitle" style={{ marginBottom: 18 }}>
        Enter a full street address. We'll fetch the latest HomeHarvest snapshot and
        require an exact match before activating tracking.
      </div>

      <div className="card">
        <div className="card-body">
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>
            Street address
          </label>
          <form onSubmit={(e) => { e.preventDefault(); runLookup(addr); }} style={{ marginTop: 6 }}>
            <div className="field field-lg">
              <Icon name="home" size={16} />
              <input
                autoFocus
                placeholder="123 Maple Ave, Austin, TX 78704"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-sm"
                      disabled={!addr.trim() || phase === "searching" || phase === "saving"}>
                {phase === "searching" ? "Looking up…" : "Look up"}
              </button>
            </div>
          </form>
          <div className="hint">
            Include city, state, ZIP for the best match. The fetch runs server-side via HomeHarvest.
          </div>

          {phase === "searching" && (
            <div style={{ marginTop: 16, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "var(--accent)", animation: "pulse 1.2s infinite"
              }} />
              Fetching from HomeHarvest…
            </div>
          )}

          {phase === "mismatch" && result && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <StatusBadge status="candidate_mismatch" />
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  HomeHarvest returned a candidate that doesn't exactly match your input. Confirm before saving.
                </span>
              </div>
              <div className="compare-rows">
                <div className="compare-row">
                  <div className="lbl">You entered</div>
                  <div className="val">{result.input}</div>
                </div>
                <div className="compare-row" style={{ background: "var(--warn-soft)", borderColor: "color-mix(in oklab, var(--warn) 30%, transparent)" }}>
                  <div className="lbl">We matched</div>
                  <div className="val">{result.candidate.matched_address || "—"}</div>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <MatchPreview result={result.candidate} />
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
                <button className="btn" onClick={() => { setPhase("idle"); setResult(null); }}>Re-enter address</button>
                <button className="btn btn-primary" onClick={confirmMismatch} disabled={phase === "saving"}>
                  <Icon name="check" /> {phase === "saving" ? "Saving…" : "Track this address"}
                </button>
              </div>
            </div>
          )}

          {phase === "none" && (
            <div style={{ marginTop: 16, padding: 12, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-sunken)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <StatusBadge status="no_candidates" />
                <strong style={{ fontSize: 13 }}>No candidates returned</strong>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                HomeHarvest didn't surface any properties for that address. Check spelling and ZIP and try again.
              </div>
            </div>
          )}

          {phase === "error" && (
            <div style={{ marginTop: 16, padding: 12, border: "1px solid color-mix(in oklab, var(--neg) 30%, transparent)", borderRadius: 6, background: "var(--neg-soft)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <StatusBadge status="error" />
                <strong style={{ fontSize: 13, color: "var(--neg)" }}>Upstream error</strong>
              </div>
              <div style={{ fontSize: 12, wordBreak: "break-word" }}>
                {errorMsg || "Something went wrong contacting HomeHarvest. Try again in a moment."}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MatchPreview({ result }) {
  return (
    <div className="facts" style={{ borderRadius: 6 }}>
      <div className="fact">
        <div className="label">Estimate</div>
        <div className="value">{fmt.usd(result.best_current_estimate)}</div>
        <div className="sub">{result.estimate_source || "—"}</div>
      </div>
      <div className="fact">
        <div className="label">Range</div>
        <div className="value sm">
          {result.estimate_low != null && result.estimate_high != null
            ? <>{fmt.usd(result.estimate_low, {compact:true})} – {fmt.usd(result.estimate_high, {compact:true})}</>
            : "—"}
        </div>
      </div>
      <div className="fact">
        <div className="label">List price</div>
        <div className="value sm">{fmt.usd(result.list_price)}</div>
        <div className="sub">{LISTING_META[result.listing_state]?.label || "—"}</div>
      </div>
      <div className="fact">
        <div className="label">Property</div>
        <div className="value sm">{result.beds ?? "—"} bd · {result.baths != null ? fmt.baths(result.baths) : "—"} ba</div>
        <div className="sub">{fmt.num(result.sqft)} sqft · {result.year_built || "—"}</div>
      </div>
    </div>
  );
}

// ---------- Property Detail ----------
function PropertyDetailPage({ propertyId, navigate, onChanged }) {
  const [property, setProperty] = useState_p(null);
  const [loading, setLoading] = useState_p(true);
  const [refreshing, setRefreshing] = useState_p(false);
  const [backfilling, setBackfilling] = useState_p(false);
  const [tab, setTab] = useState_p("history");
  const toast = useToast();

  useEffect_p(() => {
    let cancelled = false;
    setLoading(true);
    API.getProperty(propertyId)
      .then((p) => { if (!cancelled) setProperty(p); })
      .catch((e) => { if (!cancelled) toast.push({ kind: "err", text: e.message }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [propertyId]);

  async function doRefresh() {
    setRefreshing(true);
    try {
      const updated = await API.refresh(propertyId);
      setProperty(updated);
      onChanged?.();
      toast.push({ kind: "ok", text: "Snapshot captured" });
    } catch (e) {
      toast.push({ kind: "err", text: e.message });
    } finally {
      setRefreshing(false);
    }
  }

  async function doBackfill() {
    setBackfilling(true);
    try {
      const res = await API.backfill(propertyId);
      if (res.error) {
        toast.push({ kind: "err", text: res.error });
      } else {
        const fresh = await API.getProperty(propertyId);
        setProperty(fresh);
        toast.push({ kind: "ok", text: `Backfilled ${res.written} estimates · ${res.events_written || 0} events` });
      }
    } catch (e) {
      toast.push({ kind: "err", text: e.message });
    } finally {
      setBackfilling(false);
    }
  }

  if (loading) return <div className="empty">Loading property…</div>;
  if (!property) return <div className="empty"><div className="title">Property not found</div></div>;

  const last = property.snapshots[property.snapshots.length - 1] || {};
  const sp = splitAddress(displayAddress(property));

  const firstEst = (() => {
    const s = property.snapshots.find((x) => x.best_current_estimate != null);
    return s ? s.best_current_estimate : null;
  })();
  const sinceStart =
    last.best_current_estimate != null && firstEst != null
      ? last.best_current_estimate - firstEst
      : null;
  const sinceStartPct =
    firstEst && last.best_current_estimate != null
      ? (last.best_current_estimate - firstEst) / firstEst
      : null;

  return (
    <div>
      <button className="btn btn-ghost" onClick={() => navigate("dashboard")} style={{ marginBottom: 12 }}>
        <Icon name="chevronLeft" /> All properties
      </button>

      <div className="detail-header">
        <div>
          <h1>{sp.line1}</h1>
          <div className="meta">
            <span>{sp.line2}</span>
            <span style={{ color: "var(--text-faint)" }}>·</span>
            <ListingBadge state={property.listing_state} />
            <StatusBadge status={property.status} />
            {property.property_url && (
              <a href={property.property_url} target="_blank" rel="noopener noreferrer">
                Realtor.com page <Icon name="arrowUpRight" size={12} />
              </a>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={doBackfill} disabled={backfilling || refreshing} title="Fetch full historical AVM series from realtor.com">
            <Icon name="refresh" />
            {backfilling ? "Backfilling…" : "Backfill history"}
          </button>
          <button className="btn" onClick={doRefresh} disabled={refreshing || backfilling}>
            <Icon name="refresh" />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="facts" style={{ marginBottom: 16 }}>
        <div className="fact">
          <div className="label">Latest estimate</div>
          <div className="value">{fmt.usd(last.best_current_estimate)}</div>
          <div className="sub">
            {last.estimate_low != null && last.estimate_high != null && (
              <><RangePill low={last.estimate_low} high={last.estimate_high} /> · </>
            )}
            {last.estimate_source || "—"}
          </div>
        </div>
        <div className="fact">
          <div className="label">List price</div>
          <div className="value">{last.list_price ? fmt.usd(last.list_price) : "—"}</div>
          <div className="sub">
            {last.list_price != null && last.best_current_estimate != null
              ? <span style={{ color: last.best_current_estimate >= last.list_price ? "var(--pos)" : "var(--neg)" }}>
                  Est. {fmt.delta(last.best_current_estimate - last.list_price)} vs list
                </span>
              : "Not currently listed"}
          </div>
        </div>
        <div className="fact">
          <div className="label">{last.sold_price ? "Sale price" : "Last sale"}</div>
          <div className="value">{last.sold_price ? fmt.usd(last.sold_price) : fmt.usd(last.last_sold_price)}</div>
          <div className="sub">
            {last.sold_price && last.best_current_estimate != null
              ? <span style={{ color: last.best_current_estimate >= last.sold_price ? "var(--pos)" : "var(--neg)" }}>
                  Est. {fmt.delta(last.best_current_estimate - last.sold_price)} vs sale
                </span>
              : last.last_sold_price ? "Historic" : "—"}
          </div>
        </div>
        <div className="fact">
          <div className="label">Since first snapshot</div>
          <div className="value" style={{ color: sinceStart != null ? (sinceStart >= 0 ? "var(--pos)" : "var(--neg)") : undefined }}>
            {sinceStart != null ? fmt.delta(sinceStart) : "—"}
          </div>
          <div className="sub">{fmt.pct(sinceStartPct)} · {property.snapshots.length} snapshots</div>
        </div>
      </div>

      <div className="detail-grid">
        <div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <div className="card-title">Value over time</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {(() => {
                  const ts = [];
                  for (const s of property.snapshots || []) if (s.fetched_at) ts.push(s.fetched_at);
                  for (const h of property.historical || []) {
                    const t = parseEstimateDate(h.date);
                    if (t != null && h.estimate != null) ts.push(t);
                  }
                  for (const e of property.events || []) {
                    const t = parseEstimateDate(e.date);
                    if (t != null && e.price != null) ts.push(t);
                  }
                  if (!ts.length) return "—";
                  return <>{fmt.date(Math.min(...ts))} – {fmt.date(Math.max(...ts))}</>;
                })()}
              </div>
            </div>
            <div className="card-body">
              <PriceChart snapshots={property.snapshots} historical={property.historical || []} events={property.events || []} height={280} />
            </div>
            <LifetimeStrip snapshots={property.snapshots} historical={property.historical || []} events={property.events || []} />
          </div>

          <div className="tabs">
            <div className={`tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
              Timeline
            </div>
            <div className={`tab ${tab === "json" ? "active" : ""}`} onClick={() => setTab("json")}>
              Raw JSON · latest
            </div>
          </div>

          {tab === "history" && <ActivityTimeline snapshots={property.snapshots} historical={property.historical || []} events={property.events || []} />}
          {tab === "json" && (
            <div className="card">
              <div className="card-header">
                <div className="card-title">Audit · {last.fetched_at ? fmt.datetime(last.fetched_at) : "—"}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm" onClick={() => {
                    navigator.clipboard?.writeText(JSON.stringify(last.raw_json, null, 2));
                    toast.push({ kind: "ok", text: "Copied to clipboard" });
                  }}>
                    <Icon name="copy" /> Copy
                  </button>
                </div>
              </div>
              <div className="card-body flush" style={{ padding: 12 }}>
                {last.raw_json
                  ? <JsonViewer data={last.raw_json} maxHeight={520} />
                  : <div className="empty">No raw JSON for this snapshot.</div>}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-header"><div className="card-title">Property facts</div></div>
            <div className="card-body flush">
              <div className="facts-stack">
                <div className="fact-row"><span className="k">Beds</span><span className="v">{last.beds ?? "—"}</span></div>
                <div className="fact-row"><span className="k">Baths</span><span className="v">{last.baths != null ? fmt.baths(last.baths) : "—"}</span></div>
                <div className="fact-row"><span className="k">Living area</span><span className="v">{last.sqft != null ? `${fmt.num(last.sqft)} sqft` : "—"}</span></div>
                <div className="fact-row"><span className="k">Lot</span><span className="v">{last.lot_sqft != null ? `${fmt.num(last.lot_sqft)} sqft` : "—"}</span></div>
                <div className="fact-row"><span className="k">Year built</span><span className="v">{last.year_built ?? "—"}</span></div>
                <div className="fact-row">
                  <span className="k">Coordinates</span>
                  <span className="v mono" style={{ fontSize: 11 }}>
                    {last.latitude != null && last.longitude != null
                      ? `${last.latitude.toFixed(4)}, ${last.longitude.toFixed(4)}`
                      : "—"}
                  </span>
                </div>
                <div className="fact-row"><span className="k">Property ID</span><span className="v mono" style={{ fontSize: 11 }}>{property.property_id || "—"}</span></div>
                <div className="fact-row"><span className="k">Listing ID</span><span className="v mono" style={{ fontSize: 11 }}>{property.listing_id || "—"}</span></div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><div className="card-title">Estimate breakdown</div></div>
            <div className="card-body">
              <AllEstimates estimates={last.all_estimates} fallback={last} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const ESTIMATE_SOURCES = ["Quantarium", "Cotality"];

function matchSource(estimates, label) {
  if (!Array.isArray(estimates)) return null;
  const want = label.toLowerCase();
  return estimates.find((e) => (e.source || "").toLowerCase().includes(want)) || null;
}

function AllEstimates({ estimates, fallback }) {
  const [picked, setPicked] = useState_p(ESTIMATE_SOURCES[0]);
  const list = Array.isArray(estimates) ? estimates : [];
  const e =
    matchSource(list, picked) ||
    (fallback && fallback.best_current_estimate != null
      ? {
          source: fallback.estimate_source,
          estimate: fallback.best_current_estimate,
          low: fallback.estimate_low,
          high: fallback.estimate_high,
          date: fallback.estimate_date,
        }
      : null);

  return (
    <div>
      <div role="tablist" style={{
        display: "inline-flex", gap: 0, padding: 2,
        background: "var(--bg-sunken)", border: "1px solid var(--border)",
        borderRadius: 6, marginBottom: 12,
      }}>
        {ESTIMATE_SOURCES.map((s) => {
          const active = s === picked;
          const available = matchSource(list, s) != null;
          return (
            <button
              key={s}
              role="tab"
              aria-selected={active}
              disabled={!available && list.length > 0}
              onClick={() => setPicked(s)}
              style={{
                fontSize: 11, fontWeight: 600, letterSpacing: ".02em",
                padding: "4px 10px", borderRadius: 4, border: "none", cursor: available ? "pointer" : "not-allowed",
                background: active ? "var(--bg)" : "transparent",
                color: active ? "var(--text)" : "var(--text-muted)",
                boxShadow: active ? "0 1px 2px rgba(0,0,0,.06)" : "none",
                opacity: available || list.length === 0 ? 1 : 0.4,
              }}
            >
              {s}
            </button>
          );
        })}
      </div>

      {!e ? (
        <div className="empty" style={{ padding: 0 }}>No {picked} estimate.</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>Source</div>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>{e.source || picked}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>Range</div>
          <EstimateRangeBar low={e.low} mid={e.estimate} high={e.high} />
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)" }}>
            Estimate date <span style={{ color: "var(--text)" }}>{e.date || "—"}</span>
          </div>
        </>
      )}
    </div>
  );
}

function EstimateRangeBar({ low, mid, high }) {
  if (low == null || high == null || mid == null) return <span className="faint">—</span>;
  const range = high - low || 1;
  const midPct = Math.max(0, Math.min(100, ((mid - low) / range) * 100));
  return (
    <div>
      <div style={{
        display: "flex", justifyContent: "space-between", marginBottom: 4,
        fontVariantNumeric: "tabular-nums", fontSize: 11, color: "var(--text-muted)"
      }}>
        <span>{fmt.usd(low, { compact: true })}</span>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>{fmt.usd(mid)}</span>
        <span>{fmt.usd(high, { compact: true })}</span>
      </div>
      <div style={{
        position: "relative", height: 8, background: "var(--bg-sunken)", borderRadius: 4, overflow: "hidden",
        border: "1px solid var(--border)"
      }}>
        <div style={{
          position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
          background: "color-mix(in oklab, var(--accent) 18%, transparent)"
        }} />
        <div style={{
          position: "absolute", left: `${midPct}%`, top: -2, bottom: -2, width: 2,
          background: "var(--accent)"
        }} />
      </div>
    </div>
  );
}

function parseEstimateDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function marketEventKind(name) {
  const s = (name || "").toLowerCase();
  if (s.includes("sold")) return "sold";
  if (s.includes("price")) return "price";
  if (s.includes("relisted")) return "relisted";
  if (s.includes("removed")) return "removed";
  if (s.includes("rent")) return "rent";
  if (s.includes("listed")) return "listed";
  return "event";
}

function eventBadgeClass(name) {
  const s = (name || "").toLowerCase();
  if (s.includes("sold")) return "ok";
  if (s.includes("price")) return "warn";
  if (s.includes("listed")) return "info";
  return "neutral";
}

const TIMELINE_FILTERS = [
  { key: "all", label: "All", match: () => true },
  { key: "estimate", label: "Estimates", match: (e) => e.kind === "estimate" },
  { key: "market", label: "Market events", match: (e) => e.kind === "market" },
  { key: "issue", label: "Issues", match: (e) => e.kind === "issue" },
];
const TIMELINE_PAGE_SIZE = 10;

function buildActivityEvents(snapshots = [], historical = [], marketEvents = []) {
  const rows = [];
  const estimateRowsByKey = new Map();
  const addEstimateRow = (row) => {
    if (!row.date || row.estimate == null || !row.source) return;
    const key = `${row.date}|${row.source}|${row.estimate}`;
    const existing = estimateRowsByKey.get(key);
    if (!existing || (existing.low == null && row.low != null) || row.origin === "snapshot") {
      estimateRowsByKey.set(key, row);
    }
  };

  for (const s of snapshots || []) {
    const baseDate = s.estimate_date || (s.fetched_at ? new Date(s.fetched_at).toISOString().slice(0, 10) : null);
    const note = s.error || (s.status === "candidate_mismatch" && s.matched_address ? `Matched ${splitAddress(s.matched_address).line1}` : "");
    if (s.status === "error" || s.status === "candidate_mismatch") {
      rows.push({
        id: `${s.id || s.fetched_at}-issue`,
        kind: "issue",
        ts: s.fetched_at || parseEstimateDate(baseDate),
        label: s.status === "error" ? "Error" : "Mismatch",
        note: note || "Snapshot did not return a clean match.",
      });
    }
    if (Array.isArray(s.all_estimates) && s.all_estimates.length) {
      for (const e of s.all_estimates) {
        addEstimateRow({
          id: `${s.id || s.fetched_at}-${e.source}-${e.date || baseDate}`,
          kind: "estimate",
          origin: "snapshot",
          date: e.date || baseDate,
          ts: parseEstimateDate(e.date || baseDate) ?? s.fetched_at,
          source: e.source,
          estimate: e.estimate,
          low: e.low,
          high: e.high,
          note,
        });
      }
    } else {
      addEstimateRow({
        id: `${s.id || s.fetched_at}-estimate`,
        kind: "estimate",
        origin: "snapshot",
        date: baseDate,
        ts: parseEstimateDate(baseDate) ?? s.fetched_at,
        source: s.estimate_source,
        estimate: s.best_current_estimate,
        low: s.estimate_low,
        high: s.estimate_high,
        note,
      });
    }
  }

  for (const h of historical || []) {
    addEstimateRow({
      id: `hist-${h.date}-${h.source}-${h.estimate}`,
      kind: "estimate",
      origin: "historical",
      date: h.date,
      ts: parseEstimateDate(h.date),
      source: h.source,
      estimate: h.estimate,
      low: null,
      high: null,
      note: "Historical AVM",
    });
  }

  const estimates = Array.from(estimateRowsByKey.values()).filter((r) => r.ts != null);
  const bySource = new Map();
  for (const row of [...estimates].sort((a, b) => a.ts - b.ts)) {
    const prev = bySource.get(row.source);
    row.vsPrior = prev ? row.estimate - prev.estimate : null;
    row.vsPriorPct = prev && prev.estimate ? row.vsPrior / prev.estimate : null;
    bySource.set(row.source, row);
  }
  rows.push(...estimates);

  const sortedEstimates = [...estimates].sort((a, b) => a.ts - b.ts);
  const sortedMarket = (marketEvents || [])
    .filter((e) => e.date && e.event_name && e.price != null)
    .map((e, i) => ({
      id: `market-${e.date}-${e.event_name}-${e.price}-${i}`,
      kind: "market",
      subkind: marketEventKind(e.event_name),
      ts: parseEstimateDate(e.date),
      date: e.date,
      name: e.event_name,
      price: e.price,
    }))
    .filter((e) => e.ts != null)
    .sort((a, b) => a.ts - b.ts);

  let prevMarketPrice = null;
  for (const row of sortedMarket) {
    const estimateAtTime = [...sortedEstimates].reverse().find((e) => e.ts <= row.ts && e.estimate != null);
    row.estimateAtTime = estimateAtTime?.estimate ?? null;
    if (row.subkind === "price" && prevMarketPrice != null) {
      row.vsPrior = row.price - prevMarketPrice;
      row.vsPriorPct = prevMarketPrice ? row.vsPrior / prevMarketPrice : null;
    } else if ((row.subkind === "listed" || row.subkind === "sold") && row.estimateAtTime != null) {
      row.vsPrior = row.price - row.estimateAtTime;
      row.vsPriorPct = row.estimateAtTime ? row.vsPrior / row.estimateAtTime : null;
    }
    if (row.price != null) prevMarketPrice = row.price;
  }
  rows.push(...sortedMarket);

  return rows.sort((a, b) => {
    if (b.ts !== a.ts) return b.ts - a.ts;
    if (a.kind !== b.kind) return a.kind === "market" ? -1 : 1;
    return String(a.source || a.name || "").localeCompare(String(b.source || b.name || ""));
  });
}

function ActivityTimeline({ snapshots, historical = [], events = [] }) {
  const [filter, setFilter] = useState_p("all");
  const [page, setPage] = useState_p(1);
  const rows = useMemo_p(() => buildActivityEvents(snapshots, historical, events), [snapshots, historical, events]);
  const active = TIMELINE_FILTERS.find((f) => f.key === filter) || TIMELINE_FILTERS[0];
  const filtered = rows.filter(active.match);
  const counts = useMemo_p(() => {
    const out = {};
    for (const f of TIMELINE_FILTERS) out[f.key] = rows.filter(f.match).length;
    return out;
  }, [rows]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / TIMELINE_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * TIMELINE_PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + TIMELINE_PAGE_SIZE);

  useEffect_p(() => {
    setPage(1);
  }, [filter, rows]);

  function chooseFilter(key) {
    setFilter(key);
    setPage(1);
  }

  if (!rows.length) return <div className="empty">No timeline data yet.</div>;
  return (
    <div>
      <div className="activity-filters">
        {TIMELINE_FILTERS.map((f) => (
          <button
            key={f.key}
            className={`chip ${filter === f.key ? "active" : ""}`}
            onClick={() => chooseFilter(f.key)}
          >
            {f.label}
            <span className="count">{counts[f.key]}</span>
          </button>
        ))}
        <span className="spacer" />
        <span className="activity-count">{filtered.length} {filtered.length === 1 ? "event" : "events"}</span>
      </div>

      <div className="table-wrap">
        <table className="data timeline">
          <thead>
            <tr>
              <th style={{ width: 132 }}>Date</th>
              <th style={{ width: 140 }}>Event</th>
              <th>Value</th>
              <th style={{ textAlign: "right", width: 210 }}>Change</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => <ActivityRow key={r.id} row={r} />)}
            {filtered.length === 0 && (
              <tr><td colSpan={4}><div className="empty" style={{ padding: 28 }}>No events match this filter.</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > TIMELINE_PAGE_SIZE && (
        <div className="timeline-pager">
          <div className="pager-summary">
            Showing {pageStart + 1}–{Math.min(pageStart + TIMELINE_PAGE_SIZE, filtered.length)} of {filtered.length}
          </div>
          <div className="pager-controls">
            <button
              className="btn btn-sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              <Icon name="chevronLeft" /> Previous
            </button>
            <span className="pager-page">Page {currentPage} of {pageCount}</span>
            <button
              className="btn btn-sm"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={currentPage === pageCount}
            >
              Next <Icon name="chevronRight" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityRow({ row }) {
  return (
    <tr className={row.origin === "historical" ? "historical-bg" : ""} style={{ cursor: "default" }}>
      <td className="date-cell">
        <div>{fmt.date(row.ts)}</div>
        <div className="rel">{row.origin === "historical" ? "Historical AVM" : fmt.relative(row.ts)}</div>
      </td>
      <td><TimelineBadge row={row} /></td>
      <td className="value-cell"><TimelineValue row={row} /></td>
      <td className="change-cell"><TimelineChange row={row} /></td>
    </tr>
  );
}

function TimelineBadge({ row }) {
  if (row.kind === "issue") return <span className={`event-pill ${row.label === "Error" ? "err" : "warn"}`}>{row.label}</span>;
  if (row.kind === "estimate") return <span className="event-pill neutral">Estimate</span>;
  return <span className={`event-pill ${eventBadgeClass(row.name)}`}>{row.name}</span>;
}

function TimelineValue({ row }) {
  if (row.kind === "estimate") {
    return (
      <div>
        <div className="main">{fmt.usd(row.estimate)}</div>
        <div className="sub">
          <InlineRange low={row.low} mid={row.estimate} high={row.high} />
          {row.low != null && row.high != null && <span style={{ color: "var(--text-faint)" }}>·</span>}
          <span>{row.source || "—"}</span>
        </div>
      </div>
    );
  }
  if (row.kind === "market") {
    return (
      <div>
        <div className="main">{fmt.usd(row.price)}</div>
        <div className="sub">Realtor market event</div>
      </div>
    );
  }
  return (
    <div>
      <div className="main" style={{ color: row.label === "Error" ? "var(--neg)" : "var(--warn)" }}>{row.label}</div>
      <div className="sub">{row.note}</div>
    </div>
  );
}

function TimelineChange({ row }) {
  if (row.kind === "estimate") {
    if (row.vsPrior == null) return <span className="delta-sub">first estimate for source</span>;
    return (
      <div>
        <div className={`delta-num ${row.vsPrior > 0 ? "pos" : (row.vsPrior < 0 ? "neg" : "")}`}>
          {fmt.delta(row.vsPrior)} <span>({fmt.pct(row.vsPriorPct)})</span>
        </div>
        <div className="delta-sub">vs prior {row.source || "estimate"}</div>
      </div>
    );
  }
  if (row.kind === "market") {
    if (row.vsPrior == null) return <span className="delta-sub">no nearby comparison</span>;
    const label = row.subkind === "price" ? "vs prior market price" : "vs nearest estimate";
    return (
      <div>
        <div className={`delta-num ${row.vsPrior > 0 ? "pos" : (row.vsPrior < 0 ? "neg" : "")}`}>
          {fmt.delta(row.vsPrior)} <span>({fmt.pct(row.vsPriorPct)})</span>
        </div>
        <div className="delta-sub">{label}</div>
      </div>
    );
  }
  return <span className="delta-sub">—</span>;
}

function InlineRange({ low, mid, high }) {
  if (low == null || high == null || mid == null) return null;
  const range = high - low || 1;
  const midPct = Math.max(0, Math.min(100, ((mid - low) / range) * 100));
  return (
    <span className="range-inline" title={`${fmt.usd(low)} – ${fmt.usd(high)}`}>
      <span>{fmt.usd(low, { compact: true })}</span>
      <span className="bar">
        <span className="band" />
        <span className="tick" style={{ left: `${midPct}%` }} />
      </span>
      <span>{fmt.usd(high, { compact: true })}</span>
    </span>
  );
}

function LifetimeStrip({ snapshots = [], historical = [], events = [] }) {
  const estimateTimes = [];
  for (const s of snapshots || []) {
    if (s.fetched_at && s.best_current_estimate != null) estimateTimes.push(s.fetched_at);
    const t = parseEstimateDate(s.estimate_date);
    if (t != null && s.best_current_estimate != null) estimateTimes.push(t);
  }
  for (const h of historical || []) {
    const t = parseEstimateDate(h.date);
    if (t != null && h.estimate != null) estimateTimes.push(t);
  }
  const market = (events || [])
    .map((e, i) => ({ ...e, ts: parseEstimateDate(e.date), subkind: marketEventKind(e.event_name), i }))
    .filter((e) => e.ts != null && e.price != null)
    .sort((a, b) => a.ts - b.ts);
  const sales = market.filter((e) => e.subkind === "sold");

  const allTimes = [...estimateTimes, ...market.map((e) => e.ts), Date.now()];
  if (allTimes.length < 2) return null;

  const yearMs = 365.25 * 86400000;
  const min = Math.min(...allTimes) - yearMs;
  const max = Math.max(...allTimes) + yearMs;
  const range = max - min || 1;
  const pct = (t) => ((t - min) / range) * 100;
  const estimateStart = estimateTimes.length ? Math.min(...estimateTimes) : null;
  const estimateEnd = estimateTimes.length ? Math.max(...estimateTimes) : null;
  const years = [];
  const startYear = new Date(min).getFullYear();
  const endYear = new Date(max).getFullYear();
  for (let y = Math.ceil(startYear / 5) * 5; y <= endYear; y += 5) {
    const t = Date.UTC(y, 0, 1, 12, 0, 0);
    if (t >= min && t <= max) years.push({ y, t });
  }
  const mostRecentSale = sales[sales.length - 1];
  const latestEstimate = [...snapshots].reverse().find((s) => s.best_current_estimate != null)?.best_current_estimate
    ?? [...historical].reverse().find((h) => h.estimate != null)?.estimate
    ?? null;
  const sinceSale = mostRecentSale && latestEstimate != null
    ? (latestEstimate - mostRecentSale.price) / mostRecentSale.price
    : null;

  return (
    <div className="lifetime-strip">
      <div className="lifetime-head">
        <div>Ownership history</div>
        {sinceSale != null && (
          <div>Since last sale ({new Date(mostRecentSale.ts).getUTCFullYear()}): <span className={sinceSale >= 0 ? "pos" : "neg"}>{fmt.pct(sinceSale)}</span></div>
        )}
      </div>
      <div className="axis">
        <div className="baseline" />
        {estimateStart != null && estimateEnd != null && (
          <div className="window" style={{ left: `${pct(estimateStart)}%`, width: `${Math.max(1, pct(estimateEnd) - pct(estimateStart))}%` }} />
        )}
        {years.map(({ y, t }) => (
          <React.Fragment key={y}>
            <span className="year-tick" style={{ left: `${pct(t)}%` }} />
            <span className="year-label" style={{ left: `${pct(t)}%` }}>{y}</span>
          </React.Fragment>
        ))}
        {sales.map((s) => (
          <React.Fragment key={`${s.date}-${s.price}-${s.i}`}>
            <span className="sale-mark" style={{ left: `${pct(s.ts)}%` }} title={`${fmt.date(s.ts)} · ${fmt.usd(s.price)}`} />
            <span className="sale-label" style={{ left: `${pct(s.ts)}%` }}>
              {fmt.usd(s.price, { compact: true })}
              <span className="year">{new Date(s.ts).getUTCFullYear()}</span>
            </span>
          </React.Fragment>
        ))}
        <span className="today-mark" style={{ left: `${pct(Date.now())}%` }} title="Today" />
      </div>
      <div className="legend">
        <span className="item"><span className="swatch sale" />{sales.length} recorded {sales.length === 1 ? "sale" : "sales"}</span>
        <span className="item"><span className="swatch window" />Tracked estimates</span>
        <span className="item"><span className="today-mini" />Today</span>
      </div>
    </div>
  );
}

window.DashboardPage = DashboardPage;
window.AddPropertyPage = AddPropertyPage;
window.PropertyDetailPage = PropertyDetailPage;
