// HomeIndexr pages (Dashboard, Add Property, Property Detail)
// All data flows through `window.API`; no client-side scraping.

const { useState: useState_p, useMemo: useMemo_p, useEffect: useEffect_p } = React;

// Live viewport check — true on phone-width screens, kept in sync via a
// matchMedia listener so the comps module can swap to its two-up grid.
function useIsMobile(maxWidth = 480) {
  const query = `(max-width: ${maxWidth}px)`;
  const [isMobile, setIsMobile] = useState_p(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect_p(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    setIsMobile(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return isMobile;
}

// ---------- Contextual price ----------
// Returns whichever price is meaningful for this property's current listing
// state, plus a tag for context. `base` is the value to diff the estimate
// against; historical fallbacks have base=null so they don't drive a
// misleading delta.
const SALE_DATE_KEYS = ["last_sold_date", "sold_date", "close_date", "closing_date", "last_status_change_date"];

function _saleDateTs(p) {
  const raw = p.raw_json;
  if (!raw || typeof raw !== "object") return null;
  for (const k of SALE_DATE_KEYS) {
    const v = raw[k];
    if (!v) continue;
    const s = String(v);
    const m = s.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1)).getTime();
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

function _saleYear(p) {
  const ts = _saleDateTs(p);
  return ts == null ? null : new Date(ts).getFullYear();
}

function _saleMonthYear(p, events = []) {
  const rawTs = _saleDateTs(p);
  if (rawTs != null) return formatMonthYear(rawTs);
  const soldEventTs = (events || [])
    .filter((e) => e.date && /sold/i.test(e.event_name || ""))
    .map((e) => parseEstimateDate(e.date))
    .filter((ts) => ts != null);
  return soldEventTs.length ? formatMonthYear(Math.max(...soldEventTs)) : null;
}

function priceFor(p) {
  const state = p.listing_state;
  if (state === "sold" && p.sold_price != null) {
    const y = _saleYear(p);
    return { value: p.sold_price, label: y ? `Sold ${y}` : "Sold", cls: "sold", base: p.sold_price };
  }
  if (state === "for_sale" && p.list_price != null) {
    return { value: p.list_price, label: "Asking", cls: "list", base: p.list_price };
  }
  if (state === "pending" && p.list_price != null) {
    return { value: p.list_price, label: "Pending", cls: "pending", base: p.list_price };
  }
  if (p.last_sold_price != null) {
    const y = _saleYear(p);
    return { value: p.last_sold_price, label: y ? `Sold ${y}` : "Sold", cls: "hist", base: null };
  }
  return null;
}

function PriceCell({ price }) {
  if (!price) return <span className="faint">—</span>;
  return (
    <span className="price-cell">
      <span className={`tag ${price.cls}`}>{price.label}</span>
      <span className="val">{fmt.usd(price.value)}</span>
    </span>
  );
}

// ---------- Mobile filter labels ----------
const LISTING_LABEL_MAP = {
  for_sale: "For sale",
  pending: "Pending",
  sold: "Sold",
  off_market: "Off market",
};

// ---------- Mobile inline-expand filter panel ----------
// Shown at ≤880px; replaces the desktop .filterbar.
// Tapping "Filters" expands a panel in-place (no overlay). Active filters
// surface as removable chips so users see what's applied at a glance.
function MobileFilters({
  q, setQ,
  state, setState,
  city, setCity,
  listingState, setListingState,
  cities, states,
  open, setOpen,
  activeFilterCount,
}) {
  const activeChips = [
    state !== "all"        && { k: "state",   label: "State",   v: state,                           clear: () => setState("all") },
    city !== "all"         && { k: "city",    label: "City",    v: city,                            clear: () => setCity("all") },
    listingState !== "all" && { k: "listing", label: "Listing", v: LISTING_LABEL_MAP[listingState] || listingState, clear: () => setListingState("all") },
  ].filter(Boolean);

  function resetAll() {
    setState("all"); setCity("all"); setListingState("all");
  }

  return (
    <div className="mfilters">
      <div className="mfilters-row">
        <div className="field grow">
          <Icon name="search" />
          <input placeholder="Search property or address" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className={`btn ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="filter" />
          Filters
          {activeFilterCount > 0 && <span className="mfilters-count">{activeFilterCount}</span>}
          <Icon name="chevronDown" size={12} className={`mfilters-chev${open ? " open" : ""}`} />
        </button>
      </div>

      {activeChips.length > 0 && (
        <div className="mfilters-chips">
          {activeChips.map((c) => (
            <span key={c.k} className="mfilters-chip">
              <span className="k">{c.label}</span>
              <span className="v">{c.v}</span>
              <button className="x" onClick={c.clear} aria-label={`Clear ${c.label}`}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
          {activeChips.length > 1 && (
            <button className="mfilters-chip clear-all" onClick={resetAll}>Clear all</button>
          )}
        </div>
      )}

      <div className={`mfilters-panel ${open ? "on" : ""}`}>
        <div className="mfilters-panel-inner">
          <div className="mfilters-group">
            <div className="lab">State</div>
            <div className="field has-select">
              <select value={state} onChange={(e) => setState(e.target.value)}>
                <option value="all">All states</option>
                {states.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="mfilters-group">
            <div className="lab">City</div>
            <div className="field has-select">
              <select value={city} onChange={(e) => setCity(e.target.value)}>
                <option value="all">All cities</option>
                {cities.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="mfilters-group">
            <div className="lab">Listing</div>
            <div className="mfilters-pills">
              <button className={listingState === "all" ? "on" : ""} onClick={() => setListingState("all")}>Any</button>
              {Object.entries(LISTING_LABEL_MAP).map(([v, label]) => (
                <button key={v} className={listingState === v ? "on" : ""} onClick={() => setListingState(v)}>{label}</button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Dashboard ----------
function DashboardPage({ properties, loading, navigate, onRefreshAll, refreshingAll, onChanged }) {
  const [q, setQ] = useState_p("");
  const [city, setCity] = useState_p("all");
  const [state, setState] = useState_p("all");
  const [listingState, setListingState] = useState_p("all");
  const [tracking, setTracking] = useState_p("active");
  const [sort, setSort] = useState_p({ key: "updated_at", dir: "desc" });
  const [filterPanelOpen, setFilterPanelOpen] = useState_p(false);
  const toast = useToast();

  async function handleTogglePin(e, prop) {
    e.stopPropagation();
    try {
      const nextPinned = !prop.pinned;
      await API.updateProperty(prop.id, { pinned: nextPinned });
      toast.push({
        kind: "ok",
        text: nextPinned ? `Pinned ${splitAddress(displayAddress(prop)).line1}` : `Unpinned ${splitAddress(displayAddress(prop)).line1}`
      });
      onChanged?.();
    } catch (err) {
      toast.push({ kind: "err", text: err.message || "Failed to toggle pin" });
    }
  }

  const activeFilterCount = [state, city, listingState].filter((v) => v !== "all").length;

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
      const price = priceFor(p);
      const address = displayAddress(p);
      const name = displayName(p);
      return {
        ...p,
        display_address: address,
        display_name: name,
        display_label: name || address,
        estimate: p.best_current_estimate,
        price,
        priceValue: price ? price.value : null,
        priceVsEst:
          price && price.base != null && p.best_current_estimate != null
            ? p.best_current_estimate - price.base
            : null,
      };
    });

    const ql = q.trim().toLowerCase();
    if (ql) {
      arr = arr.filter((r) => (
        (r.display_name || "").toLowerCase().includes(ql) ||
        (r.display_label || "").toLowerCase().includes(ql) ||
        (r.display_address || "").toLowerCase().includes(ql) ||
        (r.input_address || "").toLowerCase().includes(ql)
      ));
    }
    if (city !== "all") arr = arr.filter((r) => r.city === city);
    if (state !== "all") arr = arr.filter((r) => r.state === state);
    if (listingState !== "all") arr = arr.filter((r) => r.listing_state === listingState);
    if (tracking === "active") arr = arr.filter((r) => r.active !== false);
    if (tracking === "archived") arr = arr.filter((r) => r.active === false);

    arr.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      const k = sort.key;
      const av = a[k], bv = b[k];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return sort.dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return sort.dir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [properties, q, city, state, listingState, tracking, sort]);

  const activeCount = properties.filter((p) => p.active !== false).length;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Properties</h1>
          <div className="page-subtitle">
            {properties.length === 0
              ? "No properties yet — add one to start tracking."
              : "Tracking active properties"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={onRefreshAll}
                  disabled={refreshingAll || activeCount === 0}>
            <Icon name="refresh" /> {refreshingAll ? "Refreshing…" : "Refresh active"}
          </button>
          <button className="btn btn-primary" onClick={() => navigate("add")}>
            <Icon name="plus" /> Add property
          </button>
        </div>
      </div>

      <div className="scope-bar" role="tablist" aria-label="Tracking scope">
        {[
          { v: "active",   label: "Active" },
          { v: "archived", label: "Archived" },
          { v: "all",      label: "All" },
        ].map((o) => (
          <button
            key={o.v}
            type="button"
            role="tab"
            aria-selected={tracking === o.v}
            className={`scope-btn ${tracking === o.v ? "active" : ""}`}
            onClick={() => setTracking(o.v)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="filterbar">
        <div className="field grow">
          <Icon name="search" />
          <input placeholder="Search property or address" value={q} onChange={(e) => setQ(e.target.value)} />
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

      <MobileFilters
        q={q} setQ={setQ}
        state={state} setState={setState}
        city={city} setCity={setCity}
        listingState={listingState} setListingState={setListingState}
        cities={cities} states={states}
        open={filterPanelOpen} setOpen={setFilterPanelOpen}
        activeFilterCount={activeFilterCount}
      />

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <SortHeader label="Property"     k="display_label"   sort={sort} setSort={setSort} />
              <SortHeader label="Listing"      k="listing_state" sort={sort} setSort={setSort} />
              <SortHeader label="Est. value"   k="estimate"      sort={sort} setSort={setSort} align="right" />
              <SortHeader label="Price"        k="priceValue"    sort={sort} setSort={setSort} align="right" />
              <SortHeader label="vs Est."      k="priceVsEst"    sort={sort} setSort={setSort} align="right" />
              <SortHeader label="Added"        k="created_at"    sort={sort} setSort={setSort} defaultDir="desc" />
              <SortHeader label="Last refresh" k="updated_at"    sort={sort} setSort={setSort} defaultDir="desc" />
            </tr>
          </thead>
          <tbody>
            {loading && properties.length === 0 && (
              <tr><td colSpan={7} className="empty">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7}>
                <div className="empty">
                  <div className="title">{properties.length === 0 ? "No properties yet" : "No matches"}</div>
                  <div>
                    {properties.length === 0
                      ? <>Click <b>Add property</b> to fetch current data from Realtor.com.</>
                      : "Adjust the filters or search above."}
                  </div>
                </div>
              </td></tr>
            )}
            {rows.map((r) => {
              const sp = splitAddress(r.display_address || "");
              const hasName = Boolean(r.display_name);
              const secondary = hasName ? [sp.line1, sp.line2].filter(Boolean).join(", ") : sp.line2;
              return (
                <tr key={r.id} className={r.active === false ? "archived-row" : ""} onClick={() => navigate("detail", r.id)}>
                  <td className="address-cell">
                    <div className="address-cell-inner">
                      <button
                        className={`pin-btn ${r.pinned ? "is-pinned" : ""}`}
                        onClick={(e) => handleTogglePin(e, r)}
                        title={r.pinned ? "Unpin property" : "Pin property"}
                      >
                        <Icon
                          name="pin"
                          fill={r.pinned ? "currentColor" : "none"}
                          stroke="currentColor"
                          size={14}
                        />
                      </button>
                      <span className="address-text" title={hasName ? `${r.display_name} - ${secondary}` : r.display_address}>
                        {hasName ? r.display_name : sp.line1}
                        {secondary && <span className="sub"> · {secondary}</span>}
                      </span>
                      {r.active === false && <span className="badge neutral archived-inline">Archived</span>}
                    </div>
                  </td>
                  <td><ListingBadge state={r.listing_state} /></td>
                  <td className="num">{fmt.usd(r.estimate)}</td>
                  <td className="num"><PriceCell price={r.price} /></td>
                  <td className="num">
                    {r.price && r.price.base != null
                      ? <DeltaCell value={r.estimate} base={r.price.base} />
                      : <span className="faint">—</span>}
                  </td>
                  <td className="muted">
                    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                      <span style={{ color: "var(--text)" }}>{fmt.relative(r.created_at)}</span>
                      <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{fmt.shortDate(r.created_at)}</span>
                    </div>
                  </td>
                  <td className="muted">
                    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                      <span style={{ color: "var(--text)" }}>{fmt.relative(r.updated_at)}</span>
                      <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{fmt.shortDate(r.updated_at)}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile card list — hidden at ≥881px via CSS */}
      <div className="prop-list">
        {loading && properties.length === 0 && (
          <div className="empty" style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 8 }}>
            Loading…
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="empty" style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 8 }}>
            <div className="title">{properties.length === 0 ? "No properties yet" : "No matches"}</div>
            <div>
              {properties.length === 0
                ? <>Click <b>Add property</b> to start tracking.</>
                : "Try clearing some filters."}
            </div>
          </div>
        )}
        {rows.map((r) => {
          const sp = splitAddress(r.display_address || "");
          const hasName = Boolean(r.display_name);
          const secondary = hasName ? [sp.line1, sp.line2].filter(Boolean).join(", ") : sp.line2;
          return (
            <div
              key={r.id}
              className={`prop-card ${r.active === false ? "is-archived" : ""}`}
              onClick={() => navigate("detail", r.id)}
            >
              <div className="head">
                <div className="addr" style={{ flex: 1, minWidth: 0 }}>
                  {hasName ? r.display_name : sp.line1}
                  {secondary && <span className="sub">{secondary}</span>}
                </div>
                <button
                  className={`pin-btn ${r.pinned ? "is-pinned" : ""}`}
                  style={{ padding: 2, margin: 0, alignSelf: "flex-start" }}
                  onClick={(e) => handleTogglePin(e, r)}
                  title={r.pinned ? "Unpin property" : "Pin property"}
                >
                  <Icon
                    name="pin"
                    fill={r.pinned ? "currentColor" : "none"}
                    stroke="currentColor"
                    size={16}
                  />
                </button>
                <div className="head-right">
                  <ListingBadge state={r.listing_state} />
                </div>
              </div>
              {r.active === false && (
                <div style={{ padding: "0 0 6px", marginTop: -4 }}>
                  <span className="badge neutral">Archived</span>
                </div>
              )}
              <div className="body">
                <div className="kv">
                  <div className="k">Estimate</div>
                  <div className="v">{fmt.usd(r.estimate)}</div>
                </div>
                <div className="kv">
                  <div className="k">{r.price ? r.price.label : "Price"}</div>
                  <div className="v">
                    {r.price
                      ? <span className={r.price.cls === "hist" ? "faint" : undefined}>{fmt.usd(r.price.value)}</span>
                      : <span className="faint">—</span>}
                  </div>
                </div>
                <div className="kv">
                  <div className="k">vs Est.</div>
                  <div className="v">
                    {r.price && r.price.base != null
                      ? <DeltaCell value={r.estimate} base={r.price.base} mode="text" />
                      : <span className="faint">—</span>}
                  </div>
                </div>
              </div>
              <div className="foot">
                <span>Last refresh · {fmt.relative(r.updated_at)}</span>
                <span><Icon name="chevronRight" /></span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Add Property ----------
function StatusBadge({ status }) {
  const meta = {
    matched: { label: "Matched", cls: "ok" },
    candidate_mismatch: { label: "Review match", cls: "warn" },
    no_candidates: { label: "No match", cls: "neutral" },
    error: { label: "Error", cls: "err" },
  }[status] || { label: status || "Unknown", cls: "neutral" };

  return <span className={`badge ${meta.cls}`}>{meta.label}</span>;
}

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
        Enter a full street address. We'll fetch the latest Realtor.com data and
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
            Include city, state, ZIP for the best match. The fetch runs server-side against Realtor.com.
          </div>

          {phase === "searching" && (
            <div style={{ marginTop: 16, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "var(--accent)", animation: "pulse 1.2s infinite"
              }} />
              Fetching from Realtor.com…
            </div>
          )}

          {phase === "mismatch" && result && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <StatusBadge status="candidate_mismatch" />
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Realtor.com returned a candidate that doesn't exactly match your input. Confirm before saving.
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
                Realtor.com didn't surface any properties for that address. Check spelling and ZIP and try again.
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
                {errorMsg || "Something went wrong contacting Realtor.com. Try again in a moment."}
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

function formatPropertyType(type, subType) {
  if (!type && !subType) return "—";
  const pretty = (s) => String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (type && subType && subType !== type) return `${pretty(type)} · ${pretty(subType)}`;
  return pretty(type || subType);
}


function schoolLevelLabel(levels) {
  if (!levels) return "";
  if (levels.includes("elementary")) return "Elementary";
  if (levels.includes("middle")) return "Middle";
  if (levels.includes("high")) return "High";
  return levels.split(",")[0];
}

function ratingClass(rating) {
  if (rating == null) return "neutral";
  if (rating >= 8) return "ok";
  if (rating >= 5) return "info";
  if (rating >= 3) return "warn";
  return "err";
}

function SchoolsCard({ schools }) {
  if (!schools || schools.length === 0) return null;
  return (
    <div className="card">
      <div className="card-header"><div className="card-title">Schools</div></div>
      <div className="card-body flush">
        <div className="facts-stack">
          {schools.map((s) => (
            <div key={s.school_id} className="fact-row" style={{ alignItems: "center" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                <span className="v" style={{ fontWeight: 500, whiteSpace: "normal" }}>{s.name}</span>
                <span className="k" style={{ fontSize: 11 }}>
                  {schoolLevelLabel(s.education_levels)}
                  {s.funding_type === "private" ? " · Private" : ""}
                  {s.distance_in_miles != null ? ` · ${s.distance_in_miles} mi` : ""}
                </span>
              </div>
              <span className={`badge ${ratingClass(s.rating)}`} style={{ marginLeft: 8 }}>
                {s.rating != null ? `${s.rating}/10` : "NR"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Realtor's photo CDN (rdcpix) serves each image at several sizes, picked by a
// 1–2 letter code right before ".jpg". The feed hands us "s" (120px wide), which
// renders blurry stretched across a 3:2 card — swap in a display-appropriate size
// ("x" = 460px, "od" = 1024px). Non-rdcpix or unrecognized URLs pass through.
const RDC_SIZE_RE = /(\d)(od|rd|o|s|t|m|l|x)(\.jpg)(\?.*)?$/i;
function rdcResize(url, size) {
  if (!url || !RDC_SIZE_RE.test(url)) return url;
  // Upgrade http→https too, so the photos aren't mixed-content blocked on an
  // HTTPS deployment (the feed stores http rdcpix URLs).
  return url.replace(/^http:/i, "https:").replace(RDC_SIZE_RE, `$1${size}$3$4`);
}

// "City, State ZIP" line for a comp card — assembled from whatever locality
// fields the listing carries, so cards show the same City/State/ZIP context the
// design calls for under the street address. Returns "" when none are present.
function compCityLine(comp) {
  return [comp.city, [comp.state, comp.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
}

// Track a comparable listing as a real tracked property. Runs the same add flow
// as the Add Property page — POST the comp's full address, and auto-confirm a
// candidate mismatch since the address comes straight from a Realtor listing the
// user explicitly picked. On success it refreshes the dashboard list (so the new
// property + its detail page appear) and routes to the freshly created PDP.
// Returns the button state shared by both comp card layouts.
function useTrackComp(comp, navigate, onChanged) {
  const [tracked, setTracked] = useState_p(false);
  const [saving, setSaving] = useState_p(false);
  const toast = useToast();
  const addr = comp.line || comp.address || "this home";
  const fullAddr = comp.line
    ? [comp.line, compCityLine(comp)].filter(Boolean).join(", ")
    : (comp.address || "");

  async function track() {
    if (saving || tracked || !fullAddr) {
      if (!fullAddr) toast.push({ kind: "err", text: "This listing is missing an address to track." });
      return;
    }
    setSaving(true);
    try {
      let res = await API.addProperty(fullAddr, false);
      if (res && res.status === "candidate_mismatch") {
        res = await API.addProperty(fullAddr, true);
      }
      if (res && res.property) {
        setTracked(true);
        const line1 = splitAddress(displayAddress(res.property)).line1;
        toast.push({ kind: "ok", text: `Now tracking ${line1}` });
        if (onChanged) onChanged();
        if (navigate) navigate("detail", res.property.id);
      } else if (res && res.status === "no_candidates") {
        toast.push({ kind: "err", text: `Couldn't find ${addr} on Realtor.com.` });
      } else {
        toast.push({ kind: "err", text: (res && res.error) || "Couldn't track this home." });
      }
    } catch (e) {
      toast.push({ kind: "err", text: e.message || "Couldn't track this home." });
    } finally {
      setSaving(false);
    }
  }

  return { tracked, saving, track };
}

// One comparable listing — a photo-forward card (design Option A). 3:2 listing
// photo with a days-on-market pill and the appraisal match score, then address +
// distance, list price + the listing's own $/sqft, and beds·baths·sqft. "Track"
// adds the comp as a real tracked property (see useTrackComp); the ↗ button
// opens the listing on Realtor.com.
function CompCard({ comp, navigate, onChanged }) {
  const { tracked, saving, track } = useTrackComp(comp, navigate, onChanged);
  const addr = comp.line || comp.address || "—";
  const cityLine = compCityLine(comp);

  return (
    <div className="cmpA-card">
      <div className="cmp-photo">
        {comp.days_on_market != null && <span className="cmp-dom">{comp.days_on_market}d on market</span>}
        {comp.comp_score != null && <span className="cmp-match">{comp.comp_score}% match</span>}
        {comp.photo_url
          ? <img
              src={rdcResize(comp.photo_url, "x")}
              srcSet={`${rdcResize(comp.photo_url, "x")} 1x, ${rdcResize(comp.photo_url, "od")} 2x`}
              alt=""
              loading="lazy"
            />
          : <span>listing photo</span>}
      </div>
      <div className="cmpA-body">
        <div className="cmpA-addr-row">
          <div className="cmpA-addr-wrap">
            <span className="cmpA-addr" title={cityLine ? `${addr}, ${cityLine}` : addr}>{addr}</span>
            {cityLine && <span className="cmpA-city">{cityLine}</span>}
          </div>
          {comp.distance_mi != null && <span className="cmpA-dist">{comp.distance_mi} mi</span>}
        </div>
        <div className="cmpA-price-row">
          <span className="cmpA-price">{comp.list_price != null ? fmt.usd(comp.list_price) : "—"}</span>
          {comp.price_per_sqft != null && <span className="cmpA-ppsf">{fmt.usd(comp.price_per_sqft)}/sqft</span>}
        </div>
        <div className="cmpA-specs">
          <span>{comp.beds != null ? `${comp.beds} bd` : "— bd"}</span><span className="dot"></span>
          <span>{comp.baths != null ? `${fmt.baths(comp.baths)} ba` : "— ba"}</span><span className="dot"></span>
          <span>{comp.sqft != null ? `${fmt.num(comp.sqft)} sqft` : "— sqft"}</span>
        </div>
        {comp.is_price_reduced && (
          <div className="cmpA-flags">
            <span className="badge warn">Price reduced</span>
          </div>
        )}
        <div className="cmpA-foot">
          <button
            className={"cmp-track" + (tracked ? " on" : "")}
            onClick={track}
            disabled={saving || tracked}
            title={tracked ? "Tracking — added to your properties" : "Add to HomeTracker"}
          >
            <Icon name={tracked ? "check" : "plus"} size={13} />
            {saving ? "Tracking…" : tracked ? "Tracking" : "Track"}
          </button>
          {comp.property_url && (
            <a
              className="cmp-link"
              href={comp.property_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open listing on Realtor.com"
            >
              <Icon name="arrowUpRight" size={13} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact two-up card — the phone-width treatment of a comparable home. Denser
// than CompCard: a 4:3 photo with the days-on-market badge, then price, address,
// a single specs line, and a meta row pairing distance · days-on-market against
// $/sqft. Keeps the same footer as the desktop card (full-width Track button +
// open-listing link); only the "price reduced" flag is dropped to save room.
function CompCardCompact({ comp, navigate, onChanged }) {
  const { tracked, saving, track } = useTrackComp(comp, navigate, onChanged);
  const addr = comp.line || comp.address || "—";
  const cityLine = compCityLine(comp);

  const metaLeft = [
    comp.distance_mi != null ? `${comp.distance_mi} mi` : null,
    comp.days_on_market != null ? `${comp.days_on_market}d` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="cmpM-card">
      <div className="cmp-photo">
        {comp.days_on_market != null && <span className="cmp-dom">{comp.days_on_market}d</span>}
        {comp.photo_url
          ? <img
              src={rdcResize(comp.photo_url, "x")}
              srcSet={`${rdcResize(comp.photo_url, "x")} 1x, ${rdcResize(comp.photo_url, "od")} 2x`}
              alt=""
              loading="lazy"
            />
          : <span>listing photo</span>}
      </div>
      <div className="cmpM-body">
        <div className="cmpM-priceline">
          <span className="cmpM-price">{comp.list_price != null ? fmt.usd(comp.list_price) : "—"}</span>
        </div>
        <div className="cmpM-addr" title={cityLine ? `${addr}, ${cityLine}` : addr}>{addr}</div>
        {cityLine && <div className="cmpM-city">{cityLine}</div>}
        <div className="cmpM-specs">
          {comp.beds != null ? `${comp.beds} bd` : "— bd"} · {comp.baths != null ? `${fmt.baths(comp.baths)} ba` : "— ba"} · {comp.sqft != null ? `${fmt.num(comp.sqft)} sqft` : "— sqft"}
        </div>
        <div className="cmpM-metarow">
          <span className="cmpM-dist">{metaLeft || "—"}</span>
          {comp.price_per_sqft != null && <span className="cmpM-dist">{fmt.usd(comp.price_per_sqft)}/sf</span>}
        </div>
        <div className="cmpM-foot">
          <button
            className={"cmp-track" + (tracked ? " on" : "")}
            onClick={track}
            disabled={saving || tracked}
            title={tracked ? "Tracking — added to your properties" : "Add to HomeTracker"}
          >
            <Icon name={tracked ? "check" : "plus"} size={13} />
            {saving ? "Tracking…" : tracked ? "Tracking" : "Track"}
          </button>
          {comp.property_url && (
            <a
              className="cmp-link"
              href={comp.property_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open listing on Realtor.com"
            >
              <Icon name="arrowUpRight" size={13} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Range-based comp filters — set a low/high band per dimension, like the
// price / beds / sqft range controls on the major listing portals. Each
// dimension is a pill that opens a popover holding a draggable range slider
// (plus editable Min/Max), instead of the read-only scope chips that used to
// sit here. Filtering is purely client-side over the already-loaded comp set,
// so it never triggers a Realtor fetch.
// ============================================================
const usdK = (v) => fmt.usd(v, { compact: true });

// nice rounding helpers
const floorTo = (v, s) => Math.floor(v / s) * s;
const ceilTo  = (v, s) => Math.ceil(v / s) * s;
const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Pill + popover shell shared by every range filter. The popover defaults to
// opening leftward (right-anchored under the pill) the way the design intends
// when the filters sit at the header's right edge. When the filter row wraps to
// the left at constrained widths, right-anchoring would run off the left edge —
// so on open we measure the pill and flip to left-anchored if that would clip.
function FilterPop({ label, summary, active, popWidth, children }) {
  const [open, setOpen] = useState_p(false);
  const [alignLeft, setAlignLeft] = useState_p(false);
  const ref = React.useRef(null);
  useEffect_p(() => {
    if (!open) return;
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", off, true);
    return () => document.removeEventListener("pointerdown", off, true);
  }, [open]);
  React.useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const w = Math.min(popWidth || 300, window.innerWidth - 28);
    // The popover is clipped by the nearest scrolling/hidden ancestor (the page
    // scroll container), not the viewport — measure against that boundary. Right-
    // anchored, the menu spans [r.right - w, r.right]; flip to left-anchored when
    // its left edge would fall past the clip boundary's left edge.
    let clipLeft = 8, node = ref.current.parentElement;
    while (node) {
      const ox = getComputedStyle(node).overflowX;
      if (ox === "auto" || ox === "hidden" || ox === "scroll" || ox === "clip") {
        clipLeft = node.getBoundingClientRect().left;
        break;
      }
      node = node.parentElement;
    }
    setAlignLeft(r.right - w < clipLeft + 4);
  }, [open, popWidth]);
  return (
    <div className={"cmp-filter" + (open ? " open" : "")} ref={ref}>
      <button
        type="button"
        className={"cmp-filter-btn" + (active ? " active" : "")}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}>
        <span className="k">{label}</span>
        <b>{summary}</b>
        <svg className="chev" width="11" height="11" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open &&
        <div className={"cmp-filter-menu cmp-rangepop" + (alignLeft ? " align-left" : "")}
             style={popWidth ? { width: popWidth } : null}>
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>}
    </div>);
}

// Dual-handle range slider (drag either thumb). Optional histogram behind it.
function RangeSlider({ min, max, step, value, onChange, hist }) {
  const [lo, hi] = value;
  const trackRef = React.useRef(null);
  const span = max - min || 1;
  const pct = (v) => ((v - min) / span) * 100;

  const startDrag = (which) => (e) => {
    e.preventDefault();
    const el = trackRef.current;
    const move = (ev) => {
      const r = el.getBoundingClientRect();
      const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
      let t = clamp((cx - r.left) / r.width, 0, 1);
      let v = Math.round((min + t * (max - min)) / step) * step;
      v = clamp(v, min, max);
      if (which === 0) onChange([Math.min(v, hi - step), hi]);
      else onChange([lo, Math.max(v, lo + step)]);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", up);
  };

  return (
    <div className="rs">
      {hist && hist.length > 0 &&
        <div className="rs-hist">
          {hist.map((h, i) => {
            const c = min + ((i + 0.5) / hist.length) * (max - min);
            const inRange = c >= lo && c <= hi;
            return <span key={i} className={"rs-bar" + (inRange ? " in" : "")} style={{ height: (10 + h * 30) + "px" }} />;
          })}
        </div>}
      <div className="rs-track" ref={trackRef}>
        <div className="rs-fill" style={{ left: pct(lo) + "%", right: (100 - pct(hi)) + "%" }} />
        <button type="button" className="rs-thumb" style={{ left: pct(lo) + "%" }}
          onPointerDown={startDrag(0)} aria-label="Minimum" />
        <button type="button" className="rs-thumb" style={{ left: pct(hi) + "%" }}
          onPointerDown={startDrag(1)} aria-label="Maximum" />
      </div>
    </div>);
}

// Single-handle slider (used for distance — a "within X" threshold).
function SoloSlider({ min, max, step, value, onChange }) {
  const trackRef = React.useRef(null);
  const span = max - min || 1;
  const pct = (v) => ((v - min) / span) * 100;
  const startDrag = (e) => {
    e.preventDefault();
    const el = trackRef.current;
    const move = (ev) => {
      const r = el.getBoundingClientRect();
      const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
      let t = clamp((cx - r.left) / r.width, 0, 1);
      let v = Math.round((min + t * (max - min)) / step) * step;
      onChange(clamp(v, min, max));
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", up);
  };
  return (
    <div className="rs">
      <div className="rs-track" ref={trackRef}>
        <div className="rs-fill" style={{ left: 0, right: (100 - pct(value)) + "%" }} />
        <button type="button" className="rs-thumb" style={{ left: pct(value) + "%" }}
          onPointerDown={startDrag} aria-label="Distance" />
      </div>
    </div>);
}

// Editable Min / Max boxes that mirror the slider.
function MinMaxBox({ prefix, suffix, value, display, onCommit }) {
  const [draft, setDraft] = useState_p(null);
  const shown = draft != null ? draft : display(value);
  return (
    <label className="rs-num">
      {prefix && <span className="px">{prefix}</span>}
      <input
        value={shown}
        inputMode="numeric"
        onFocus={(e) => { setDraft(String(value)); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={(e) => { const n = parseInt((e.target.value || "").replace(/[^\d]/g, ""), 10); onCommit(Number.isNaN(n) ? value : n); setDraft(null); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      {suffix && <span className="sx">{suffix}</span>}
    </label>);
}

function RangeFooter({ onReset, onDone, disabled }) {
  return (
    <div className="rs-foot">
      <button type="button" className="rs-reset" onClick={onReset} disabled={disabled}>Reset</button>
      <button type="button" className="rs-done" onClick={onDone}>Done</button>
    </div>);
}

// Beds — Redfin-style "tap two numbers to select a range".
const BED_STOPS = [1, 2, 3, 4, 5];
function BedsControl({ value, onChange }) {
  // value === null => Any; otherwise [lo, hi]
  function tap(v) {
    if (!value) { onChange([v, v]); return; }
    const [lo, hi] = value;
    if (lo === hi) onChange([Math.min(lo, v), Math.max(lo, v)]);
    else onChange([v, v]); // a full range exists → start over
  }
  const inRange = (v) => value && v >= value[0] && v <= value[1];
  const isEnd = (v) => value && (v === value[0] || v === value[1]);
  return (
    <div className="rs-beds">
      <button type="button" className={"rs-bedpill" + (!value ? " on" : "")} onClick={() => onChange(null)}>Any</button>
      {BED_STOPS.map((v) =>
        <button key={v} type="button"
          className={"rs-bedpill" + (inRange(v) ? " in" : "") + (isEnd(v) ? " end" : "")}
          onClick={() => tap(v)}>{v === 5 ? "5+" : v}</button>)}
    </div>);
}

// Comparable homes for sale in this property's ZIP — Option A photo card grid,
// sitting full-width below the activity timeline. Reads a server-side cache
// (refreshed only when the user refreshes the property — this module never
// triggers a Realtor fetch, so opening a detail page adds no upstream traffic),
// which the server gates + ranks into appraisal-style comps. Header shows the
// count and portal-style range filters (price / beds / sqft / distance) that
// narrow the loaded comp set client-side — no upstream fetch. Filter domains
// (and the price histogram behind the price slider) are derived from the actual
// comp set, so the sliders always span the real listings. Empty state points the
// user at refresh; a relaxed note shows when strict gating fell back to a looser
// comp set; a separate empty state shows when filters exclude every comp.
function AreaListingsCard({ property, navigate, onChanged }) {
  const [state, setState] = useState_p({ loading: true, error: null, data: null });
  // Switch to the compact two-up grid at the same width the desktop card grid
  // would otherwise collapse to a single column, so comps stay two-up on phones.
  const isMobile = useIsMobile(560);

  useEffect_p(() => {
    let alive = true;
    setState({ loading: true, error: null, data: null });
    API.getAreaListings(property.id)
      .then((data) => { if (alive) setState({ loading: false, error: null, data }); })
      .catch((e) => { if (alive) setState({ loading: false, error: e.message || "Failed to load", data: null }); });
    return () => { alive = false; };
  }, [property.id]);

  const { loading, error, data } = state;
  // Stable reference between renders so the domain/reset memos below don't churn.
  const allComps = useMemo_p(() => (data && data.comps) || [], [data]);
  const fetchedAt = data && data.fetched_at;
  const subjectPpsf = data && data.subject_price_per_sqft;
  const line1 = splitAddress(displayAddress(property)).line1;

  // Slider domains + a smoothed price histogram derived from the comp set. Each
  // band is padded out to a round step so the handles sit just past the extremes.
  // Degenerate (no values) → zero-width domain; the matching pill reads "Any".
  const dom = useMemo_p(() => {
    const prices = allComps.map((c) => c.list_price).filter((v) => v != null);
    const sqfts  = allComps.map((c) => c.sqft).filter((v) => v != null);
    const dists  = allComps.map((c) => c.distance_mi).filter((v) => v != null);
    const pLo = prices.length ? Math.max(0, floorTo(Math.min(...prices), 25000) - 25000) : 0;
    const pHi = prices.length ? ceilTo(Math.max(...prices), 25000) + 25000 : 0;
    const sLo = sqfts.length ? Math.max(0, floorTo(Math.min(...sqfts), 100) - 100) : 0;
    const sHi = sqfts.length ? ceilTo(Math.max(...sqfts), 100) + 100 : 0;
    const dMax = dists.length ? Math.max(1, ceilTo(Math.max(...dists), 0.5)) : 1;
    const N = 30, bw = (pHi - pLo) / 6 || 1;
    const raw = Array.from({ length: N }, (_, i) => {
      const x = pLo + ((i + 0.5) / N) * (pHi - pLo);
      return prices.reduce((s, p) => { const d = (x - p) / bw; return s + Math.exp(-0.5 * d * d); }, 0);
    });
    const mx = Math.max(...raw) || 1;
    return { pLo, pHi, sLo, sHi, dMax, hist: prices.length ? raw.map((v) => v / mx) : [] };
  }, [allComps]);

  const [price, setPrice] = useState_p([dom.pLo, dom.pHi]);
  const [sqft,  setSqft]  = useState_p([dom.sLo, dom.sHi]);
  const [beds,  setBeds]  = useState_p(null);
  const [dist,  setDist]  = useState_p(dom.dMax);

  // Reset the bands to the full domain whenever a new comp set loads (property
  // change → refetch → new allComps → new dom).
  useEffect_p(() => {
    setPrice([dom.pLo, dom.pHi]); setSqft([dom.sLo, dom.sHi]);
    setBeds(null); setDist(dom.dMax);
  }, [dom]);

  const priceActive = price[0] > dom.pLo || price[1] < dom.pHi;
  const sqftActive  = sqft[0] > dom.sLo || sqft[1] < dom.sHi;
  const bedsActive  = beds !== null;
  const distActive  = dist < dom.dMax;
  const anyFilter   = priceActive || sqftActive || bedsActive || distActive;

  // Filter the loaded comps. A comp missing a dimension isn't excluded on it —
  // we only hide listings that actively fall outside a band the user set.
  const comps = useMemo_p(
    () => allComps.filter((c) =>
      (c.list_price == null || (c.list_price >= price[0] && c.list_price <= price[1])) &&
      (c.sqft == null || (c.sqft >= sqft[0] && c.sqft <= sqft[1])) &&
      (c.distance_mi == null || c.distance_mi <= dist) &&
      (beds === null || c.beds == null || (c.beds >= beds[0] && (beds[1] >= 5 || c.beds <= beds[1])))),
    [allComps, price, sqft, dist, beds]
  );

  function clearAll() {
    setPrice([dom.pLo, dom.pHi]); setSqft([dom.sLo, dom.sHi]);
    setBeds(null); setDist(dom.dMax);
  }

  // Pill summaries.
  const priceSummary = !priceActive ? "Any"
    : price[0] <= dom.pLo ? "Up to " + usdK(price[1])
    : price[1] >= dom.pHi ? usdK(price[0]) + "+"
    : usdK(price[0]) + "–" + usdK(price[1]);
  const sqftSummary = !sqftActive ? "Any"
    : sqft[0] <= dom.sLo ? "Up to " + fmt.num(sqft[1])
    : sqft[1] >= dom.sHi ? fmt.num(sqft[0]) + "+"
    : fmt.num(sqft[0]) + "–" + fmt.num(sqft[1]);
  const bedLabel = (v) => (v >= 5 ? "5+" : String(v));
  const bedsSummary = !beds ? "Any"
    : beds[0] === beds[1] ? bedLabel(beds[0])
    : (beds[1] >= 5 ? beds[0] + "+" : beds[0] + "–" + beds[1]);
  const distSummary = !distActive ? "Any" : "≤ " + (dist % 1 === 0 ? dist : dist.toFixed(1)) + " mi";

  return (
    <div className="cmp-module">
      <div className="cmp-head">
        <div className="cmp-head-l">
          <h2 className="cmp-title">
            Comparable homes for sale
            {allComps.length > 0 && <span className="cmp-count">{comps.length}</span>}
          </h2>
          <div className="cmp-sub">
            Active listings near <b>{line1}</b>
            {data && data.zip ? ` · ${data.zip}` : ""}
            {subjectPpsf != null ? ` · this home ${fmt.usd(subjectPpsf)}/sqft` : ""}
            {fetchedAt ? ` · updated ${fmt.relative(fetchedAt)}` : ""}
          </div>
        </div>
        {allComps.length > 0 && (
          <div className="cmp-head-r">

            <FilterPop label="Price" summary={priceSummary} active={priceActive} popWidth={300}>
              {(close) => (
                <div className="rs-pop">
                  <div className="rs-fields">
                    <MinMaxBox prefix="$" value={price[0]} display={(v) => v.toLocaleString()}
                      onCommit={(n) => setPrice([clamp(n, dom.pLo, price[1]), price[1]])} />
                    <span className="rs-dash">–</span>
                    <MinMaxBox prefix="$" value={price[1]} display={(v) => v.toLocaleString()}
                      onCommit={(n) => setPrice([price[0], clamp(n, price[0], dom.pHi)])} />
                  </div>
                  <RangeSlider min={dom.pLo} max={dom.pHi} step={5000} value={price} onChange={setPrice} hist={dom.hist} />
                  <div className="rs-ends"><span>{usdK(dom.pLo)}</span><span>{usdK(dom.pHi)}+</span></div>
                  <RangeFooter disabled={!priceActive} onDone={close}
                    onReset={() => setPrice([dom.pLo, dom.pHi])} />
                </div>
              )}
            </FilterPop>

            <FilterPop label="Beds" summary={bedsSummary} active={bedsActive} popWidth={264}>
              {(close) => (
                <div className="rs-pop">
                  <div className="rs-hint">Tap two numbers to set a range</div>
                  <BedsControl value={beds} onChange={setBeds} />
                  <RangeFooter disabled={!bedsActive} onDone={close} onReset={() => setBeds(null)} />
                </div>
              )}
            </FilterPop>

            <FilterPop label="Sqft" summary={sqftSummary} active={sqftActive} popWidth={284}>
              {(close) => (
                <div className="rs-pop">
                  <div className="rs-fields">
                    <MinMaxBox value={sqft[0]} suffix="sqft" display={(v) => v.toLocaleString()}
                      onCommit={(n) => setSqft([clamp(n, dom.sLo, sqft[1]), sqft[1]])} />
                    <span className="rs-dash">–</span>
                    <MinMaxBox value={sqft[1]} suffix="sqft" display={(v) => v.toLocaleString()}
                      onCommit={(n) => setSqft([sqft[0], clamp(n, sqft[0], dom.sHi)])} />
                  </div>
                  <RangeSlider min={dom.sLo} max={dom.sHi} step={50} value={sqft} onChange={setSqft} />
                  <div className="rs-ends"><span>{fmt.num(dom.sLo)}</span><span>{fmt.num(dom.sHi)}+</span></div>
                  <RangeFooter disabled={!sqftActive} onDone={close}
                    onReset={() => setSqft([dom.sLo, dom.sHi])} />
                </div>
              )}
            </FilterPop>

            <FilterPop label="Distance" summary={distSummary} active={distActive} popWidth={244}>
              {(close) => (
                <div className="rs-pop">
                  <div className="rs-readout">Within <b>{dist % 1 === 0 ? dist : dist.toFixed(1)} mi</b></div>
                  <SoloSlider min={0.5} max={dom.dMax} step={0.5} value={dist} onChange={setDist} />
                  <div className="rs-ends"><span>½ mi</span><span>{dom.dMax} mi</span></div>
                  <RangeFooter disabled={!distActive} onDone={close} onReset={() => setDist(dom.dMax)} />
                </div>
              )}
            </FilterPop>

            {anyFilter && (
              <button type="button" className="cmp-clear" onClick={clearAll}>
                <Icon name="x" size={12} /> Clear
              </button>
            )}
          </div>
        )}
      </div>

      {data && data.relaxed && allComps.length > 0 && (
        <div className="cmp-note">Few strict comps — {data.relaxed}.</div>
      )}

      {loading ? (
        <div className="cmp-state">Loading comparable homes…</div>
      ) : error ? (
        <div className="cmp-state">{error}</div>
      ) : allComps.length === 0 ? (
        <div className="cmp-state">
          {fetchedAt
            ? "No comparable for-sale homes in this ZIP."
            : "Refresh this property to find comparable homes for sale in its ZIP."}
        </div>
      ) : comps.length === 0 ? (
        <div className="cmp-empty">
          No comparable listings match these filters.{" "}
          <button type="button" className="cmp-empty-reset" onClick={clearAll}>Reset filters</button>
        </div>
      ) : (
        <div className={isMobile ? "cmpM-grid" : "cmpA-grid"}>
          {comps.map((c) => isMobile
            ? <CompCardCompact key={c.property_id} comp={c} navigate={navigate} onChanged={onChanged} />
            : <CompCard key={c.property_id} comp={c} navigate={navigate} onChanged={onChanged} />)}
        </div>
      )}
    </div>
  );
}

// ---------- Listing photos ----------
// Sidebar reference card (design Option D) + full-screen lightbox. Photos come
// from Realtor.com (GET /api/properties/{id} → `photos: [{href, label}]`); the
// first is the hero. Card stays restrained so the chart/activity lead the page:
// hero + 3-up thumbnail row (last tile shows the overflow count) + "View all
// photos". Everything opens the lightbox, where the full set is lazy-loaded.
function PhotoCIcon({ name, size = 13 }) {
  const p = {
    camera: <><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l1.2-1.8A1 1 0 0 1 9 4.7h6a1 1 0 0 1 .8.5L17 7h2.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" /><circle cx="12" cy="12.5" r="3.2" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round">{p[name]}</svg>;
}

// Full-screen photo viewer. Arrows + filmstrip; ←/→/Esc keyboard nav. The hero
// is fetched at the large rdcpix size on demand (only the current frame), and
// the filmstrip thumbnails are lazy-loaded so opening the modal doesn't pull
// every photo at once.
function PhotoLightbox({ photos, open, start = 0, onClose }) {
  const [i, setI] = useState_p(start);
  const [heroLoaded, setHeroLoaded] = useState_p(false);
  const stripRef = React.useRef(null);
  useEffect_p(() => { if (open) setI(start); }, [open, start]);
  // Fade each hero in as it loads so navigation doesn't flash the prior frame.
  useEffect_p(() => { setHeroLoaded(false); }, [i, open]);
  useEffect_p(() => {
    if (!open) return;
    const n = photos.length;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setI((p) => (p + 1) % n);
      if (e.key === "ArrowLeft") setI((p) => (p - 1 + n) % n);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, photos.length]);
  // Keep the active filmstrip thumbnail centered in view as you navigate.
  useEffect_p(() => {
    if (!open) return;
    const strip = stripRef.current;
    const active = strip && strip.children[i];
    if (active) {
      // Instant (not smooth) so holding the arrow keys keeps the active thumb
      // centered instead of cancelling a half-finished smooth scroll each step.
      active.scrollIntoView({ inline: "center", block: "nearest" });
    }
  }, [i, open]);
  if (!open || !photos.length) return null;
  const n = photos.length;
  const go = (d) => setI((p) => (p + d + n) % n);
  const cur = photos[i];
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-bar">
          <span className="lightbox-count">
            <b>{i + 1}</b> / {n}{cur.label ? <span className="lightbox-room"> · {cur.label}</span> : ""}
          </span>
          <button className="lightbox-close" onClick={onClose} aria-label="Close"><Icon name="x" size={15} /></button>
        </div>
        <div className="lightbox-stage">
          {n > 1 && <button className="lb-arrow left" onClick={() => go(-1)} aria-label="Previous"><Icon name="chevronLeft" size={20} /></button>}
          <img
            key={i}
            className={`lb-hero ${heroLoaded ? "ready" : ""}`}
            src={rdcResize(cur.href, "od")}
            alt={cur.label || ""}
            onLoad={() => setHeroLoaded(true)}
          />
          {n > 1 && <button className="lb-arrow right" onClick={() => go(1)} aria-label="Next"><Icon name="chevronRight" size={20} /></button>}
        </div>
        {n > 1 && (
          <div className="lightbox-strip" ref={stripRef}>
            {photos.map((ph, k) => (
              <div key={k} className={`lb-thumb ${k === i ? "on" : ""}`} onClick={() => setI(k)}>
                <img src={rdcResize(ph.href, "x")} alt={ph.label || ""} loading="lazy" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PropertyPhotosCard({ photos }) {
  const [lb, setLb] = useState_p(null); // null = closed, else start index
  if (!photos || !photos.length) return null;
  const n = photos.length;
  const hero = photos[0];
  const overflow = n - 4; // photos beyond the hero + 3 thumbnails
  const thumbIdxs = [1, 2, 3].filter((k) => photos[k]);
  return (
    <div className="card photo-card" style={{ marginBottom: 12 }}>
      <div className="pc-hero" onClick={() => setLb(0)}>
        <img
          src={rdcResize(hero.href, "x")}
          srcSet={`${rdcResize(hero.href, "x")} 1x, ${rdcResize(hero.href, "od")} 2x`}
          alt={hero.label || ""}
        />
        <span className="count-pill"><PhotoCIcon name="camera" size={13} /> {n} photos</span>
      </div>
      {thumbIdxs.length > 0 && (
        <div className="pc-thumbs">
          {thumbIdxs.map((k) => {
            const showMore = k === thumbIdxs[thumbIdxs.length - 1] && overflow > 0;
            return showMore ? (
              <div key={k} className="pc-more" onClick={() => setLb(k)}>
                <div className="photo" style={{ borderRadius: 6 }}>
                  <img src={rdcResize(photos[k].href, "x")} alt={photos[k].label || ""} />
                </div>
                <span>+{overflow}</span>
              </div>
            ) : (
              <div key={k} className="photo" style={{ borderRadius: 6 }} onClick={() => setLb(k)}>
                <img src={rdcResize(photos[k].href, "x")} alt={photos[k].label || ""} />
              </div>
            );
          })}
        </div>
      )}
      <button className="btn pc-btn" onClick={() => setLb(0)}>
        <PhotoCIcon name="grid" size={13} /> View all photos
      </button>
      <PhotoLightbox photos={photos} open={lb != null} start={lb || 0} onClose={() => setLb(null)} />
    </div>
  );
}

// ---------- Property Detail ----------
function PropertyDetailPage({ propertyId, navigate, onChanged }) {
  const [property, setProperty] = useState_p(null);
  const [loading, setLoading] = useState_p(true);
  const [refreshing, setRefreshing] = useState_p(false);
  const [backfilling, setBackfilling] = useState_p(false);
  const [aiSettings, setAISettings] = useState_p(null);
  const [tab, setTab] = useState_p("history");
  const [managementMode, setManagementMode] = useState_p(null); // edit | delete
  const [editForm, setEditForm] = useState_p(null);
  const [savingManagement, setSavingManagement] = useState_p(false);
  const [actionMenuOpen, setActionMenuOpen] = useState_p(false);
  const actionMenuRef = React.useRef(null);
  const aiPanelRef = React.useRef(null);
  const toast = useToast();

  useEffect_p(() => {
    let cancelled = false;
    setLoading(true);
    setActionMenuOpen(false);
    API.getProperty(propertyId)
      .then((p) => { if (!cancelled) setProperty(p); })
      .catch((e) => { if (!cancelled) toast.push({ kind: "err", text: e.message }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [propertyId]);

  useEffect_p(() => {
    let cancelled = false;
    API.getAISettings()
      .then((settings) => { if (!cancelled) setAISettings(settings); })
      .catch(() => { if (!cancelled) setAISettings({ enabled: false, has_deepseek_api_key: false, deepseek_api_key_env_var: "DEEPSEEK_API_KEY" }); });
    return () => { cancelled = true; };
  }, []);

  useEffect_p(() => {
    if (!actionMenuOpen) return;

    function handleOutsidePress(e) {
      if (!actionMenuRef.current || actionMenuRef.current.contains(e.target)) return;
      setActionMenuOpen(false);
    }

    function handleKeyDown(e) {
      if (e.key === "Escape") setActionMenuOpen(false);
    }

    document.addEventListener("mousedown", handleOutsidePress);
    document.addEventListener("touchstart", handleOutsidePress);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsidePress);
      document.removeEventListener("touchstart", handleOutsidePress);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionMenuOpen]);

  async function doRefresh() {
    setRefreshing(true);
    try {
      const updated = await API.refresh(propertyId);
      setProperty(updated);
      onChanged?.();
      toast.push({ kind: "ok", text: "Data refreshed" });
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
        toast.push({ kind: "ok", text: `Backfilled ${res.written} estimates · ${res.events_written || 0} events · ${res.taxes_written || 0} tax rows` });
      }
    } catch (e) {
      toast.push({ kind: "err", text: e.message });
    } finally {
      setBackfilling(false);
    }
  }

  function openEdit() {
    setEditForm({
      property_name: property.property_name || "",
      input_address: property.input_address || "",
      canonical_address: property.canonical_address || "",
      city: property.city || "",
      state: property.state || "",
      zip: property.zip || "",
      active: property.active !== false,
    });
    setManagementMode("edit");
  }

  async function saveEdit(e) {
    e.preventDefault();
    if (!editForm?.input_address?.trim()) {
      toast.push({ kind: "err", text: "Input address is required" });
      return;
    }
    setSavingManagement(true);
    try {
      const updated = await API.updateProperty(propertyId, {
        property_name: editForm.property_name,
        input_address: editForm.input_address,
        canonical_address: editForm.canonical_address,
        city: editForm.city,
        state: editForm.state,
        zip: editForm.zip,
        active: editForm.active,
      });
      setProperty(updated);
      setManagementMode(null);
      setEditForm(null);
      onChanged?.();
      toast.push({ kind: "ok", text: "Property updated" });
    } catch (e) {
      toast.push({ kind: "err", text: e.message || "Update failed" });
    } finally {
      setSavingManagement(false);
    }
  }

  async function setArchived(nextArchived) {
    setSavingManagement(true);
    try {
      const updated = nextArchived
        ? await API.archiveProperty(propertyId)
        : await API.restoreProperty(propertyId);
      setProperty(updated);
      onChanged?.();
      toast.push({ kind: "ok", text: nextArchived ? "Property archived" : "Property restored" });
    } catch (e) {
      toast.push({ kind: "err", text: e.message || "Request failed" });
    } finally {
      setSavingManagement(false);
    }
  }

  async function togglePin() {
    setSavingManagement(true);
    try {
      const nextPinned = !property.pinned;
      const updated = await API.updateProperty(propertyId, { pinned: nextPinned });
      setProperty(updated);
      onChanged?.();
      toast.push({
        kind: "ok",
        text: nextPinned ? "Property pinned" : "Property unpinned"
      });
    } catch (e) {
      toast.push({ kind: "err", text: e.message || "Failed to update pin status" });
    } finally {
      setSavingManagement(false);
    }
  }

  async function doDelete() {
    setSavingManagement(true);
    try {
      await API.deleteProperty(propertyId);
      toast.push({ kind: "ok", text: "Property deleted" });
      await onChanged?.();
      navigate("dashboard");
    } catch (e) {
      toast.push({ kind: "err", text: e.message || "Delete failed" });
      setSavingManagement(false);
    }
  }

  function focusAIResearch() {
    aiPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      aiPanelRef.current?.querySelector("input")?.focus();
    }, 250);
  }

  if (loading) return <div className="empty">Loading property…</div>;
  if (!property) return <div className="empty"><div className="title">Property not found</div></div>;

  const current = property || {};
  const sp = splitAddress(displayAddress(property));
  const propertyName = (property.property_name || "").trim();
  const headerTitle = propertyName || sp.line1;
  const headerAddress = propertyName ? [sp.line1, sp.line2].filter(Boolean).join(", ") : sp.line2;
  const isArchived = property.active === false;

  const saleBasis = current.sold_price ?? current.last_sold_price;
  const estimateSinceSale =
    current.best_current_estimate != null && saleBasis != null
      ? current.best_current_estimate - saleBasis
      : null;
  const estimateSinceSalePct =
    saleBasis && current.best_current_estimate != null
      ? (current.best_current_estimate - saleBasis) / saleBasis
      : null;
  const saleMonthYear = _saleMonthYear(current, property.events || []);
  const hasCurrentListPrice =
    ["for_sale", "pending"].includes(current.listing_state) && current.list_price != null;
  const avmChartRangeLabel = (() => {
    const ts = [];
    if (current.estimate_date && current.best_current_estimate != null) {
      const t = parseEstimateDate(current.estimate_date);
      if (t != null) ts.push(t);
    }
    for (const h of property.historical || []) {
      const t = parseEstimateDate(h.date);
      if (t != null && h.estimate != null) ts.push(t);
    }
    if (!ts.length) return "—";
    return `${formatMonthYear(Math.min(...ts))} - ${formatMonthYear(Math.max(...ts))}`;
  })();

  return (
    <div>
      <button className="btn btn-ghost" onClick={() => navigate("dashboard")} style={{ marginBottom: 12 }}>
        <Icon name="chevronLeft" /> All properties
      </button>

      <div className="detail-header">
        <div>
          <h1>{headerTitle}</h1>
          <div className="meta">
            {headerAddress && <span>{headerAddress}</span>}
            {headerAddress && <span style={{ color: "var(--text-faint)" }}>·</span>}
            <ListingBadge state={property.listing_state} />
            {property.active === false && <span className="badge neutral">Archived</span>}
            {property.property_url && (
              <a href={property.property_url} target="_blank" rel="noopener noreferrer">
                Realtor.com page <Icon name="arrowUpRight" size={12} />
              </a>
            )}
          </div>
        </div>
        <div className="detail-actionbar">
          {!isArchived && (
            <button className="btn" onClick={focusAIResearch}>
              <Icon name="sparkles" /> Ask AI
            </button>
          )}
          {isArchived ? (
            <button className="btn btn-primary" onClick={() => setArchived(false)} disabled={savingManagement}>
              <Icon name="archive" /> Restore
            </button>
          ) : (
            <button className="btn btn-primary detail-refresh-action" onClick={doRefresh} disabled={refreshing || backfilling}>
              <Icon name="refresh" />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          )}
          <div className="detail-menu-wrap" ref={actionMenuRef}>
            <button
              className={`btn detail-more-btn ${actionMenuOpen ? "on" : ""}`}
              onClick={() => setActionMenuOpen(!actionMenuOpen)}
              aria-haspopup="menu"
              aria-expanded={actionMenuOpen}
            >
              <Icon name="menu" /> More
            </button>
            {actionMenuOpen && (
              <div className="detail-menu" role="menu">
                <button
                  className="detail-menu-item"
                  onClick={() => {
                    setActionMenuOpen(false);
                    togglePin();
                  }}
                  disabled={savingManagement}
                  role="menuitem"
                >
                  <Icon
                    name="pin"
                    fill={property.pinned ? "currentColor" : "none"}
                    stroke="currentColor"
                  />
                  {property.pinned ? "Unpin" : "Pin"}
                </button>
                <button
                  className="detail-menu-item"
                  onClick={() => {
                    setActionMenuOpen(false);
                    openEdit();
                  }}
                  disabled={savingManagement}
                  role="menuitem"
                >
                  <Icon name="edit" /> Edit
                </button>
                <button
                  className="detail-menu-item"
                  onClick={() => {
                    setActionMenuOpen(false);
                    setArchived(!isArchived);
                  }}
                  disabled={savingManagement}
                  role="menuitem"
                >
                  <Icon name="archive" /> {isArchived ? "Restore" : "Archive"}
                </button>
                <button
                  className="detail-menu-item"
                  onClick={() => {
                    setActionMenuOpen(false);
                    doBackfill();
                  }}
                  disabled={backfilling || refreshing}
                  title="Fetch full historical AVM series from realtor.com"
                  role="menuitem"
                >
                  <Icon name="refresh" />
                  {backfilling ? "Backfilling…" : "Backfill history"}
                </button>
                <button
                  className="detail-menu-item danger"
                  onClick={() => {
                    setActionMenuOpen(false);
                    setManagementMode("delete");
                  }}
                  disabled={savingManagement}
                  role="menuitem"
                >
                  <Icon name="trash" /> Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {managementMode === "edit" && editForm && (
        <div className="card management-card">
          <div className="card-header">
            <div className="card-title">Edit property</div>
            <button className="icon-btn" title="Close" onClick={() => setManagementMode(null)}><Icon name="x" /></button>
          </div>
          <form className="card-body management-form" onSubmit={saveEdit}>
            <label>
              <span>Name</span>
              <input
                value={editForm.property_name}
                placeholder="Optional"
                onChange={(e) => setEditForm({ ...editForm, property_name: e.target.value })}
              />
            </label>
            <label>
              <span>Input address</span>
              <input
                value={editForm.input_address}
                onChange={(e) => setEditForm({ ...editForm, input_address: e.target.value })}
              />
            </label>
            <label>
              <span>Canonical address</span>
              <input
                value={editForm.canonical_address}
                onChange={(e) => setEditForm({ ...editForm, canonical_address: e.target.value })}
              />
            </label>
            <div className="management-grid">
              <label>
                <span>City</span>
                <input
                  value={editForm.city}
                  onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                />
              </label>
              <label>
                <span>State</span>
                <input
                  maxLength="2"
                  value={editForm.state}
                  onChange={(e) => setEditForm({ ...editForm, state: e.target.value.toUpperCase() })}
                />
              </label>
              <label>
                <span>ZIP</span>
                <input
                  value={editForm.zip}
                  onChange={(e) => setEditForm({ ...editForm, zip: e.target.value })}
                />
              </label>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={editForm.active}
                onChange={(e) => setEditForm({ ...editForm, active: e.target.checked })}
              />
              <span>Include in dashboard and refresh-all</span>
            </label>
            <div className="management-actions">
              <button type="button" className="btn" onClick={() => setManagementMode(null)} disabled={savingManagement}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingManagement}>
                <Icon name="check" /> {savingManagement ? "Saving..." : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}

      {managementMode === "delete" && (
        <div className="card management-card danger-card">
          <div className="card-header">
            <div className="card-title">Delete property</div>
            <button className="icon-btn" title="Close" onClick={() => setManagementMode(null)}><Icon name="x" /></button>
          </div>
          <div className="card-body">
            <div className="danger-title">Delete {sp.line1}?</div>
            <div className="danger-copy">
              This removes the property plus its historical estimates and market events from the local database.
            </div>
            <div className="management-actions">
              <button className="btn" onClick={() => setManagementMode(null)} disabled={savingManagement}>Cancel</button>
              <button className="btn btn-danger" onClick={doDelete} disabled={savingManagement}>
                <Icon name="trash" /> {savingManagement ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="facts" style={{ marginBottom: 16 }}>
        <div className="fact">
          <div className="label">Latest estimate</div>
          <div className="value">{fmt.usd(current.best_current_estimate)}</div>
          <div className="sub">
            {current.estimate_low != null && current.estimate_high != null && (
              <><RangePill low={current.estimate_low} high={current.estimate_high} /> · </>
            )}
            {current.estimate_source || "—"}
          </div>
        </div>
        {hasCurrentListPrice && (
          <div className="fact">
            <div className="label">List price</div>
            <div className="value">{fmt.usd(current.list_price)}</div>
            <div className="sub">
              {current.best_current_estimate != null
                ? <span style={{ color: current.best_current_estimate >= current.list_price ? "var(--pos)" : "var(--neg)" }}>
                    Est. {fmt.delta(current.best_current_estimate - current.list_price)} vs list
                  </span>
                : "Currently listed"}
            </div>
          </div>
        )}
        <div className="fact">
          <div className="label">{current.sold_price ? "Sale price" : "Last sale"}</div>
          <div className="value">{current.sold_price ? fmt.usd(current.sold_price) : fmt.usd(current.last_sold_price)}</div>
          <div className="sub">
            {current.sold_price && current.best_current_estimate != null
              ? <span style={{ color: current.best_current_estimate >= current.sold_price ? "var(--pos)" : "var(--neg)" }}>
                  Est. {fmt.delta(current.best_current_estimate - current.sold_price)} vs sale
                </span>
              : saleBasis != null ? (saleMonthYear || "—") : "—"}
          </div>
        </div>
        <div className="fact">
          <div className="label">Est. change since sale</div>
          <div className="value metric-pair" style={{ color: estimateSinceSale != null ? (estimateSinceSale >= 0 ? "var(--pos)" : "var(--neg)") : undefined }}>
            <span>{estimateSinceSale != null ? fmt.delta(estimateSinceSale) : "—"}</span>
            {estimateSinceSalePct != null && (
              <span className={`metric-pct ${estimateSinceSale >= 0 ? "pos" : "neg"}`}>
                {fmt.pct(estimateSinceSalePct)}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <div className="card-title">Value over time</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {avmChartRangeLabel}
              </div>
            </div>
            <div className="card-body">
              <PriceChart current={property} historical={property.historical || []} events={property.events || []} height={280} />
            </div>
            <LifetimeStrip current={property} historical={property.historical || []} events={property.events || []} />
          </div>

          <div className="tabs">
            <div className={`tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>
              Timeline
            </div>
            <div className={`tab ${tab === "estimates" ? "active" : ""}`} onClick={() => setTab("estimates")}>
              Estimates
            </div>
            <div className={`tab ${tab === "taxes" ? "active" : ""}`} onClick={() => setTab("taxes")}>
              Taxes
            </div>
            <div className={`tab ${tab === "json" ? "active" : ""}`} onClick={() => setTab("json")}>
              Raw JSON · latest
            </div>
          </div>

          {tab === "history" && <MarketTimeline current={property} historical={property.historical || []} events={property.events || []} />}
          {tab === "estimates" && <EstimateHistoryPanel current={property} historical={property.historical || []} />}
          {tab === "taxes" && <TaxHistoryPanel rows={property.tax_history || []} />}
          {tab === "json" && (
            <div className="card">
              <div className="card-header">
                <div className="card-title">Audit · {property.last_fetched_at ? fmt.datetime(property.last_fetched_at) : "—"}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm" onClick={() => {
                    navigator.clipboard?.writeText(JSON.stringify(property.raw_json, null, 2));
                    toast.push({ kind: "ok", text: "Copied to clipboard" });
                  }}>
                    <Icon name="copy" /> Copy
                  </button>
                </div>
              </div>
              <div className="card-body flush" style={{ padding: 12 }}>
                {property.raw_json
                  ? <JsonViewer data={property.raw_json} maxHeight={520} />
                  : <div className="empty">No raw JSON for the current fetch.</div>}
              </div>
            </div>
          )}

        </div>

        <div className="detail-side">
          <PropertyPhotosCard photos={property.photos} />
          {!isArchived && (
            <AskAboutHome
              refEl={aiPanelRef}
              propertyId={propertyId}
              settings={aiSettings}
              navigate={navigate}
            />
          )}
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-header"><div className="card-title">Property facts</div></div>
            <div className="card-body flush">
              <div className="facts-stack property-facts">
                <div className="fact-row"><span className="k">Beds</span><span className="v">{current.beds ?? "—"}</span></div>
                <div className="fact-row"><span className="k">Baths</span><span className="v">{current.baths != null ? fmt.baths(current.baths) : "—"}</span></div>
                <div className="fact-row"><span className="k">Living area</span><span className="v">{current.sqft != null ? `${fmt.num(current.sqft)} sqft` : "—"}</span></div>
                <div className="fact-row"><span className="k">Lot</span><span className="v">{current.lot_sqft != null ? `${fmt.num(current.lot_sqft)} sqft` : "—"}</span></div>
                <div className="fact-row"><span className="k">Year built</span><span className="v">{current.year_built ?? "—"}</span></div>
                <div className="fact-row"><span className="k">Type</span><span className="v">{formatPropertyType(current.property_type, current.property_sub_type)}</span></div>
                {current.stories != null && (
                  <div className="fact-row"><span className="k">Stories</span><span className="v">{current.stories}</span></div>
                )}
                {current.garage != null && (
                  <div className="fact-row"><span className="k">Garage</span><span className="v">{current.garage} {current.garage === 1 ? "car" : "cars"}</span></div>
                )}
                {current.hoa_fee != null && current.hoa_fee > 0 && (
                  <div className="fact-row"><span className="k">HOA</span><span className="v">{fmt.usd(current.hoa_fee)}/mo</span></div>
                )}
                {current.flood_factor_score != null && (
                  <div className="fact-row">
                    <span className="k">Flood risk</span>
                    <span className="v">
                      {current.flood_factor_score}/10
                      {current.flood_factor_severity ? ` · ${current.flood_factor_severity}` : ""}
                    </span>
                  </div>
                )}
                <div className="fact-row">
                  <span className="k">Coordinates</span>
                  <span className="v mono" style={{ fontSize: 11 }}>
                    {current.latitude != null && current.longitude != null
                      ? `${current.latitude.toFixed(4)}, ${current.longitude.toFixed(4)}`
                      : "—"}
                  </span>
                </div>
                <div className="fact-row"><span className="k">Property ID</span><span className="v mono" style={{ fontSize: 11 }}>{property.property_id || "—"}</span></div>
                <div className="fact-row"><span className="k">Listing ID</span><span className="v mono" style={{ fontSize: 11 }}>{property.listing_id || "—"}</span></div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-header"><div className="card-title">Estimate breakdown</div></div>
            <div className="card-body">
              <AllEstimates estimates={current.all_estimates} fallback={current} />
            </div>
          </div>

          <SchoolsCard schools={property.schools || []} />
        </div>

        {!isArchived && <AreaListingsCard property={property} navigate={navigate} onChanged={onChanged} />}
      </div>
    </div>
  );
}

// ---------- Ask about this home ----------
// Sidebar AI card (design Option A). Compact, always-visible "Ask about this
// home" panel pinned to the top of the detail right rail. Answers come from the
// server-side assistant (`POST /api/properties/{id}/ai/ask`), grounded in this
// property's tracked data, and may call web-search / geocoding tools — surfaced
// as a "Looked up" row. Gated by Admin → AI: when AI (or its key) is off the
// card shows a locked state pointing at the setting instead of disappearing.
const ASK_SUGGESTIONS = [
  "Is this priced fairly?",
  "What's the neighborhood like?",
  "How are the schools nearby?",
  "How's this market trending?",
];

const TOOL_LABELS = {
  web_search: "Web search",
  reverse_geocode: "Geocoding",
  geocode_address: "Geocoding",
};

function AskAboutHome({ refEl, propertyId, settings, navigate }) {
  const [activeQ, setActiveQ] = useState_p(null);
  const [answer, setAnswer] = useState_p("");
  const [toolsUsed, setToolsUsed] = useState_p([]);
  const [loading, setLoading] = useState_p(false);
  const [errored, setErrored] = useState_p(false);
  const [draft, setDraft] = useState_p("");
  const reqId = React.useRef(0);

  const enabled = Boolean(settings?.enabled);
  const hasKey = Boolean(settings?.has_deepseek_api_key);
  const envVar = settings?.deepseek_api_key_env_var || "DEEPSEEK_API_KEY";
  const canAsk = enabled && hasKey;

  async function ask(text) {
    const q = String(text || "").trim();
    if (!q || loading) return;
    const id = ++reqId.current;
    setActiveQ(q);
    setDraft("");
    setAnswer("");
    setToolsUsed([]);
    setErrored(false);
    setLoading(true);
    try {
      const res = await API.askPropertyAI(propertyId, q);
      if (id !== reqId.current) return; // a newer question superseded this one
      setAnswer((res.answer || "").trim());
      setToolsUsed(Array.isArray(res.tools_used) ? res.tools_used : []);
    } catch (e) {
      if (id !== reqId.current) return;
      setErrored(true);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    ask(draft);
  }

  // Gated by Admin → AI. When AI (or the model key) is off, show a locked
  // card that points to the setting rather than hiding the feature.
  if (!canAsk) {
    return (
      <div ref={refEl} className="card ai-card ai-card-locked" style={{ marginBottom: 12 }}>
        <div className="ai-card-head">
          <span className="ai-spark muted"><Icon name="sparkles" size={14} /></span>
          <div>
            <div className="ai-card-title">Ask about this home</div>
            <div className="ai-card-sub">
              {enabled ? `Add ${envVar} in .env to ask questions` : "AI is turned off for this workspace"}
            </div>
          </div>
        </div>
        <button className="btn btn-sm" onClick={() => navigate("admin")}>
          <Icon name="settings" size={13} /> Enable in Admin
        </button>
      </div>
    );
  }

  return (
    <div ref={refEl} className="card ai-card" style={{ marginBottom: 12 }}>
      <div className="ai-card-head">
        <span className="ai-spark"><Icon name="sparkles" size={14} /></span>
        <div>
          <div className="ai-card-title">Ask about this home</div>
          <div className="ai-card-sub">Grounded in this property's tracked data</div>
        </div>
      </div>

      <div className="ai-suggests">
        {ASK_SUGGESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            className={`ai-chip ${activeQ === q ? "on" : ""}`}
            onClick={() => ask(q)}
            disabled={loading}
          >{q}</button>
        ))}
      </div>

      {activeQ && (
        <div className="ai-answer">
          <div className="ai-answer-q">{activeQ}</div>
          {loading ? (
            <div className="ai-thinking"><span></span><span></span><span></span> Thinking…</div>
          ) : errored ? (
            <p className="ai-answer-err">
              Couldn't reach the assistant just now. Check that AI is enabled in Admin, then try again.
            </p>
          ) : (
            <>
              <Markdown text={answer} className="ai-md" />
              {toolsUsed.length > 0 && (
                <div className="ai-tools-used">
                  <span className="admin-label">Looked up</span>
                  {[...new Set(toolsUsed.map((t) => TOOL_LABELS[t] || t))].map((label) => (
                    <span key={label} className="badge neutral"><span className="dot" />{label}</span>
                  ))}
                </div>
              )}
              <div className="ai-disclaimer">AI can make mistakes — verify the details that matter.</div>
            </>
          )}
        </div>
      )}

      <form className="ai-composer" onSubmit={onSubmit}>
        <Icon name="sparkles" size={14} />
        <input
          placeholder="Ask anything…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={loading}
        />
        <button className="ai-send" type="submit" aria-label="Send" disabled={loading || !draft.trim()}>
          <Icon name="arrowUpRight" size={14} />
        </button>
      </form>
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

const TAX_VALUE_SOURCES = [
  { key: "assessment", label: "Assessed" },
  { key: "market", label: "Market" },
  { key: "value", label: "Value" },
  { key: "appraisal", label: "Appraised" },
];

function taxValueSource(row, source) {
  return {
    ...source,
    total: row[`${source.key}_total`] ?? null,
    building: row[`${source.key}_building`] ?? null,
    land: row[`${source.key}_land`] ?? null,
  };
}

function hasTaxSplit(source) {
  return source.building != null || source.land != null;
}

function preferredAssessmentSource(row) {
  return TAX_VALUE_SOURCES
    .map((source) => taxValueSource(row, source))
    .find((source) => source.total != null) || null;
}

function preferredAssessment(row) {
  return preferredAssessmentSource(row)?.total ?? null;
}

function preferredTaxSplit(row) {
  const sources = TAX_VALUE_SOURCES.map((source) => taxValueSource(row, source));
  return (
    sources.find((source) => source.total != null && hasTaxSplit(source)) ||
    sources.find((source) => hasTaxSplit(source)) ||
    sources.find((source) => source.total != null) ||
    null
  );
}

function TaxHistoryPanel({ rows = [] }) {
  const sorted = [...rows]
    .filter((r) => r.year != null)
    .sort((a, b) => a.year - b.year);
  const enriched = sorted.map((r, i) => {
    const prev = sorted[i - 1];
    const assessed = preferredAssessment(r);
    const prevTax = prev?.tax ?? null;
    const prevAssessed = prev ? preferredAssessment(prev) : null;
    return {
      ...r,
      assessed,
      taxDelta: r.tax != null && prevTax != null ? r.tax - prevTax : null,
      taxDeltaPct: r.tax != null && prevTax ? (r.tax - prevTax) / prevTax : null,
      assessedDelta: assessed != null && prevAssessed != null ? assessed - prevAssessed : null,
      assessedDeltaPct: assessed != null && prevAssessed ? (assessed - prevAssessed) / prevAssessed : null,
    };
  }).sort((a, b) => b.year - a.year);

  if (!enriched.length) return <div className="empty">No tax history yet.</div>;

  return (
    <div className="table-wrap">
      <table className="data timeline tax-table">
        <thead>
          <tr>
            <th style={{ width: 96 }}>Year</th>
            <th style={{ textAlign: "right", width: 150 }}>Tax</th>
            <th style={{ textAlign: "right", width: 180 }}>Assessed</th>
            <th>Value split</th>
            <th style={{ textAlign: "right", width: 210 }}>Change</th>
          </tr>
        </thead>
        <tbody>
          {enriched.map((r) => <TaxHistoryRow key={r.year} row={r} />)}
        </tbody>
      </table>
    </div>
  );
}

function TaxHistoryRow({ row }) {
  const split = preferredTaxSplit(row);
  const splitHasValues = split && hasTaxSplit(split);
  return (
    <tr style={{ cursor: "default" }}>
      <td className="date-cell">
        <div>{row.year}</div>
        <div className="rel">{row.assessed_year && row.assessed_year !== row.year ? `Assessed ${row.assessed_year}` : "Tax year"}</div>
      </td>
      <td className="change-cell">
        <div className="delta-num">{fmt.usd(row.tax)}</div>
        {row.tax_code_area && <div className="delta-sub">{row.tax_code_area}</div>}
      </td>
      <td className="change-cell">
        <div className="delta-num">{fmt.usd(row.assessed)}</div>
        <div className="delta-sub">county value</div>
      </td>
      <td className="value-cell">
        <div className="main">
          {split ? `${split.label} ${fmt.usd(split.total)}` : "—"}
        </div>
        {splitHasValues ? (
          <div className="sub">
            <span>Building {fmt.usd(split.building, { compact: true })}</span>
            <span style={{ color: "var(--text-faint)" }}>·</span>
            <span>Land {fmt.usd(split.land, { compact: true })}</span>
          </div>
        ) : (
          <div className="sub">No building/land split</div>
        )}
      </td>
      <td className="change-cell">
        <TaxDelta value={row.taxDelta} pct={row.taxDeltaPct} label="tax vs prior year" />
        {row.assessedDelta != null && (
          <div className="delta-sub">
            Assessed {fmt.delta(row.assessedDelta)} ({fmt.pct(row.assessedDeltaPct)})
          </div>
        )}
      </td>
    </tr>
  );
}

function TaxDelta({ value, pct, label }) {
  if (value == null) return <span className="delta-sub">first tax row</span>;
  return (
    <div>
      <div className={`delta-num ${value > 0 ? "pos" : (value < 0 ? "neg" : "")}`}>
        {fmt.delta(value)} <span>({fmt.pct(pct)})</span>
      </div>
      <div className="delta-sub">{label}</div>
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

function formatMonthYear(ts) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", year: "numeric" });
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

const TIMELINE_PAGE_SIZE = 10;
const TIMELINE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function buildEstimateEvents(current = null, historical = []) {
  const estimateRowsByKey = new Map();
  const addEstimateRow = (row) => {
    if (!row.date || row.estimate == null || !row.source) return;
    const key = `${row.date}|${row.source}|${row.estimate}`;
    const existing = estimateRowsByKey.get(key);
    if (!existing || (existing.low == null && row.low != null) || row.origin === "current") {
      estimateRowsByKey.set(key, row);
    }
  };

  if (current) {
    const baseDate = current.estimate_date || (current.last_fetched_at ? new Date(current.last_fetched_at).toISOString().slice(0, 10) : null);
    if (Array.isArray(current.all_estimates) && current.all_estimates.length) {
      for (const e of current.all_estimates) {
        addEstimateRow({
          id: `${current.id || current.last_fetched_at}-${e.source}-${e.date || baseDate}`,
          kind: "estimate",
          origin: "current",
          date: e.date || baseDate,
          ts: parseEstimateDate(e.date || baseDate) ?? current.last_fetched_at,
          source: e.source,
          estimate: e.estimate,
          low: e.low,
          high: e.high,
        });
      }
    } else {
      addEstimateRow({
        id: `${current.id || current.last_fetched_at}-estimate`,
        kind: "estimate",
        origin: "current",
        date: baseDate,
        ts: parseEstimateDate(baseDate) ?? current.last_fetched_at,
        source: current.estimate_source,
        estimate: current.best_current_estimate,
        low: current.estimate_low,
        high: current.estimate_high,
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
  return estimates.sort((a, b) => {
    if (b.ts !== a.ts) return b.ts - a.ts;
    return String(a.source || "").localeCompare(String(b.source || ""));
  });
}

function estimateSourceKey(source) {
  const s = String(source || "").toLowerCase();
  if (s.includes("quantarium")) return "Quantarium";
  if (s.includes("cotality")) return "Cotality";
  return source || "Other";
}

function buildMonthlyEstimateRows(current = null, historical = []) {
  const estimates = buildEstimateEvents(current, historical);
  const rowsByMonth = new Map();

  for (const row of estimates) {
    if (!row.date || row.ts == null) continue;
    const month = row.date.slice(0, 7);
    const sourceKey = estimateSourceKey(row.source);
    const grouped = rowsByMonth.get(month) || {
      id: `estimate-month-${month}`,
      kind: "estimate-month",
      month,
      ts: parseEstimateDate(`${month}-01`),
      sources: {},
    };
    const sourceRows = grouped.sources[sourceKey]?.rows || [];
    sourceRows.push(row);
    sourceRows.sort((a, b) => b.ts - a.ts);
    grouped.sources[sourceKey] = {
      ...sourceRows[0],
      rows: sourceRows,
    };
    rowsByMonth.set(month, grouped);
  }

  const rows = Array.from(rowsByMonth.values()).sort((a, b) => a.ts - b.ts);
  const prevBySource = new Map();
  for (const monthRow of rows) {
    for (const source of ESTIMATE_SOURCES) {
      const currentEstimate = monthRow.sources[source];
      if (!currentEstimate) continue;
      const prev = prevBySource.get(source);
      currentEstimate.vsPrior = prev ? currentEstimate.estimate - prev.estimate : null;
      currentEstimate.vsPriorPct = prev && prev.estimate ? currentEstimate.vsPrior / prev.estimate : null;
      prevBySource.set(source, currentEstimate);
    }
  }

  return rows.sort((a, b) => b.ts - a.ts);
}

function buildMarketEvents(current = null, historical = [], marketEvents = []) {
  const estimates = buildEstimateEvents(current, historical);
  const sortedEstimates = [...estimates].sort((a, b) => a.ts - b.ts);
  const sortedMarket = (marketEvents || [])
    .filter((e) => e.date && e.event_name && e.price != null)
    .map((e, i) => ({
      id: `market-${e.date}-${e.event_name}-${e.price}-${i}`,
      kind: "market",
      subkind: marketEventKind(e.event_name),
      ts: e.observed_at || parseEstimateDate(e.date),
      date: e.date,
      name: e.event_name,
      price: e.price,
      eventSource: e.source || "realtor",
      oldPrice: e.old_price,
      newPrice: e.new_price,
      observedDelta: e.delta,
      observedPct: e.pct,
    }))
    .filter((e) => e.ts != null)
    .sort((a, b) => a.ts - b.ts);

  let prevMarketPrice = null;
  for (const row of sortedMarket) {
    const estimateAtTime = [...sortedEstimates].reverse().find((e) => e.ts <= row.ts && e.estimate != null);
    row.estimateAtTime = estimateAtTime?.estimate ?? null;
    if (row.subkind === "price" && row.eventSource === "observed" && row.oldPrice != null && row.newPrice != null) {
      row.vsPrior = row.observedDelta ?? (row.newPrice - row.oldPrice);
      row.vsPriorPct = row.observedPct ?? (row.oldPrice ? row.vsPrior / row.oldPrice : null);
      row.changeLabel = "vs previous list price";
    } else if (row.subkind === "price" && prevMarketPrice != null) {
      row.vsPrior = row.price - prevMarketPrice;
      row.vsPriorPct = prevMarketPrice ? row.vsPrior / prevMarketPrice : null;
    } else if ((row.subkind === "listed" || row.subkind === "sold") && row.estimateAtTime != null) {
      row.vsPrior = row.price - row.estimateAtTime;
      row.vsPriorPct = row.estimateAtTime ? row.vsPrior / row.estimateAtTime : null;
    }
    if (row.price != null) prevMarketPrice = row.price;
  }

  return sortedMarket.sort((a, b) => {
    if (b.ts !== a.ts) return b.ts - a.ts;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function MarketTimeline({ current, historical = [], events = [] }) {
  const [page, setPage] = useState_p(1);
  const [pageSize, setPageSize] = useState_p(TIMELINE_PAGE_SIZE);
  const rows = useMemo_p(() => buildMarketEvents(current, historical, events), [current, historical, events]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(pageStart, pageStart + pageSize);
  const rangeFrom = rows.length === 0 ? 0 : pageStart + 1;
  const rangeTo = Math.min(pageStart + pageSize, rows.length);

  useEffect_p(() => {
    setPage(1);
  }, [rows]);

  function choosePageSize(size) {
    const firstVisibleIndex = pageStart;
    setPageSize(size);
    setPage(Math.floor(firstVisibleIndex / size) + 1);
  }

  if (!rows.length) return <div className="empty">No market events yet.</div>;
  return (
    <div>
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
          </tbody>
        </table>
        {rows.length > 0 && (
          <TimelinePager
            page={currentPage}
            pageCount={pageCount}
            pageSize={pageSize}
            rangeFrom={rangeFrom}
            rangeTo={rangeTo}
            total={rows.length}
            onPage={setPage}
            onPageSize={choosePageSize}
          />
        )}
      </div>
    </div>
  );
}

function EstimateHistoryPanel({ current, historical = [] }) {
  const [page, setPage] = useState_p(1);
  const [pageSize, setPageSize] = useState_p(TIMELINE_PAGE_SIZE);
  const rows = useMemo_p(() => buildMonthlyEstimateRows(current, historical), [current, historical]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageRows = rows.slice(pageStart, pageStart + pageSize);
  const rangeFrom = rows.length === 0 ? 0 : pageStart + 1;
  const rangeTo = Math.min(pageStart + pageSize, rows.length);

  useEffect_p(() => {
    setPage(1);
  }, [rows]);

  function choosePageSize(size) {
    const firstVisibleIndex = pageStart;
    setPageSize(size);
    setPage(Math.floor(firstVisibleIndex / size) + 1);
  }

  if (!rows.length) return <div className="empty">No estimate history yet.</div>;
  return (
    <div>
      <div className="table-wrap">
        <table className="data timeline">
          <thead>
            <tr>
              <th style={{ width: 132 }}>Month</th>
              <th>Quantarium</th>
              <th>Cotality</th>
              <th style={{ textAlign: "right", width: 180 }}>Spread</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r) => <MonthlyEstimateRow key={r.id} row={r} />)}
          </tbody>
        </table>
        <TimelinePager
          page={currentPage}
          pageCount={pageCount}
          pageSize={pageSize}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          total={rows.length}
          onPage={setPage}
          onPageSize={choosePageSize}
        />
      </div>
    </div>
  );
}

function TimelinePager({ page, pageCount, pageSize, rangeFrom, rangeTo, total, onPage, onPageSize }) {
  const pages = timelinePageWindow(page, pageCount);
  return (
    <div className="pager">
      <div className="pager-info">
        Showing <strong>{rangeFrom.toLocaleString()}–{rangeTo.toLocaleString()}</strong> of{" "}
        <strong>{total.toLocaleString()}</strong>
      </div>
      <div className="pager-controls">
        <label className="pager-size">
          <span>Rows</span>
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {TIMELINE_PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div className="pager-nav">
          <button
            className="pager-btn"
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >‹</button>
          {pages.map((p, i) => p === "…" ? (
            <span key={`gap-${i}`} className="pager-gap">…</span>
          ) : (
            <button
              key={p}
              className={`pager-btn ${p === page ? "active" : ""}`}
              onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
            >{p}</button>
          ))}
          <button
            className="pager-btn"
            onClick={() => onPage(page + 1)}
            disabled={page >= pageCount}
            aria-label="Next page"
          >›</button>
        </div>
      </div>
    </div>
  );
}

function timelinePageWindow(page, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  const left = Math.max(2, page - 1);
  const right = Math.min(total - 1, page + 1);
  if (left > 2) out.push("…");
  for (let i = left; i <= right; i++) out.push(i);
  if (right < total - 1) out.push("…");
  out.push(total);
  return out;
}

function ActivityRow({ row }) {
  return (
    <tr className={row.origin === "historical" ? "historical-bg" : ""} style={{ cursor: "default" }}>
      <td className="date-cell">
        <div>{fmt.date(row.ts)}</div>
        <div className="rel">{row.origin === "historical" ? "Historical AVM" : row.origin === "current" ? "Current data" : fmt.relative(row.ts)}</div>
      </td>
      <td><TimelineBadge row={row} /></td>
      <td className="value-cell"><TimelineValue row={row} /></td>
      <td className="change-cell"><TimelineChange row={row} /></td>
    </tr>
  );
}

function MonthlyEstimateRow({ row }) {
  const quantarium = row.sources.Quantarium || null;
  const cotality = row.sources.Cotality || null;
  const spread = quantarium && cotality ? quantarium.estimate - cotality.estimate : null;
  const spreadPct = spread != null && cotality.estimate ? spread / cotality.estimate : null;
  return (
    <tr className={quantarium?.origin === "current" || cotality?.origin === "current" ? "" : "historical-bg"} style={{ cursor: "default" }}>
      <td className="date-cell">
        <div>{formatMonthYear(row.ts)}</div>
        <div className="rel">Monthly AVM</div>
      </td>
      <td className="value-cell"><EstimateSourceCell row={quantarium} /></td>
      <td className="value-cell"><EstimateSourceCell row={cotality} /></td>
      <td className="change-cell">
        {spread == null ? (
          <span className="delta-sub">needs both sources</span>
        ) : (
          <div>
            <div className={`delta-num ${spread > 0 ? "pos" : (spread < 0 ? "neg" : "")}`}>
              {fmt.delta(spread)} <span>({fmt.pct(spreadPct)})</span>
            </div>
            <div className="delta-sub">Quantarium vs Cotality</div>
          </div>
        )}
      </td>
    </tr>
  );
}

function EstimateSourceCell({ row }) {
  if (!row) return <span className="faint">—</span>;
  return (
    <div>
      <div className="main">{fmt.usd(row.estimate)}</div>
      <div className="sub">
        <span>{fmt.shortDate(row.ts)}</span>
        {row.rows.length > 1 && (
          <>
            <span style={{ color: "var(--text-faint)" }}>·</span>
            <span>latest of {row.rows.length}</span>
          </>
        )}
        {row.vsPrior != null && (
          <>
            <span style={{ color: "var(--text-faint)" }}>·</span>
            <span className={row.vsPrior > 0 ? "pos" : (row.vsPrior < 0 ? "neg" : "")}>
              {fmt.delta(row.vsPrior)}
            </span>
          </>
        )}
      </div>
    </div>
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
        <div className="sub">{row.eventSource === "observed" ? "Observed during refresh" : "Realtor market event"}</div>
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
    const label = row.changeLabel || (row.subkind === "price" ? "vs prior market price" : "vs nearest estimate");
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

function LifetimeStrip({ current = null, historical = [], events = [] }) {
  const estimateTimes = [];
  if (current) {
    if (current.last_fetched_at && current.best_current_estimate != null) estimateTimes.push(current.last_fetched_at);
    const t = parseEstimateDate(current.estimate_date);
    if (t != null && current.best_current_estimate != null) estimateTimes.push(t);
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
  const latestEstimate = current?.best_current_estimate
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
          <div className="estimate-window" style={{ left: `${pct(estimateStart)}%`, width: `${Math.max(1, pct(estimateEnd) - pct(estimateStart))}%` }} />
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

// ---------- Admin ----------
const ADMIN_JOB_STORAGE_KEY = "ht_admin_jobs";
const CADENCE_STORAGE_KEY = "ht_refresh_cadence";
const CADENCE_OPTIONS = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "biweekly", label: "Twice / month" },
  { key: "monthly", label: "Monthly" },
  { key: "manual", label: "Manual only" },
];
const CADENCE_LABEL = Object.fromEntries(CADENCE_OPTIONS.map((o) => [o.key, o.label]));

// Admin section rail. Grows as more settings areas are added — one entry here
// plus its render branch below.
const ADMIN_SECTIONS = [
  { key: "refresh", label: "Refresh jobs", icon: "activity" },
  { key: "ai", label: "AI", icon: "sparkles" },
];

function loadAdminJobs() {
  try {
    const raw = localStorage.getItem(ADMIN_JOB_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch (e) {
    return [];
  }
}

function saveAdminJobs(jobs) {
  localStorage.setItem(ADMIN_JOB_STORAGE_KEY, JSON.stringify(jobs.slice(0, 8)));
}

function nextCadenceTarget(cadence, now = new Date()) {
  if (cadence === "manual") return "Manual trigger only";
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (cadence === "daily") {
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (cadence === "weekly") {
    const daysUntilMonday = (8 - next.getDay()) % 7 || 7;
    next.setDate(next.getDate() + daysUntilMonday);
  } else if (cadence === "monthly") {
    next.setMonth(next.getMonth() + 1, 1);
  } else {
    const day = now.getDate() < 15 ? 15 : 1;
    if (day === 15) next.setDate(15);
    else next.setMonth(next.getMonth() + 1, 1);
  }
  return fmt.datetime(next.getTime());
}

function AdminPage({ properties, loading, navigate, onRefreshAll, refreshingAll }) {
  const [adminSection, setAdminSection] = useState_p("refresh");
  const [jobs, setJobs] = useState_p(loadAdminJobs);
  const [cadence, setCadence] = useState_p(() => localStorage.getItem(CADENCE_STORAGE_KEY) || "biweekly");
  const [progress, setProgress] = useState_p(0);
  const [aiSettings, setAISettings] = useState_p({
    enabled: false,
    provider: "deepseek",
    has_deepseek_api_key: false,
    deepseek_api_key_source: null,
    deepseek_api_key_env_var: "DEEPSEEK_API_KEY",
  });
  const [aiEnabled, setAIEnabled] = useState_p(false);
  const [aiLoading, setAILoading] = useState_p(true);
  const [aiSaving, setAISaving] = useState_p(false);
  const toast = useToast();

  useEffect_p(() => {
    localStorage.setItem(CADENCE_STORAGE_KEY, cadence);
  }, [cadence]);

  useEffect_p(() => {
    function onStorage(e) {
      if (e.key === ADMIN_JOB_STORAGE_KEY) setJobs(loadAdminJobs());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect_p(() => {
    let cancelled = false;
    setAILoading(true);
    API.getAISettings()
      .then((settings) => {
        if (cancelled) return;
        setAISettings(settings);
        setAIEnabled(Boolean(settings.enabled));
      })
      .catch((e) => {
        if (!cancelled) toast.push({ kind: "err", text: e.message || "Could not load AI settings" });
      })
      .finally(() => {
        if (!cancelled) setAILoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const activeProperties = useMemo_p(
    () => properties.filter((p) => p.active !== false),
    [properties]
  );
  const issues = useMemo_p(
    () => activeProperties.filter((p) => p.status && p.status !== "matched"),
    [activeProperties]
  );
  const lastSweep = activeProperties.length
    ? Math.max(...activeProperties.map((p) => p.last_fetched_at || p.updated_at || 0))
    : null;
  const latestJob = jobs[0] || null;

  async function startRefreshAll() {
    const startedAt = Date.now();
    setProgress(activeProperties.length ? 8 : 100);
    let timer = null;
    if (activeProperties.length) {
      timer = setInterval(() => {
        setProgress((p) => Math.min(92, p + Math.max(2, Math.round(84 / activeProperties.length))));
      }, 450);
    }

    try {
      const res = await onRefreshAll();
      if (timer) clearInterval(timer);
      setProgress(100);
      const finishedAt = Date.now();
      const results = Array.isArray(res?.results) ? res.results : [];
      const job = {
        id: `job-${finishedAt}`,
        kind: "manual",
        status: "completed",
        started_at: startedAt,
        finished_at: finishedAt,
        total: results.length || activeProperties.length,
        ok: results.filter((r) => r.status === "matched").length,
        issues: results.filter((r) => r.status && r.status !== "matched").length,
        error: null,
      };
      const next = [job, ...jobs].slice(0, 8);
      setJobs(next);
      saveAdminJobs(next);
      toast.push({ kind: "ok", text: `Refreshed ${job.total} properties` });
      setTimeout(() => setProgress(0), 700);
    } catch (e) {
      if (timer) clearInterval(timer);
      setProgress(0);
      const finishedAt = Date.now();
      const job = {
        id: `job-${finishedAt}`,
        kind: "manual",
        status: "error",
        started_at: startedAt,
        finished_at: finishedAt,
        total: activeProperties.length,
        ok: 0,
        issues: activeProperties.length,
        error: e.message || "Refresh failed",
      };
      const next = [job, ...jobs].slice(0, 8);
      setJobs(next);
      saveAdminJobs(next);
      toast.push({ kind: "err", text: job.error });
    }
  }

  async function handleToggleAI(next) {
    setAIEnabled(next);
    setAISaving(true);
    try {
      const settings = await API.updateAISettings({ enabled: next });
      setAISettings(settings);
      setAIEnabled(Boolean(settings.enabled));
    } catch (e) {
      setAIEnabled(!next);
      toast.push({ kind: "err", text: e.message || "Could not save AI settings" });
    } finally {
      setAISaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Admin</h1>
          <div className="page-subtitle">
            Workspace settings — refresh schedule, integrations, and more
          </div>
        </div>
      </div>

      <div className="admin-layout">
        <nav className="admin-rail">
          <div className="admin-rail-label">Settings</div>
          {ADMIN_SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`admin-rail-item ${adminSection === s.key ? "active" : ""}`}
              onClick={() => setAdminSection(s.key)}
            >
              <Icon name={s.icon} size={15} />
              {s.label}
              {s.key === "refresh" && issues.length > 0 && (
                <span className="count warn">{issues.length}</span>
              )}
            </button>
          ))}
        </nav>

        <div>
          {adminSection === "refresh" ? (
            <>
          <div className="admin-section-head">
            <div>
              <h2>Refresh jobs</h2>
              <div className="sub">Scheduled fetches across all active properties</div>
            </div>
            <button
              className="btn btn-primary"
              onClick={startRefreshAll}
              disabled={refreshingAll || loading || activeProperties.length === 0}
            >
              <Icon name="refresh" />
              {refreshingAll ? "Running…" : "Refresh active now"}
            </button>
          </div>

          <div className="facts" style={{ marginBottom: 16 }}>
            <div className="fact">
              <div className="label">Last sweep</div>
              <div className="value sm">{lastSweep ? fmt.relative(lastSweep) : "—"}</div>
              <div className="sub">{lastSweep ? fmt.datetime(lastSweep) : "No refreshes yet"}</div>
            </div>
            <div className="fact">
              <div className="label">Active properties</div>
              <div className="value">{activeProperties.length}</div>
              <div className="sub">{properties.length} tracked total</div>
            </div>
            <div className="fact">
              <div className="label">Issues</div>
              <div className="value" style={{ color: issues.length ? "var(--warn)" : "var(--text)" }}>{issues.length}</div>
              <div className="sub">
                {issues.filter((p) => p.status === "error").length} errors · {issues.filter((p) => p.status === "no_candidates").length} no match
              </div>
            </div>
            <div className="fact">
              <div className="label">Cadence</div>
              <div className="value sm">{CADENCE_LABEL[cadence] || CADENCE_LABEL.biweekly}</div>
              <div className="sub">{nextCadenceTarget(cadence)}</div>
            </div>
          </div>

          {refreshingAll && (
            <div className="card admin-progress">
              <div className="card-body">
                <div className="progress">
                  <div className="fill" style={{ width: `${progress}%` }} />
                </div>
                <div className="tnum">
                  {Math.max(1, Math.round((progress / 100) * Math.max(activeProperties.length, 1)))} / {activeProperties.length || 1}
                </div>
              </div>
            </div>
          )}

          <div className="admin-grid">
            <div>
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-header">
                  <div className="card-title">Properties with issues · {issues.length}</div>
                </div>
                <div className="card-body flush">
                  {issues.length === 0 ? (
                    <div className="empty">
                      <div className="title">All clear</div>
                      <div>Every tracked property matched on its latest refresh.</div>
                    </div>
                  ) : (
                    <div className="table-wrap admin-table-wrap">
                      <table className="data">
                        <thead>
                          <tr><th>Address</th><th>Note</th><th>Last refresh</th><th></th></tr>
                        </thead>
                        <tbody>
                          {issues.map((p) => {
                            const sp = splitAddress(displayAddress(p));
                            const note = p.error || "No candidates returned";
                            return (
                              <tr key={p.id} onClick={() => navigate("detail", p.id)}>
                                <td className="address-cell">{sp.line1} <span className="sub">· {sp.line2}</span></td>
                                <td className="muted" style={{ fontSize: 11 }}>{note}</td>
                                <td className="muted">{fmt.relative(p.last_fetched_at || p.updated_at)}</td>
                                <td style={{ textAlign: "right" }}><Icon name="chevronRight" /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              <div className="card">
                <div className="card-header"><div className="card-title">Recent jobs</div></div>
                <div className="card-body flush">
                  {jobs.length === 0 ? (
                    <div className="empty">
                      <div className="title">No admin runs yet</div>
                      <div>Manual refresh runs started here will appear in this log.</div>
                    </div>
                  ) : (
                    <div className="table-wrap admin-table-wrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>Started</th>
                            <th>Kind</th>
                            <th>Status</th>
                            <th style={{ textAlign: "right" }}>Properties</th>
                            <th style={{ textAlign: "right" }}>Duration</th>
                            <th style={{ textAlign: "right" }}>Issues</th>
                          </tr>
                        </thead>
                        <tbody>
                          {jobs.map((j) => (
                            <tr key={j.id} style={{ cursor: "default" }}>
                              <td>
                                <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
                                  <span>{fmt.datetime(j.started_at)}</span>
                                  <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{fmt.relative(j.started_at)}</span>
                                </div>
                              </td>
                              <td><span className="badge info">Manual</span></td>
                              <td>
                                <span className={`badge ${j.status === "completed" ? "ok" : "err"}`}>
                                  <span className="dot" />
                                  {j.status === "completed" ? "Completed" : "Error"}
                                </span>
                              </td>
                              <td className="num">{j.ok}/{j.total}</td>
                              <td className="num muted">{Math.max(1, Math.round((j.finished_at - j.started_at) / 1000))}s</td>
                              <td className="num">
                                {j.issues > 0
                                  ? <span style={{ color: "var(--warn)", fontWeight: 500 }}>{j.issues}</span>
                                  : <span className="faint">0</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <CadencePanel cadence={cadence} setCadence={setCadence} latestJob={latestJob} />
          </div>
            </>
          ) : (
            <AiSection
              settings={aiSettings}
              enabled={aiEnabled}
              loading={aiLoading}
              saving={aiSaving}
              onToggle={handleToggleAI}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Toggle switch ----------
function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? "on" : ""}`}
      onClick={() => !disabled && onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

// ---------- env-key detection chip ----------
// Reflects whether a key was found in the server environment / .env at boot.
// Detection is read-only here; the actual key never reaches the client.
function EnvKey({ name, detected, source }) {
  return (
    <div>
      <div className="envkey">
        <code>{name}</code>
        {detected ? (
          <span className="badge ok"><Icon name="check" size={11} /> Detected in {source || ".env"}</span>
        ) : (
          <span className="badge warn"><Icon name="alert" size={11} /> Not found</span>
        )}
      </div>
      {!detected && (
        <div className="envkey-hint">
          Add <code>{name}=…</code> to your <code>.env</code> file and restart to enable.
        </div>
      )}
    </div>
  );
}

// ---------- Admin · AI section ----------
// An "Enable AI" master toggle gates two capabilities, each tied to a key the
// server detects at boot: a model provider (DeepSeek) and web research (Brave).
// The master toggle persists via the API; capability toggles are local and
// disabled when their key is missing or AI is off — they mirror availability.
function AiSection({ settings, enabled, loading, saving, onToggle }) {
  const hasDeepseek = Boolean(settings?.has_deepseek_api_key);
  const hasBrave = Boolean(settings?.has_brave_api_key);
  const deepseekSource = settings?.deepseek_api_key_source === "dotenv" ? ".env" : "environment";
  const braveSource = settings?.brave_api_key_source === "dotenv" ? ".env" : "environment";
  const deepseekVar = settings?.deepseek_api_key_env_var || "DEEPSEEK_API_KEY";
  const braveVar = settings?.brave_api_key_env_var || "BRAVE_API_KEY";

  const [deepseekOn, setDeepseekOn] = useState_p(true);
  const [braveOn, setBraveOn] = useState_p(true);

  return (
    <div>
      <div className="admin-section-head">
        <div>
          <h2>AI</h2>
          <div className="sub">Summaries, Q&amp;A, and research powered by external providers</div>
        </div>
      </div>

      {/* Master toggle */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="master-row">
          <div className="setting-ico" style={{ color: enabled ? "var(--accent)" : undefined }}>
            <Icon name="sparkles" size={18} />
          </div>
          <div className="setting-main">
            <div className="setting-name">Enable AI</div>
            <div className="setting-desc">
              Let HomeIndexr summarize activity, draft notes, and answer
              questions about your tracked properties.
            </div>
          </div>
          <div className="setting-control">
            <Switch checked={enabled} onChange={onToggle} disabled={loading || saving} label="Enable AI" />
          </div>
        </div>
      </div>

      {/* Capabilities — gated by the master toggle */}
      <div className={`gated ${enabled ? "" : "off"}`}>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header"><div className="card-title">Model provider</div></div>
          <div className="card-body flush">
            <div className="setting-row">
              <div className="setting-ico"><Icon name="cpu" size={18} /></div>
              <div className="setting-main">
                <div className="setting-name">DeepSeek</div>
                <div className="setting-desc">
                  Chat &amp; reasoning model used for property summaries and Q&amp;A.
                </div>
                <EnvKey name={deepseekVar} detected={hasDeepseek} source={deepseekSource} />
              </div>
              <div className="setting-control">
                <Switch
                  checked={deepseekOn && hasDeepseek}
                  onChange={setDeepseekOn}
                  disabled={!hasDeepseek || !enabled}
                  label="Enable DeepSeek"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">Web research</div></div>
          <div className="card-body flush">
            <div className="setting-row">
              <div className="setting-ico"><Icon name="globe" size={18} /></div>
              <div className="setting-main">
                <div className="setting-name">Brave Search API</div>
                <div className="setting-desc">
                  Pulls comparable sales, neighborhood context, and recent news
                  into AI answers. Geocoding needs no key.
                </div>
                <EnvKey name={braveVar} detected={hasBrave} source={braveSource} />
              </div>
              <div className="setting-control">
                <Switch
                  checked={braveOn && hasBrave}
                  onChange={setBraveOn}
                  disabled={!hasBrave || !enabled}
                  label="Enable web research"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CadencePanel({ cadence, setCadence, latestJob }) {
  return (
    <div className="card">
      <div className="card-header"><div className="card-title">Schedule</div></div>
      <div className="card-body">
        <div className="admin-label">Refresh cadence</div>
        <div className="cadence-list">
          {CADENCE_OPTIONS.map((o) => (
            <label key={o.key} className={`cadence-option ${cadence === o.key ? "active" : ""}`}>
              <input
                type="radio"
                name="cadence"
                checked={cadence === o.key}
                onChange={() => setCadence(o.key)}
              />
              <span>{o.label}</span>
              {o.key === "biweekly" && <em>default</em>}
            </label>
          ))}
        </div>

        <div className="schedule-note">
          <div className="admin-label">Next target</div>
          <div className="schedule-note-main">{nextCadenceTarget(cadence)}</div>
          <div className="schedule-note-sub">
            Stored locally for the admin panel. The backend remains manual; wire cron or launchd to the refresh-all endpoint when scheduling is enabled.
          </div>
        </div>

        {latestJob && (
          <div className="schedule-note" style={{ marginTop: 10 }}>
            <div className="admin-label">Latest admin run</div>
            <div className="schedule-note-main">{fmt.relative(latestJob.finished_at)}</div>
            <div className="schedule-note-sub">
              {latestJob.ok}/{latestJob.total} properties completed · {latestJob.issues} issues
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

window.DashboardPage = DashboardPage;
window.AddPropertyPage = AddPropertyPage;
window.AreaListingsCard = AreaListingsCard;
window.PropertyDetailPage = PropertyDetailPage;
window.AdminPage = AdminPage;
