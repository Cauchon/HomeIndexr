// HomeIndexr — Browse page (design Option B: card gallery + chip filter bar).
//
// A cache-only discovery surface: it reads GET /api/browse, which unions the
// per-ZIP `area_listings` cache (populated by property refresh) into one pool of
// for-sale homes you don't already track. Filtering and sorting run client-side
// over the whole (bounded) pool — instant, and faithful to the design — while
// the server supplies stable slider bounds + a price histogram so the controls
// don't jump as you filter. The per-card "Track home" button reuses the same add
// flow as the comp cards (window.useTrackComp), so tracking a home POSTs its
// address through the normal server-side Realtor match.
//
// All visuals use the bx- classes from styles.css. Hooks are aliased (…_bx) to
// avoid colliding with the other no-module scripts sharing global scope.

const { useState: useS_bx, useEffect: useE_bx, useMemo: useM_bx, useRef: useR_bx } = React;

const money = (n, compact) => fmt.usd(n, { compact: !!compact });

// Mirror browse.py fallbacks so the sliders have a span before data lands.
const BX_PRICE_FALLBACK = [200000, 1500000];
const BX_SQFT_FALLBACK = [800, 3500];
const BX_YEAR_FALLBACK = [1900, 2026];

const BX_STATUS_ORDER = ["for_sale", "pending", "sold", "off_market"];
const BX_BEDS = [
  { v: 0, label: "Any" }, { v: 1, label: "1+" }, { v: 2, label: "2+" },
  { v: 3, label: "3+" }, { v: 4, label: "4+" }, { v: 5, label: "5+" },
];
const BX_BATHS = [
  { v: 0, label: "Any" }, { v: 1, label: "1+" }, { v: 2, label: "2+" },
  { v: 3, label: "3+" }, { v: 4, label: "4+" },
];
const BX_SORTS = [
  { v: "relevance", label: "Newest listed" },
  { v: "price_desc", label: "Price: high to low" },
  { v: "price_asc", label: "Price: low to high" },
  { v: "sqft_desc", label: "Largest sqft" },
  { v: "year_desc", label: "Newest built" },
  { v: "dom_asc", label: "Fewest days on market" },
];

// How many cards to render initially / per "Load more" click.
const BX_PAGE = 24;

function statusLabel(s) {
  return ((window.LISTING_META || {})[s] || {}).label || s;
}
const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

