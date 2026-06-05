// HomeIndexr — Mortgage calculator page.
//
// Ported from the Claude Design handoff (mortgage-core.jsx + pages-mortgage.jsx).
// A standalone calculator with an optional "load from a tracked property"
// picker, a monthly-payment breakdown + donut, and a full amortization
// schedule, in the two-pane (Bankrate-style) layout the design landed on.
//
// The math + sub-components are pure. The property picker reads the current
// AVM/price fields straight off the flat /api/properties rows — the real API
// has no per-property `snapshots` array, so the design's snapshot-based prefill
// is adapted to the live shape here.
//
// No-build file: suffixed React-hook aliases keep the top-level `const`s from
// colliding in the shared global lexical scope, and shared globals (fmt, Icon,
// splitAddress, displayAddress, displayName) are referenced directly.

const { useState: useS_m, useEffect: useE_m, useMemo: useM_m, useRef: useR_m } = React;

// ---------- Category model ----------
const M_CATS = [
  { key: "pi",  label: "Principal & interest",       color: "var(--m-pi)"  },
  { key: "tax", label: "Property tax",               color: "var(--m-tax)" },
  { key: "ins", label: "Homeowner's insurance",      color: "var(--m-ins)" },
  { key: "pmi", label: "Mortgage insurance (PMI)",   color: "var(--m-pmi)" },
  { key: "hoa", label: "HOA dues",                   color: "var(--m-hoa)" },
];

// Suggested 30yr rate by credit band (illustrative spread off a base).
const CREDIT_BANDS = [
  { v: "740+",      label: "740+",      adj: 0.00 },
  { v: "720-739",   label: "720–739",   adj: 0.18 },
  { v: "700-719",   label: "700–719",   adj: 0.38 },
  { v: "680-699",   label: "680–699",   adj: 0.62 },
  { v: "660-679",   label: "660–679",   adj: 0.94 },
  { v: "640-659",   label: "640–659",   adj: 1.35 },
];
const BASE_RATE_30 = 6.85; // national-average anchor for the 740+ band
// shorter terms price a little tighter
const TERM_RATE_ADJ = { 30: 0, 20: -0.15, 15: -0.55, 10: -0.65 };

// Auto-estimate rates used to default the annual $ fields from the home price
// (and loan, for PMI). The user can override any field with a flat $ amount.
const M_TAX_RATE = 1.1;  // %/yr of home price
const M_INS_RATE = 0.40; // %/yr of home price
const M_PMI_RATE = 0.5;  // %/yr of loan amount (only below 20% down)

function suggestedRate(term, creditBand) {
  const band = CREDIT_BANDS.find((b) => b.v === creditBand) || CREDIT_BANDS[0];
  return +(BASE_RATE_30 + (TERM_RATE_ADJ[term] || 0) + band.adj).toFixed(2);
}

