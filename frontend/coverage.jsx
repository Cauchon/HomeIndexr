// HomeIndexr — Tracked areas (Browse coverage management)
//
// Browse only shows homes from ZIP codes we've crawled from Realtor.com. This
// surface (Admin → Tracked areas) lets a user manage that set: add a ZIP (kicks
// off a one-time server-side crawl), pause one (hides its homes from Browse
// without dropping the crawled index), re-crawl to refresh, or remove it.
//
// All data flows through window.API; no client-side scraping. The coverage
// record shape comes from GET /api/admin/areas:
//   { zip, city, state, count, status: "active"|"paused",
//     fetched_at, origin: "property"|"manual", locked }
// A ZIP that backs an active tracked property is `locked` (origin "property")
// and can't be removed until that property is gone.
//
// Exposes to window: CoverageSection, AddZipModal, RemoveZipModal.

const { useState: cvS, useEffect: cvE, useMemo: cvM } = React;

// ---------- stats ----------
function coverageStats(coverage) {
  const active = coverage.filter((c) => c.status === "active");
  const indexed = active.reduce((n, c) => n + (c.count || 0), 0);
  const lastCrawled = coverage.reduce((m, c) => Math.max(m, c.fetched_at || 0), 0);
  const cities = Array.from(new Set(active.map((c) => c.city).filter(Boolean)));
  return { active: active.length, total: coverage.length, indexed, lastCrawled, cities };
}

const ORIGIN_META = {
  property: { label: "From a property", cls: "info" },
  manual:   { label: "Added manually", cls: "neutral" },
};

// "City, ST" line for a coverage row, tolerant of missing locality.
function areaLocality(c) {
  return [c.city, c.state].filter(Boolean).join(", ") || "Unknown area";
}