// ---------- filter + sort over the real card shape ----------
function bxApplyFilters(homes, f, bounds) {
  const q = (f.q || "").trim().toLowerCase();
  return homes.filter((h) => {
    if (q) {
      const hay = `${h.line || ""} ${h.city || ""} ${h.state || ""} ${h.zip || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const price = h.list_price;
    if (price != null) {
      if (price < f.price[0] || price > f.price[1]) return false;
    } else if (f.price[0] !== bounds.price[0] || f.price[1] !== bounds.price[1]) {
      return false; // unpriced homes drop out once the price filter is narrowed
    }
    if ((h.beds ?? 0) < f.beds) return false;
    if ((h.baths ?? 0) < f.baths) return false;
    if (h.sqft != null && (h.sqft < f.sqft[0] || h.sqft > f.sqft[1])) return false;
    if (h.year_built != null && (h.year_built < f.year[0] || h.year_built > f.year[1])) return false;
    if (f.status.length && !f.status.includes(h.listing_state || "off_market")) return false;
    return true;
  });
}

function bxSortHomes(homes, sort) {
  const a = [...homes];
  switch (sort) {
    case "price_desc": return a.sort((x, y) => (y.list_price ?? 0) - (x.list_price ?? 0));
    case "price_asc": return a.sort((x, y) => (x.list_price ?? Infinity) - (y.list_price ?? Infinity));
    case "sqft_desc": return a.sort((x, y) => (y.sqft ?? 0) - (x.sqft ?? 0));
    case "year_desc": return a.sort((x, y) => (y.year_built ?? 0) - (x.year_built ?? 0));
    case "dom_asc": return a.sort((x, y) => (x.days_on_market ?? 1e9) - (y.days_on_market ?? 1e9));
    default: return a; // relevance = server order (newest listed first)
  }
}

// ---------- status badge ----------
function BxStatus({ state, className = "" }) {
  return (
    <span className={`bx-st ${state || "off_market"} ${className}`}>
      <i />{statusLabel(state)}
    </span>
  );
}

// ---------- photo with real listing image (+ status + price overlay) ----------
function BrowsePhoto({ home }) {
  const url = home.photo_url ? rdcResize(home.photo_url, "x") : null;
  const tag = home.listing_state === "pending" ? "Pending"
    : home.listing_state === "sold" ? "Sold" : "Listed";
  return (
    <div className="bx-photo">
      {url
        ? <img className="bx-photo-img" src={url}
            srcSet={`${url} 1x, ${rdcResize(home.photo_url, "od")} 2x`} alt="" loading="lazy" />
        : <Icon name="home" size={32} className="glyph" />}
      <BxStatus state={home.listing_state} className="ph-status" />
      {home.list_price != null && (
        <span className="ph-price"><span className="tag">{tag}</span>{money(home.list_price, true)}</span>
      )}
    </div>
  );
}

// ---------- dual-handle range slider w/ histogram ----------
function DualRange({ min, max, step = 1000, value, onChange, hist, format }) {
  const [lo, hi] = value;
  const fmtV = format || ((v) => money(v, true));
  const span = max - min || 1;
  const pct = (v) => ((v - min) / span) * 100;
  const n = hist ? hist.length : 0;
  const inRange = (i) => {
    const c = min + ((i + 0.5) / n) * span;
    return c >= lo && c <= hi;
  };
  const maxH = hist && hist.length ? Math.max(...hist, 1) : 1;
  return (
    <div className="bx-range">
      {hist && hist.length > 0 && (
        <div className="bx-hist">
          {hist.map((b, i) => (
            <div key={i} className={`b ${inRange(i) ? "in" : ""}`} style={{ height: `${6 + (b / maxH) * 94}%` }} />
          ))}
        </div>
      )}
      <div className="bx-slider">
        <div className="track" />
        <div className="fill" style={{ left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%` }} />
        <input type="range" min={min} max={max} step={step} value={lo}
          style={{ zIndex: lo > max - span * 0.12 ? 5 : 3 }}
          onChange={(e) => onChange([Math.min(+e.target.value, hi - step), hi])} />
        <input type="range" min={min} max={max} step={step} value={hi}
          style={{ zIndex: 4 }}
          onChange={(e) => onChange([lo, Math.max(+e.target.value, lo + step)])} />
      </div>
      <div className="bx-range-vals">
        <span className="v">{fmtV(lo)}</span>
        <span className="dash">to</span>
        <span className="v">{hi >= max ? fmtV(max) + "+" : fmtV(hi)}</span>
      </div>
    </div>
  );
}