// ---------- Core math ----------
function computeMortgage(inp) {
  const price = Math.max(0, inp.price || 0);
  const downPct = Math.min(1, Math.max(0, inp.downPct || 0));
  const down = Math.round(price * downPct);
  const loan = Math.max(0, price - down);
  const term = inp.term || 30;
  const n = term * 12;
  const r = (inp.rate || 0) / 100 / 12;

  let pi = 0;
  if (loan > 0 && n > 0) {
    pi = r === 0 ? loan / n : (loan * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  }

  // Annual $ amounts — user-entered when present, else auto-estimated from
  // price/loan so loading a property still yields sensible figures.
  const taxAnnual = inp.taxAnnual != null ? Math.max(0, inp.taxAnnual) : (price * M_TAX_RATE) / 100;
  const insAnnual = inp.insAnnual != null ? Math.max(0, inp.insAnnual) : (price * M_INS_RATE) / 100;
  const pmiActive = downPct < 0.2 && loan > 0;
  const pmiAnnualInput = inp.pmiAnnual != null ? Math.max(0, inp.pmiAnnual) : (loan * M_PMI_RATE) / 100;
  const pmiAnnual = pmiActive ? pmiAnnualInput : 0;

  const tax = taxAnnual / 12;
  const ins = insAnnual / 12;
  const pmi = pmiAnnual / 12;
  const hoa = Math.max(0, inp.hoaMonthly || 0);

  const parts = { pi, tax, ins, pmi, hoa };
  const total = pi + tax + ins + pmi + hoa;

  return {
    price, down, downPct, loan, term, n, monthlyRate: r, parts, total, pi, pmiActive,
    taxAnnual, insAnnual, pmiAnnual: pmiAnnualInput,
    taxAuto: inp.taxAnnual == null, insAuto: inp.insAnnual == null, pmiAuto: inp.pmiAnnual == null,
  };
}

// Year-by-year amortization aggregation.
function amortSchedule(loan, monthlyRate, n, monthlyPI) {
  const rows = [];
  let balance = loan;
  let yPrin = 0, yInt = 0, cumInt = 0;
  for (let m = 1; m <= n; m++) {
    const interest = balance * monthlyRate;
    let principal = monthlyPI - interest;
    if (principal > balance) principal = balance;
    balance = Math.max(0, balance - principal);
    yPrin += principal; yInt += interest; cumInt += interest;
    if (m % 12 === 0 || m === n) {
      rows.push({
        year: Math.ceil(m / 12),
        principalPaid: yPrin,
        interestPaid: yInt,
        balance,
        cumInterest: cumInt,
      });
      yPrin = 0; yInt = 0;
    }
  }
  return rows;
}

// ---------- Donut ----------
function PaymentDonut({ result, size = 168, stroke = 16, showCenter = true }) {
  const R = (size - stroke) / 2;
  const C = 2 * Math.PI * R;
  const segs = M_CATS
    .map((c) => ({ ...c, value: result.parts[c.key] }))
    .filter((s) => s.value > 0.5);
  const total = result.total || 1;
  let offset = 0;
  return (
    <div className="m-donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={R} fill="none"
                stroke="var(--bg-sunken)" strokeWidth={stroke} />
        {segs.map((s) => {
          const frac = s.value / total;
          const len = frac * C;
          const el = (
            <circle key={s.key} cx={size / 2} cy={size / 2} r={R} fill="none"
                    stroke={s.color} strokeWidth={stroke}
                    strokeDasharray={`${len} ${C - len}`}
                    strokeDashoffset={-offset}
                    strokeLinecap="butt" />
          );
          offset += len;
          return el;
        })}
      </svg>
      {showCenter && (
        <div className="center">
          <div>
            <div className="v">{fmt.usd(Math.round(result.total))}</div>
            <div className="l">per month</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Breakdown list ----------
function BreakdownList({ result, includeTotal = true }) {
  const total = result.total || 1;
  return (
    <div className="m-breakdown">
      {M_CATS.map((c) => {
        const v = result.parts[c.key];
        const muted = v <= 0.5;
        return (
          <div key={c.key} className={`m-line ${muted ? "muted" : ""}`}>
            <span className="swatch" style={{ background: muted ? "var(--border-strong)" : c.color }} />
            <span className="nm">{c.label}</span>
            {!muted && <span className="pct">{Math.round((v / total) * 100)}%</span>}
            <span className="amt">{muted ? "—" : fmt.usd(Math.round(v))}</span>
          </div>
        );
      })}
      {includeTotal && (
        <div className="m-line is-total">
          <span className="nm">Total monthly payment</span>
          <span className="amt">{fmt.usd(Math.round(result.total))}</span>
        </div>
      )}
    </div>
  );
}

// ---------- Loan facts mini-grid ----------
function LoanFacts({ result }) {
  const totalInterest = useM_m(() => {
    const sched = amortSchedule(result.loan, result.monthlyRate, result.n, result.pi);
    return sched.length ? sched[sched.length - 1].cumInterest : 0;
  }, [result.loan, result.monthlyRate, result.n, result.pi]);
  const payoff = new Date();
  payoff.setMonth(payoff.getMonth() + result.n);
  return (
    <div className="m-loanfacts">
      <div className="lf">
        <div className="k">Loan amount</div>
        <div className="v">{fmt.usd(result.loan)}</div>
      </div>
      <div className="lf">
        <div className="k">Down payment</div>
        <div className="v">{fmt.usd(result.down)} · {Math.round(result.downPct * 100)}%</div>
      </div>
      <div className="lf">
        <div className="k">Total interest</div>
        <div className="v">{fmt.usd(Math.round(totalInterest))}</div>
      </div>
      <div className="lf">
        <div className="k">Payoff</div>
        <div className="v">{payoff.toLocaleDateString("en-US", { month: "short", year: "numeric" })}</div>
      </div>
    </div>
  );
}

// ---------- Amortization (chart + schedule) ----------
function AmortizationSection({ result }) {
  const [tab, setTab] = useS_m("chart");
  const sched = useM_m(
    () => amortSchedule(result.loan, result.monthlyRate, result.n, result.pi),
    [result.loan, result.monthlyRate, result.n, result.pi]
  );

  return (
    <div className="card m-amort">
      <div className="card-header">
        <div className="card-title">Amortization</div>
        <div className="tabs">
          <div className={`tab ${tab === "chart" ? "active" : ""}`} onClick={() => setTab("chart")}>Balance over time</div>
          <div className={`tab ${tab === "table" ? "active" : ""}`} onClick={() => setTab("table")}>Yearly schedule</div>
        </div>
      </div>
      {tab === "chart"
        ? <AmortChart sched={sched} result={result} />
        : <AmortTable sched={sched} />}
    </div>
  );
}

function AmortChart({ sched, result }) {
  const W = 760, H = 220, padL = 8, padR = 8, padT = 14, padB = 22;
  if (!sched.length || result.loan <= 0) {
    return <div className="empty" style={{ padding: "40px 16px" }}>No loan to amortize — your down payment covers the full price.</div>;
  }
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxBal = result.loan;
  const pts = [{ year: 0, balance: result.loan, principalPaid: 0 }, ...sched];
  const N = pts.length - 1;
  const x = (i) => padL + (i / N) * innerW;
  const y = (v) => padT + (1 - v / maxBal) * innerH;

  // remaining-balance line
  const balLine = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.balance).toFixed(1)}`).join(" ");
  // balance area (down to baseline) = remaining principal
  const balArea = `${balLine} L${x(N).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;

  // gridlines at 0/25/50/75/100%
  const grids = [0, 0.25, 0.5, 0.75, 1];
  // x ticks ~ every 5 years
  const stepYears = result.term <= 10 ? 2 : 5;
  const xticks = [];
  for (let yr = 0; yr <= result.term; yr += stepYears) xticks.push(yr);
  if (xticks[xticks.length - 1] !== result.term) xticks.push(result.term);

  return (
    <>
      <div className="m-chart-wrap">
        <svg className="m-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {grids.map((g) => (
            <line key={g} className="grid-line"
                  x1={padL} x2={W - padR}
                  y1={padT + g * innerH} y2={padT + g * innerH} />
          ))}
          <path className="principal-area" d={balArea} />
          <path className="bal-line" d={balLine} />
          {xticks.map((yr) => (
            <text key={yr} className="axis-label"
                  x={x((yr / result.term) * N)} y={H - 6}
                  textAnchor={yr === 0 ? "start" : yr === result.term ? "end" : "middle"}>
              {yr === 0 ? "Now" : `Yr ${yr}`}
            </text>
          ))}
          {grids.map((g) => (
            <text key={"y" + g} className="axis-label" x={W - padR} y={padT + g * innerH - 3}
                  textAnchor="end">
              {fmt.usd(Math.round(maxBal * (1 - g)), { compact: true })}
            </text>
          ))}
        </svg>
      </div>
      <div className="m-chart-legend">
        <span className="item"><span className="sw" style={{ background: "color-mix(in oklab, var(--m-pi) 16%, transparent)" }} /> Remaining balance</span>
        <span className="item"><span className="sw" style={{ background: "var(--accent)", height: 2, borderRadius: 1 }} /> Balance curve</span>
      </div>
      <div className="m-chart-hint">
        Over {result.term} years you'll pay {fmt.usd(Math.round(sched[sched.length - 1].cumInterest))} in
        interest on a {fmt.usd(result.loan)} loan.
      </div>
    </>
  );
}

function AmortTable({ sched }) {
  if (!sched.length) {
    return <div className="empty" style={{ padding: "40px 16px" }}>No loan to amortize.</div>;
  }
  return (
    <div className="m-sched-wrap">
      <table className="m-sched">
        <thead>
          <tr>
            <th>Year</th>
            <th>Principal</th>
            <th>Interest</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {sched.map((r) => (
            <tr key={r.year}>
              <td>{r.year}</td>
              <td className="prin">{fmt.usd(Math.round(r.principalPaid))}</td>
              <td className="int">{fmt.usd(Math.round(r.interestPaid))}</td>
              <td className="bal">{fmt.usd(Math.round(r.balance))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
//  Page
// ============================================================
const M_DEFAULTS = {
  price: 450000,
  downPct: 0.20,
  rate: suggestedRate(30, "740+"),
  term: 30,
  creditBand: "740+",
  taxAnnual: null,   // null = auto-estimate from price
  insAnnual: null,
  pmiAnnual: null,
  hoaMonthly: 0,
};

// Derive a sensible starting price from a tracked property. The live property
// row carries its current AVM/price fields flat (no snapshots): prefer the
// asking price when actively listed, else the best estimate, else last sold.
function prefillFromProperty(p) {
  const state = p.listing_state;
  let price = null, src = "estimate";
  if ((state === "for_sale" || state === "pending") && p.list_price != null) {
    price = p.list_price; src = "asking";
  } else if (p.best_current_estimate != null) {
    price = p.best_current_estimate; src = "estimate";
  } else if (p.last_sold_price != null) {
    price = p.last_sold_price; src = "last sold";
  }
  return { price: price ? Math.round(price / 1000) * 1000 : null, src };
}

// ---------- Small inputs ----------
function CurrencyInput({ value, onChange, placeholder }) {
  return (
    <input
      inputMode="numeric"
      value={value ? value.toLocaleString("en-US") : ""}
      placeholder={placeholder}
      onChange={(e) => {
        const n = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10);
        onChange(isNaN(n) ? 0 : n);
      }}
    />
  );
}

// ---------- The form ----------
function MortgageForm({ inp, set, result }) {
  const [advOpen, setAdvOpen] = useS_m(false);
  const sugg = suggestedRate(inp.term, inp.creditBand);
  const rateOff = Math.abs(inp.rate - sugg) > 0.001;

  const monthly = (key) => fmt.usd(Math.round(result.parts[key]));

  function setTerm(t) {
    set((s) => ({ ...s, term: t, ...(s.rateAuto ? { rate: suggestedRate(t, s.creditBand) } : {}) }));
  }
  function setCredit(v) {
    set((s) => ({ ...s, creditBand: v, ...(s.rateAuto ? { rate: suggestedRate(s.term, v) } : {}) }));
  }

  return (
    <div className="card m-form">
      <div className="card-header">
        <div className="card-title">Loan details</div>
        <span className="badge neutral">Estimate</span>
      </div>
      <div className="card-body">
        {/* Home price */}
        <div className="m-field">
          <div className="m-field-head">
            <span className="m-field-label">Home price</span>
            <span className="m-field-sub">{fmt.usd(inp.price)}</span>
          </div>
          <div className="m-num">
            <span className="pre">$</span>
            <CurrencyInput value={inp.price} onChange={(v) => set((s) => ({ ...s, price: v }))} placeholder="450,000" />
          </div>
          <div className="m-slider">
            <input type="range" min="100000" max="2000000" step="5000"
                   value={Math.min(2000000, inp.price)}
                   onChange={(e) => set((s) => ({ ...s, price: +e.target.value }))} />
          </div>
          <div className="m-slider-ticks"><span>$100K</span><span>$2M</span></div>
        </div>

        {/* Down payment */}
        <div className="m-field">
          <div className="m-field-head">
            <span className="m-field-label">Down payment</span>
            <span className="m-field-sub">Loan {fmt.usd(result.loan)}</span>
          </div>
          <div className="m-dual">
            <div className="m-num sm">
              <span className="pre">$</span>
              <CurrencyInput
                value={result.down}
                onChange={(v) => set((s) => ({ ...s, downPct: s.price > 0 ? Math.min(1, v / s.price) : 0 }))}
              />
            </div>
            <div className="m-num sm">
              <input
                inputMode="decimal"
                value={Math.round(inp.downPct * 1000) / 10}
                onChange={(e) => {
                  const n = parseFloat(e.target.value.replace(/[^0-9.]/g, ""));
                  set((s) => ({ ...s, downPct: isNaN(n) ? 0 : Math.min(1, Math.max(0, n / 100)) }));
                }}
              />
              <span className="post">%</span>
            </div>
          </div>
          <div className="m-slider">
            <input type="range" min="0" max="50" step="1"
                   value={Math.round(inp.downPct * 100)}
                   onChange={(e) => set((s) => ({ ...s, downPct: +e.target.value / 100 }))} />
          </div>
          <div className="m-slider-ticks"><span>0%</span><span>20%</span><span>50%</span></div>
          {result.downPct < 0.2 && result.loan > 0 && (
            <div className="m-pmi-note">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
              <span>Under 20% down adds <strong>{monthly("pmi")}/mo</strong> in private mortgage insurance until you reach 20% equity.</span>
            </div>
          )}
        </div>

        {/* Loan term */}
        <div className="m-field">
          <div className="m-field-head">
            <span className="m-field-label">Loan term</span>
          </div>
          <div className="m-term">
            {[30, 20, 15, 10].map((t) => (
              <button key={t} className={inp.term === t ? "on" : ""} onClick={() => setTerm(t)}>
                {t}<span className="yr">yr</span>
              </button>
            ))}
          </div>
        </div>

        {/* Interest rate */}
        <div className="m-field">
          <div className="m-field-head">
            <span className="m-field-label">Interest rate</span>
            <span className="m-field-sub">{inp.term}-year fixed</span>
          </div>
          <div className="m-num">
            <input
              inputMode="decimal"
              value={inp.rate}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, "");
                const n = parseFloat(raw);
                set((s) => ({ ...s, rate: isNaN(n) ? 0 : n, rateAuto: false }));
              }}
            />
            <span className="post">%</span>
          </div>
          <div className="m-slider">
            <input type="range" min="2" max="9" step="0.05"
                   value={Math.min(9, Math.max(2, inp.rate))}
                   onChange={(e) => set((s) => ({ ...s, rate: +e.target.value, rateAuto: false }))} />
          </div>
          <div className="m-rate-note">
            <span>Suggested for {inp.creditBand} credit · {inp.term}-yr: <strong>{sugg}%</strong></span>
            {rateOff && (
              <span className="link" onClick={() => set((s) => ({ ...s, rate: sugg, rateAuto: true }))}>Use {sugg}%</span>
            )}
          </div>
        </div>

        {/* Advanced */}
        <button className={`m-adv-toggle ${advOpen ? "open" : ""}`} onClick={() => setAdvOpen((v) => !v)}>
          Taxes, insurance &amp; fees
          <Icon name="chevronDown" size={14} className="chev" />
        </button>
        {advOpen && (
          <div className="m-adv">
            <div className="m-field">
              <div className="m-field-head">
                <span className="m-field-label">Credit score</span>
              </div>
              <div className="field has-select">
                <select value={inp.creditBand} onChange={(e) => setCredit(e.target.value)}>
                  {CREDIT_BANDS.map((b) => <option key={b.v} value={b.v}>{b.label}</option>)}
                </select>
              </div>
            </div>
            <div className="m-adv-grid">
              <div className="m-field">
                <div className="m-field-head">
                  <span className="m-field-label">Property tax</span>
                  <span className="m-field-sub">
                    {!result.taxAuto && <button type="button" className="m-auto-reset" title="Reset to estimate" onClick={() => set((s) => ({ ...s, taxAnnual: null }))}>auto</button>}
                    {monthly("tax")}/mo
                  </span>
                </div>
                <div className="m-num sm">
                  <span className="pre">$</span>
                  <CurrencyInput value={Math.round(result.taxAnnual)} onChange={(v) => set((s) => ({ ...s, taxAnnual: v }))} />
                  <span className="post">/ yr</span>
                </div>
              </div>
              <div className="m-field">
                <div className="m-field-head">
                  <span className="m-field-label">Home insurance</span>
                  <span className="m-field-sub">
                    {!result.insAuto && <button type="button" className="m-auto-reset" title="Reset to estimate" onClick={() => set((s) => ({ ...s, insAnnual: null }))}>auto</button>}
                    {monthly("ins")}/mo
                  </span>
                </div>
                <div className="m-num sm">
                  <span className="pre">$</span>
                  <CurrencyInput value={Math.round(result.insAnnual)} onChange={(v) => set((s) => ({ ...s, insAnnual: v }))} />
                  <span className="post">/ yr</span>
                </div>
              </div>
              <div className="m-field">
                <div className="m-field-head">
                  <span className="m-field-label">PMI</span>
                  <span className="m-field-sub">
                    {!result.pmiAuto && <button type="button" className="m-auto-reset" title="Reset to estimate" onClick={() => set((s) => ({ ...s, pmiAnnual: null }))}>auto</button>}
                    {result.pmiActive ? monthly("pmi") + "/mo" : "n/a · 20%+"}
                  </span>
                </div>
                <div className="m-num sm">
                  <span className="pre">$</span>
                  <CurrencyInput value={Math.round(result.pmiAnnual)} onChange={(v) => set((s) => ({ ...s, pmiAnnual: v }))} />
                  <span className="post">/ yr</span>
                </div>
              </div>
              <div className="m-field">
                <div className="m-field-head">
                  <span className="m-field-label">HOA dues</span>
                  <span className="m-field-sub">{fmt.usd(Math.round(inp.hoaMonthly || 0))}/mo</span>
                </div>
                <div className="m-num sm">
                  <span className="pre">$</span>
                  <CurrencyInput value={inp.hoaMonthly} onChange={(v) => set((s) => ({ ...s, hoaMonthly: v }))} />
                  <span className="post">/ mo</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Property picker ----------
function PropertyPicker({ properties, loaded, onLoad, onClear }) {
  const [open, setOpen] = useS_m(false);
  const [q, setQ] = useS_m("");
  const ref = useR_m(null);

  useE_m(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const list = useM_m(() => {
    const active = properties.filter((p) => p.active !== false);
    const needle = q.trim().toLowerCase();
    return active
      .map((p) => ({ p, sp: splitAddress(displayAddress(p)), pre: prefillFromProperty(p) }))
      .filter((o) => o.pre.price != null)
      .filter((o) => !needle || o.sp.line1.toLowerCase().includes(needle) ||
                     displayName(o.p).toLowerCase().includes(needle) ||
                     (o.p.city || "").toLowerCase().includes(needle));
  }, [properties, q]);

  if (loaded) {
    return (
      <div className="m-loaded-pill">
        <Icon name="home" size={13} />
        <span className="addr">{loaded.line1}</span>
        <span style={{ opacity: 0.7 }}>· loaded</span>
        <button className="x" title="Clear" onClick={onClear}><Icon name="x" size={11} /></button>
      </div>
    );
  }

  return (
    <div className="m-picker" ref={ref}>
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        <Icon name="home" size={13} /> Load from a property
        <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div className="m-picker-pop">
          <div className="m-picker-search">
            <Icon name="search" size={13} />
            <input autoFocus placeholder="Search tracked properties…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {list.length === 0 && <div className="m-picker-empty">No matching properties with a price.</div>}
          {list.map(({ p, sp, pre }) => {
            const nm = displayName(p);
            return (
              <button key={p.id} className="m-picker-opt" onClick={() => { onLoad(p, sp, pre); setOpen(false); setQ(""); }}>
                <div className="info">
                  <div className="a1">{nm || sp.line1}</div>
                  <div className="a2">{nm ? sp.line1 + " · " : ""}{sp.line2}</div>
                </div>
                <div className="price">
                  <div className="pv">{fmt.usd(pre.price, { compact: true })}</div>
                  <div className="pl">{pre.src}</div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- Summary card ----------
function SummaryCard({ result }) {
  return (
    <div className="card m-summary">
      <div className="m-total">
        <div className="cap">Estimated monthly payment</div>
        <div className="amt">{fmt.usd(Math.round(result.total))}<span className="per"> /mo</span></div>
        <div className="meta">Based on national-average assumptions · {result.term}-yr fixed</div>
      </div>
      <div className="m-donut-row">
        <PaymentDonut result={result} size={132} stroke={14} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <BreakdownList result={result} includeTotal={false} />
        </div>
      </div>
      <LoanFacts result={result} />
    </div>
  );
}

// ============================================================
//  Mortgage page — two-pane (Bankrate-style) layout
// ============================================================
function MortgagePage({ properties, navigate }) {
  const [inp, set] = useS_m(() => ({ ...M_DEFAULTS, rateAuto: true }));
  const [loaded, setLoaded] = useS_m(null); // splitAddress of the loaded property

  const result = useM_m(() => computeMortgage(inp), [inp]);

  function loadProperty(p, sp, pre) {
    setLoaded(sp);
    set((s) => ({ ...s, price: pre.price }));
  }

  return (
    <div className="mortgage">
      <div className="page-header">
        <div>
          <h1 className="page-title">Mortgage calculator</h1>
          <div className="page-subtitle">
            Estimate the monthly cost of buying a home — principal, interest, taxes, insurance, and fees.
          </div>
        </div>
        <div className="m-picker-bar">
          <PropertyPicker
            properties={properties}
            loaded={loaded}
            onLoad={loadProperty}
            onClear={() => setLoaded(null)}
          />
        </div>
      </div>

      <div className="m-split">
        <div><MortgageForm inp={inp} set={set} result={result} /></div>
        <div className="m-summary-col"><SummaryCard result={result} /></div>
      </div>
      <div style={{ marginTop: 16 }}>
        <AmortizationSection result={result} />
      </div>
    </div>
  );
}

window.MortgagePage = MortgagePage;