// pause = two bars; resume/play = triangle. Clearer than a generic eye.
function PauseGlyph({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6.5" y="5" width="3.5" height="14" rx="1.2" />
      <rect x="14" y="5" width="3.5" height="14" rx="1.2" />
    </svg>
  );
}
function PlayGlyph({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5.5l11 6.5-11 6.5z" />
    </svg>
  );
}
function LockGlyph({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

// ============================================================
//   ADMIN SECTION — Tracked areas
// ============================================================
function CoverageSection() {
  const toast = useToast();
  const [coverage, setCoverage] = cvS([]);
  const [loading, setLoading] = cvS(true);
  const [error, setError] = cvS(null);
  const [adding, setAdding] = cvS(false);
  const [removing, setRemoving] = cvS(null);   // coverage record or null
  const [crawling, setCrawling] = cvS(() => new Set());  // zips mid-recrawl
  const [busy, setBusy] = cvS(() => new Set());          // zips mid pause/resume

  const stats = cvM(() => coverageStats(coverage), [coverage]);

  function load() {
    setLoading(true);
    API.listAreas()
      .then((rows) => { setCoverage(Array.isArray(rows) ? rows : []); setError(null); })
      .catch((e) => setError(e.message || "Couldn't load tracked areas"))
      .finally(() => setLoading(false));
  }
  cvE(() => { load(); }, []);

  // Swap a single record in place after a server mutation.
  function replaceRec(rec) {
    setCoverage((cs) => cs.map((c) => (c.zip === rec.zip ? rec : c)));
  }
  function markBusy(setFn, zip, on) {
    setFn((s) => { const n = new Set(s); on ? n.add(zip) : n.delete(zip); return n; });
  }

  function recrawl(rec) {
    if (crawling.has(rec.zip)) return;
    markBusy(setCrawling, rec.zip, true);
    API.recrawlArea(rec.zip)
      .then((updated) => {
        replaceRec(updated);
        toast.push({ kind: "ok", text: `Re-crawled ${rec.zip} · ${(updated.count || 0).toLocaleString()} homes` });
      })
      .catch((e) => toast.push({ kind: "err", text: e.message || `Couldn't re-crawl ${rec.zip}` }))
      .finally(() => markBusy(setCrawling, rec.zip, false));
  }

  function toggle(rec) {
    if (busy.has(rec.zip)) return;
    const next = rec.status === "active" ? "paused" : "active";
    markBusy(setBusy, rec.zip, true);
    API.setAreaStatus(rec.zip, next)
      .then((updated) => {
        replaceRec(updated);
        toast.push(next === "paused"
          ? { text: `Paused ${rec.zip} — its homes are hidden from Browse` }
          : { kind: "ok", text: `Resumed ${rec.zip}` });
      })
      .catch((e) => toast.push({ kind: "err", text: e.message || `Couldn't update ${rec.zip}` }))
      .finally(() => markBusy(setBusy, rec.zip, false));
  }

  return (
    <div>
      <div className="admin-section-head">
        <div>
          <h2>Tracked areas</h2>
          <div className="sub">ZIP codes we crawl from Realtor.com — the pool Browse draws from</div>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> Add ZIP code
        </button>
      </div>

      <div className="facts" style={{ marginBottom: 16 }}>
        <div className="fact">
          <div className="label">ZIP codes tracked</div>
          <div className="value">{stats.active}{stats.total !== stats.active && (
            <span style={{ fontSize: 14, color: "var(--text-muted)", fontWeight: 400 }}> / {stats.total}</span>
          )}</div>
          <div className="sub">{stats.cities.length} {stats.cities.length === 1 ? "city" : "cities"}{stats.total !== stats.active ? ` · ${stats.total - stats.active} paused` : ""}</div>
        </div>
        <div className="fact">
          <div className="label">Homes indexed</div>
          <div className="value">{stats.indexed.toLocaleString()}</div>
          <div className="sub">available in Browse</div>
        </div>
        <div className="fact">
          <div className="label">Last crawl</div>
          <div className="value sm">{stats.lastCrawled ? fmt.relative(stats.lastCrawled) : "—"}</div>
          <div className="sub">{stats.lastCrawled ? fmt.datetime(stats.lastCrawled) : "no crawls yet"}</div>
        </div>
        <div className="fact">
          <div className="label">Source</div>
          <div className="value sm">Realtor.com</div>
          <div className="sub">one-time crawl per ZIP</div>
        </div>
      </div>

      <div className="cov-note">
        <Icon name="alert" size={14} />
        <span>
          Adding or refreshing a property automatically crawls its whole ZIP. Pausing a
          ZIP keeps its index but hides its homes from Browse. A ZIP that backs a property
          you track can't be removed until that property is gone — other ZIPs can be
          removed anytime, which discards their index.
        </span>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="card-title">Coverage · {coverage.length} {coverage.length === 1 ? "ZIP" : "ZIPs"}</div>
        </div>
        <div className="card-body flush">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : error ? (
            <div className="empty">
              <div className="title">Couldn't load tracked areas</div>
              <div>{error}</div>
            </div>
          ) : coverage.length === 0 ? (
            <div className="empty">
              <div className="title">No areas tracked yet</div>
              <div>Add a ZIP code to crawl it and start browsing homes there, or add a property — that crawls its ZIP for you.</div>
            </div>
          ) : (
            <table className="data cov-table">
              <thead>
                <tr>
                  <th>ZIP &amp; area</th>
                  <th className="num">Homes</th>
                  <th>Source</th>
                  <th>Last crawled</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((c) => {
                  const isCrawling = crawling.has(c.zip);
                  const isBusy = busy.has(c.zip);
                  const o = ORIGIN_META[c.origin] || ORIGIN_META.manual;
                  return (
                    <tr key={c.zip} className={c.status === "paused" ? "is-paused" : ""}>
                      <td>
                        <div className="cov-zip">
                          <span className="z">{c.zip}</span>
                          <span className="a">{areaLocality(c)}</span>
                        </div>
                      </td>
                      <td className="num cov-homes">{(c.count || 0).toLocaleString()}</td>
                      <td><span className={`badge ${o.cls}`}>{o.label}</span></td>
                      <td className="muted">
                        {isCrawling
                          ? <span className="cov-crawling"><span className="dot" />Crawling…</span>
                          : (c.fetched_at ? fmt.relative(c.fetched_at) : "—")}
                      </td>
                      <td>
                        {c.status === "active"
                          ? <span className="badge ok"><span className="dot" />Active</span>
                          : <span className="badge neutral">Paused</span>}
                      </td>
                      <td>
                        <div className="cov-actions">
                          <button className="icon-btn" title="Re-crawl this ZIP" disabled={isCrawling}
                                  onClick={() => recrawl(c)}>
                            <Icon name="refresh" size={14} className={isCrawling ? "spin" : ""} />
                          </button>
                          <button className="icon-btn" disabled={isBusy}
                                  title={c.status === "active" ? "Pause tracking" : "Resume tracking"}
                                  onClick={() => toggle(c)}>
                            {c.status === "active" ? <PauseGlyph /> : <PlayGlyph />}
                          </button>
                          {c.locked ? (
                            <button className="icon-btn" disabled
                                    title="Can't remove — a property you track is in this ZIP. Delete that property first.">
                              <LockGlyph />
                            </button>
                          ) : (
                            <button className="icon-btn danger" title="Remove ZIP" onClick={() => setRemoving(c)}>
                              <Icon name="trash" size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {adding && (
        <AddZipModal
          existing={coverage.map((c) => c.zip)}
          onClose={() => setAdding(false)}
          onAdded={(rec) => {
            setCoverage((cs) => [rec, ...cs.filter((c) => c.zip !== rec.zip)]);
            setAdding(false);
            toast.push({ kind: "ok", text: `Tracking ${rec.zip} · indexed ${(rec.count || 0).toLocaleString()} homes` });
          }}
        />
      )}
      {removing && (
        <RemoveZipModal
          record={removing}
          onConfirm={() => {
            const z = removing.zip;
            API.removeArea(z)
              .then(() => {
                setCoverage((cs) => cs.filter((c) => c.zip !== z));
                toast.push({ text: `Removed ${z} from tracked areas` });
              })
              .catch((e) => toast.push({ kind: "err", text: e.message || `Couldn't remove ${z}` }))
              .finally(() => setRemoving(null));
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

// ============================================================
//   ADD ZIP MODAL — enter ZIP, crawl server-side, confirm
// ============================================================
function AddZipModal({ existing, onClose, onAdded }) {
  const [zip, setZip] = cvS("");
  const [phase, setPhase] = cvS("input");   // input | crawling | done | error
  const [record, setRecord] = cvS(null);
  const [errMsg, setErrMsg] = cvS(null);

  const clean = zip.replace(/\D/g, "").slice(0, 5);
  const valid = /^\d{5}$/.test(clean);
  const dup = existing.includes(clean);

  function startCrawl() {
    if (!valid || dup) return;
    setPhase("crawling");
    setErrMsg(null);
    API.addArea(clean)
      .then((rec) => { setRecord(rec); setPhase("done"); })
      .catch((e) => { setErrMsg(e.message || "Crawl failed"); setPhase("error"); });
  }

  const locality = record ? [record.city, record.state].filter(Boolean).join(", ") : "";

  return (
    <div className="modal-backdrop" onClick={phase === "crawling" ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Add a ZIP code</h3>
          <div className="desc">We'll crawl Realtor.com once and add every listing to Browse</div>
        </div>
        <div className="modal-body">
          {phase === "input" && (
            <>
              <div className="cov-field">
                <Icon name="map" size={15} />
                <input
                  autoFocus
                  inputMode="numeric"
                  placeholder="e.g. 78703"
                  value={clean}
                  maxLength={5}
                  onChange={(e) => setZip(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && valid && !dup) startCrawl(); }}
                />
                <span className="cov-zip-state">{clean.length}/5</span>
              </div>
              {dup && <div className="cov-warn"><Icon name="alert" size={13} />{clean} is already being tracked.</div>}
              {!valid && clean.length > 0 && !dup && <div className="hint">Enter a full 5-digit ZIP code.</div>}
              {clean.length === 0 && <div className="hint">A first crawl runs server-side against Realtor.com and indexes every active for-sale listing in the ZIP — usually a few seconds.</div>}
            </>
          )}

          {phase !== "input" && (
            <div className="cov-crawl">
              <div className="cov-crawl-head">
                <span className="z">{clean}</span>
                {locality && <span className="c">{locality}</span>}
              </div>
              <div className={"progress" + (phase === "crawling" ? " indeterminate" : "")} style={{ height: 6 }}>
                <div className="fill" style={{ width: phase === "crawling" ? undefined : "100%" }} />
              </div>
              <div className="cov-crawl-stat">
                {phase === "crawling" && (
                  <span className="cov-crawling"><span className="dot" />Crawling Realtor.com…</span>
                )}
                {phase === "done" && record && (
                  <>
                    <span style={{ color: "var(--pos)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <Icon name="check" size={14} />Crawl complete
                    </span>
                    <span className="n">{(record.count || 0).toLocaleString()} homes indexed</span>
                  </>
                )}
                {phase === "error" && (
                  <span style={{ color: "var(--neg)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Icon name="alert" size={14} />{errMsg}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {phase === "input" && (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={!valid || dup} onClick={startCrawl}>
                <Icon name="refresh" size={13} /> Crawl &amp; track
              </button>
            </>
          )}
          {phase === "crawling" && (
            <button className="btn" disabled>Crawling…</button>
          )}
          {phase === "error" && (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={startCrawl}>
                <Icon name="refresh" size={13} /> Try again
              </button>
            </>
          )}
          {phase === "done" && record && (
            <button className="btn btn-primary" onClick={() => onAdded(record)}>
              <Icon name="check" size={13} /> Add to Browse
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
//   REMOVE ZIP MODAL
// ============================================================
function RemoveZipModal({ record, onClose, onConfirm }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Remove {record.zip} from tracked areas?</h3>
          <div className="desc">{areaLocality(record)}</div>
        </div>
        <div className="modal-body">
          <p style={{ margin: "0 0 10px" }}>
            Browse will stop showing the <strong>{(record.count || 0).toLocaleString()}</strong> homes
            indexed in this ZIP.
          </p>
          <ul className="bullet-list">
            <li>The crawled index for {record.zip} is discarded</li>
            <li>Properties you track in this ZIP are <strong>not</strong> affected</li>
            <li>You can re-add the ZIP later to crawl it again</li>
          </ul>
          <div className="hint" style={{ marginTop: 10 }}>
            Just want to hide it for now? <em>Pause</em> the ZIP instead — that keeps the index.
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger-solid" onClick={onConfirm}>
            <Icon name="trash" size={13} /> Remove ZIP
          </button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  coverageStats,
  CoverageSection, AddZipModal, RemoveZipModal,
});