// ---------- pill row (single-select) ----------
function PillRow({ options, value, onChange }) {
  return (
    <div className="bx-pills">
      {options.map((o) => (
        <button key={o.v} className={value === o.v ? "on" : ""} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

// ---------- status checklist (multi) ----------
function CheckList({ options, selected, onToggle, counts }) {
  return (
    <div className="bx-checks">
      {options.map((o) => {
        const on = selected.includes(o.v);
        return (
          <label key={o.v} className="bx-check">
            <input type="checkbox" checked={on} onChange={() => onToggle(o.v)} />
            <span className="box"><Icon name="check" size={11} /></span>
            <span>{o.label}</span>
            {counts && <span className="ct">{counts[o.v] ?? 0}</span>}
          </label>
        );
      })}
    </div>
  );
}

// ---------- sort menu ----------
function SortMenu({ value, onChange }) {
  const [open, setOpen] = useS_bx(false);
  const ref = useR_bx(null);
  useE_bx(() => {
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);
  const cur = BX_SORTS.find((s) => s.v === value) || BX_SORTS[0];
  return (
    <div className="bx-sort" ref={ref}>
      <button className="bx-sortbtn" onClick={() => setOpen((o) => !o)}>
        <Icon name="sort" size={13} /><span className="k">Sort:</span> {cur.label}
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="bx-pop" style={{ right: 0, left: "auto", minWidth: 210 }}>
          {BX_SORTS.map((s) => (
            <button key={s.v} className="bx-popopt" data-on={s.v === value ? "1" : "0"}
              onClick={() => { onChange(s.v); setOpen(false); }}>
              {s.label}{s.v === value && <Icon name="check" size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- filter pill + popover ----------
function FilterPill({ label, summary, active, onClear, children, wide }) {
  const [open, setOpen] = useS_bx(false);
  const ref = useR_bx(null);
  useE_bx(() => {
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);
  return (
    <span className={`bx-fpill ${active ? "on" : ""}`} ref={ref} onClick={() => setOpen((o) => !o)}>
      <span>{label}{active && summary ? ": " : ""}</span>
      {active && summary && <span className="v">{summary}</span>}
      {active
        ? <span className="clr" onClick={(e) => { e.stopPropagation(); onClear(); setOpen(false); }}><Icon name="x" size={11} /></span>
        : <span className="chev"><Icon name="chevronDown" size={12} /></span>}
      {open && (
        <div className={`bx-pop ${wide ? "wide" : ""}`} onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      )}
    </span>
  );
}

// ---------- home card ----------
function BrowseCard({ home, navigate, onChanged }) {
  const { tracked, saving, track } = useTrackComp(home, navigate, onChanged, { navigateOnSuccess: false });
  const cityLine = compCityLine(home);
  const addr = home.line || home.address || "—";
  return (
    <div className="bx-card">
      <BrowsePhoto home={home} />
      <div className="cbody">
        <div className="caddr" title={cityLine ? `${addr}, ${cityLine}` : addr}>
          {addr}{cityLine && <span className="sub">{cityLine}</span>}
        </div>
        <div className="cspecs">
          <span>{home.beds != null ? `${home.beds} bd` : "— bd"}</span><span className="dot" />
          <span>{home.baths != null ? `${fmt.baths(home.baths)} ba` : "— ba"}</span><span className="dot" />
          <span className="mut">{home.sqft != null ? `${fmt.num(home.sqft)} sqft` : "— sqft"}</span>
        </div>
        <div className="cest">
          <span className="ev">{home.days_on_market != null ? `${home.days_on_market} days on market` : "On market"}</span>
          <span className="mut">{home.price_per_sqft != null ? `${fmt.usd(home.price_per_sqft)}/sqft` : "—"}</span>
        </div>
        <button className={`ctrack ${tracked ? "on" : ""}`} onClick={track} disabled={saving || tracked}
          title={tracked ? "Tracking — added to your properties" : "Add to your tracked properties"}>
          {tracked
            ? <><Icon name="check" size={14} />Tracking</>
            : <><Icon name="plus" size={14} />{saving ? "Tracking…" : "Track home"}</>}
        </button>
      </div>
    </div>
  );
}

// ---------- page ----------
function makeBxDefault(bounds, statusVs) {
  return {
    q: "",
    price: [bounds.price[0], bounds.price[1]],
    beds: 0, baths: 0,
    sqft: [bounds.sqft[0], bounds.sqft[1]],
    year: [bounds.year[0], bounds.year[1]],
    status: [...statusVs],
  };
}

function BrowsePage({ navigate, onChanged }) {
  const [load, setLoad] = useS_bx({ loading: true, err: null, data: null });
  const [f, setF] = useS_bx(null);
  const [sort, setSort] = useS_bx("relevance");
  const [visible, setVisible] = useS_bx(BX_PAGE);

  // Reset to the first page whenever the filters, search, or sort change.
  useE_bx(() => { setVisible(BX_PAGE); }, [f, sort]);

  useE_bx(() => {
    let active = true;
    setLoad({ loading: true, err: null, data: null });
    API.browse()
      .then((d) => { if (active) { setLoad({ loading: false, err: null, data: d }); setF(null); } })
      .catch((e) => { if (active) setLoad({ loading: false, err: e.message || "Failed to load homes", data: null }); });
    return () => { active = false; };
  }, []);

  const data = load.data;
  const bounds = useM_bx(() => ({
    price: (data && data.bounds && data.bounds.price) || BX_PRICE_FALLBACK,
    sqft: (data && data.bounds && data.bounds.sqft) || BX_SQFT_FALLBACK,
    year: (data && data.bounds && data.bounds.year) || BX_YEAR_FALLBACK,
  }), [data]);
  const statusOptions = useM_bx(() => {
    const present = (data && data.statuses) || {};
    return BX_STATUS_ORDER.filter((s) => present[s]).map((s) => ({ v: s, label: statusLabel(s) }));
  }, [data]);
  const statusCounts = useM_bx(() => (data && data.statuses) || {}, [data]);

  const ff = f || makeBxDefault(bounds, statusOptions.map((o) => o.v));
  const set = (patch) => setF((p) => ({ ...(p || makeBxDefault(bounds, statusOptions.map((o) => o.v))), ...patch }));

  const rows = useM_bx(
    () => (data ? bxSortHomes(bxApplyFilters(data.homes, ff, bounds), sort) : []),
    [data, ff, sort, bounds]
  );

  // Auto-reveal the next page as the sentinel nears the viewport. The "Load more"
  // button remains as a keyboard/no-observer fallback.
  const moreRef = useR_bx(null);
  useE_bx(() => {
    const el = moreRef.current;
    if (!el || visible >= rows.length) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setVisible((v) => v + BX_PAGE); },
      { rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible, rows.length]);

  if (load.loading) {
    return (
      <div className="browse-page">
        <div className="page-header"><div><h1 className="page-title">Browse homes</h1>
          <div className="page-subtitle">Loading homes from your tracked areas…</div></div></div>
      </div>
    );
  }
  if (load.err) {
    return (
      <div className="browse-page">
        <div className="page-header"><div><h1 className="page-title">Browse homes</h1></div></div>
        <div className="empty"><div className="title">Couldn't load homes</div><div>{load.err}</div></div>
      </div>
    );
  }

  // Cache empty: Browse fills in as the user refreshes tracked properties.
  if (!data.total) {
    return (
      <div className="browse-page">
        <div className="page-header">
          <div>
            <h1 className="page-title">Browse homes</h1>
            <div className="page-subtitle">Discover for-sale homes in the areas you already track.</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => navigate("dashboard")}><Icon name="list" /> My properties</button>
          </div>
        </div>
        <div className="empty">
          <div className="title">No homes to browse yet</div>
          <div>Browse is built from the for-sale listings cached when you refresh a tracked property —
            each refresh saves the active homes in that ZIP. Add a property and refresh it to start
            filling this in.</div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={() => navigate("add")}><Icon name="plus" /> Add property</button>
          </div>
        </div>
      </div>
    );
  }

  const cities = data.cities || [];
  const where = cities.length === 1 ? `in ${cities[0]}`
    : cities.length > 1 ? `across ${cities.length} areas you track`
    : "in your tracked areas";

  const priceActive = ff.price[0] !== bounds.price[0] || ff.price[1] !== bounds.price[1];
  const bedActive = ff.beds > 0 || ff.baths > 0;
  const statusActive = ff.status.length !== statusOptions.length;
  const moreActive = ff.sqft[0] !== bounds.sqft[0] || ff.sqft[1] !== bounds.sqft[1]
    || ff.year[0] !== bounds.year[0] || ff.year[1] !== bounds.year[1];

  return (
    <div className="browse-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Browse homes</h1>
          <div className="page-subtitle">
            <b style={{ color: "var(--text)", fontWeight: 600 }}>{data.total.toLocaleString()}</b> homes {where}
            {" · "}
            <b style={{ color: "var(--text)", fontWeight: 600 }}>{rows.length.toLocaleString()}</b>
            {" matching"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => navigate("dashboard")}><Icon name="list" /> My properties</button>
        </div>
      </div>

      <div className="bx-chipbar">
        <div className="bx-chiprow">
          <div className="field">
            <Icon name="search" size={14} />
            <input placeholder="City, ZIP, or address" value={ff.q} onChange={(e) => set({ q: e.target.value })} />
          </div>
          <FilterPill
            label="Price" active={priceActive}
            summary={`${money(ff.price[0], true)}–${ff.price[1] >= bounds.price[1] ? money(bounds.price[1], true) + "+" : money(ff.price[1], true)}`}
            onClear={() => set({ price: [bounds.price[0], bounds.price[1]] })} wide
          >
            <span className="poplab">Price range</span>
            <DualRange min={bounds.price[0]} max={bounds.price[1]} step={10000} value={ff.price}
              hist={data.price_hist} onChange={(v) => set({ price: v })} />
          </FilterPill>
          <FilterPill
            label="Beds & baths" active={bedActive}
            summary={`${ff.beds ? ff.beds + "+ bd" : ""}${ff.beds && ff.baths ? " · " : ""}${ff.baths ? ff.baths + "+ ba" : ""}`}
            onClear={() => set({ beds: 0, baths: 0 })} wide
          >
            <span className="poplab">Bedrooms</span>
            <PillRow options={BX_BEDS} value={ff.beds} onChange={(v) => set({ beds: v })} />
            <span className="poplab">Bathrooms</span>
            <PillRow options={BX_BATHS} value={ff.baths} onChange={(v) => set({ baths: v })} />
          </FilterPill>
          {statusOptions.length > 1 && (
            <FilterPill
              label="Status" active={statusActive}
              summary={ff.status.length === 1 ? statusLabel(ff.status[0]) : `${ff.status.length} types`}
              onClear={() => set({ status: statusOptions.map((o) => o.v) })}
            >
              <span className="poplab">Listing status</span>
              <CheckList options={statusOptions} selected={ff.status} counts={statusCounts}
                onToggle={(v) => set({ status: toggleIn(ff.status, v) })} />
            </FilterPill>
          )}
          <FilterPill
            label="More" active={moreActive} summary={moreActive ? "on" : ""}
            onClear={() => set({ sqft: [bounds.sqft[0], bounds.sqft[1]], year: [bounds.year[0], bounds.year[1]] })} wide
          >
            <span className="poplab">Square feet</span>
            <DualRange min={bounds.sqft[0]} max={bounds.sqft[1]} step={50} value={ff.sqft}
              onChange={(v) => set({ sqft: v })} format={(v) => v.toLocaleString()} />
            <span className="poplab">Year built</span>
            <DualRange min={bounds.year[0]} max={bounds.year[1]} step={1} value={ff.year}
              onChange={(v) => set({ year: v })} format={(v) => String(v)} />
          </FilterPill>
          <span className="spacer" />
          <SortMenu value={sort} onChange={setSort} />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <div className="title">No homes match these filters</div>
          <div>Try widening the price range or clearing a filter.</div>
        </div>
      ) : (
        <>
          <div className="bx-grid">
            {rows.slice(0, visible).map((h) => (
              <BrowseCard key={h.property_id} home={h} navigate={navigate} onChanged={onChanged} />
            ))}
          </div>
          {visible < rows.length && (
            <div className="bx-more" ref={moreRef}>
              <span className="bx-more-count">
                Showing {Math.min(visible, rows.length).toLocaleString()} of {rows.length.toLocaleString()}
              </span>
              <button className="btn" onClick={() => setVisible((v) => v + BX_PAGE)}>
                Load more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

window.BrowsePage = BrowsePage;
