/* Add to HomeIndexr — popup logic.
 *
 * A faithful, working build of the "Add to HomeIndexr" prototype (Option A,
 * the toolbar popup) wired to the real HomeIndexr backend:
 *   - GET  /api/properties              reachability + already-tracking check
 *   - POST /api/properties {address}    add (with confirm_mismatch retry)
 *   - GET  /api/properties/{id}         historical estimates for the tracking card
 *   - POST /api/properties/{id}/refresh refresh an already-tracked home
 *
 * The address is scraped from the active Zillow/Realtor.com tab and sent to the
 * backend, which re-matches it against Realtor.com (per the app's architecture:
 * all scraping is server-side). No framework, no remote code — MV3-clean.
 */

const DEFAULT_SERVER = "http://127.0.0.1:5173";

// ---------- tiny helpers ----------
function norm(a) { return (a || "").replace(/\s+/g, " ").trim().toLowerCase(); }

const fmt = {
  usd(n, opts = {}) {
    if (n == null) return "—";
    if (opts.compact) {
      if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2).replace(/\.0+$/, "") + "M";
      if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1000) + "K";
    }
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  },
  num(n) { return n == null ? "—" : n.toLocaleString("en-US"); },
  baths(n) { return n == null ? "—" : (n % 1 === 0 ? String(n) : n.toFixed(1)); },
  date(ts) { return ts == null ? "—" : new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); },
  signedUsd(n) {
    if (n == null) return "—";
    const s = n > 0 ? "+" : (n < 0 ? "−" : "");
    return s + "$" + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  },
  pct(n) {
    if (n == null) return "—";
    const s = n > 0 ? "+" : (n < 0 ? "−" : "");
    return s + Math.abs(n * 100).toFixed(1) + "%";
  },
};

function splitAddress(addr) {
  const m = (addr || "").match(/^(.+?),\s*(.+?),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)$/);
  if (!m) return { line1: addr || "—", line2: "" };
  return { line1: m[1], line2: `${m[2]}, ${m[3]} ${m[4]}` };
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- icons (Lucide-style, from the design's components.jsx) ----------
const ICON_PATHS = {
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  check: '<path d="M5 12l5 5 9-12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4v4.5H8.5"/><path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
  arrowUpRight: '<path d="M7 17L17 7"/><path d="M8 7h9v9"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
function icon(name, size = 14) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ""}</svg>`;
}
function hiLogo(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="30 22 200 178" fill="none" aria-hidden="true">
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M41 188 V93 L128 29 L215 93 V143" stroke="currentColor" stroke-width="15"/>
      <path d="M42 188 H89 L121 154 L160 171 L215 103" stroke="#2F74FF" stroke-width="15"/>
      <circle cx="215" cy="103" r="14" fill="#2F74FF"/>
    </g>
  </svg>`;
}
function sparkline(values, width = 120, height = 22) {
  const v = (values || []).filter((x) => x != null);
  if (v.length < 2) return "";
  const min = Math.min(...v), max = Math.max(...v), range = (max - min) || 1;
  const step = width / (v.length - 1);
  const d = v.map((y, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${(height - ((y - min) / range) * (height - 2) - 1).toFixed(1)}`).join(" ");
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.25"/></svg>`;
}

// ---------- server config ----------
async function getServer() {
  const { serverUrl } = await chrome.storage.sync.get("serverUrl");
  return String(serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}
async function setServer(url) {
  await chrome.storage.sync.set({ serverUrl: String(url).replace(/\/+$/, "") });
}
function hostLabel(url) {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, ""); }
}

// ---------- API ----------
async function apiGet(path) {
  const r = await fetch((await getServer()) + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch((await getServer()) + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// ---------- page extraction (runs in the listing tab) ----------
// Self-contained: injected via chrome.scripting.executeScript({ func }).
function extractListing() {
  const ADDR_RE = /\d+[^,\n]{0,60}?,\s*[A-Za-z .'-]{2,40},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?/;
  const out = { site: "other", address: null, price: null, beds: null, baths: null, sqft: null, url: location.href };

  const host = location.hostname.replace(/^www\./, "");
  if (host.includes("zillow.")) out.site = "zillow";
  else if (host.includes("realtor.")) out.site = "realtor";

  const toNum = (x) => {
    if (x == null) return null;
    const n = Number(String(x).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // 1) JSON-LD structured data (most reliable when present)
  try {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data; try { data = JSON.parse(s.textContent); } catch { continue; }
      const queue = Array.isArray(data) ? [...data] : [data];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node["@graph"])) queue.push(...node["@graph"]);
        const a = node.address;
        if (a && typeof a === "object" && !out.address) {
          const street = a.streetAddress, city = a.addressLocality, region = a.addressRegion, zip = a.postalCode;
          if (street && city && region) out.address = `${street}, ${city}, ${region}${zip ? " " + zip : ""}`;
        }
        if (!out.price && node.offers && node.offers.price) out.price = toNum(node.offers.price);
        if (!out.price && node.price) out.price = toNum(node.price);
        if (!out.sqft && node.floorSize && node.floorSize.value) out.sqft = toNum(node.floorSize.value);
        if (!out.beds && node.numberOfBedrooms != null) out.beds = toNum(node.numberOfBedrooms);
        if (!out.baths && node.numberOfBathroomsTotal != null) out.baths = toNum(node.numberOfBathroomsTotal);
      }
    }
  } catch { /* ignore */ }

  // 2) regex over the most address-bearing text nodes
  if (!out.address) {
    const candidates = [];
    const og = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]');
    if (og) candidates.push(og.content);
    candidates.push(document.title);
    const h1 = document.querySelector("h1");
    if (h1) candidates.push(h1.textContent);
    const desc = document.querySelector('meta[name="description"]');
    if (desc) candidates.push(desc.content);
    for (const text of candidates) {
      const m = (text || "").match(ADDR_RE);
      if (m) { out.address = m[0].replace(/\s+/g, " ").trim(); break; }
    }
  }

  // 3) Realtor.com URL slug fallback: /…detail/4901-Bouldin-Ave_Austin_TX_78704[_M…]
  // Locate the "ST_ZIP" pair rather than assume position — a trailing
  // "_M12345-67890" listing id often follows the zip.
  if (!out.address && out.site === "realtor") {
    const m = location.pathname.match(/detail\/([^/]+)/);
    if (m) {
      const parts = m[1].split("_");
      for (let i = 1; i < parts.length - 1; i++) {
        if (/^[A-Z]{2}$/.test(parts[i]) && /^\d{5}$/.test(parts[i + 1])) {
          const city = (parts[i - 1] || "").replace(/-/g, " ");
          const street = parts.slice(0, i - 1).join(" ").replace(/-/g, " ");
          if (street && city) out.address = `${street}, ${city}, ${parts[i]} ${parts[i + 1]}`;
          break;
        }
      }
    }
  }

  return out;
}

async function detectListing() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const base = { site: "other", address: null, tab };
  if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) return base;
  const host = (() => { try { return new URL(tab.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  if (!/zillow\.|realtor\./.test(host)) return base;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractListing });
    return { ...base, ...(res && res.result ? res.result : {}) };
  } catch {
    // No host access (e.g. user must click the icon) — still mark as a listing host.
    return { ...base, site: host.includes("zillow.") ? "zillow" : "realtor" };
  }
}

// ---------- shared UI pieces ----------
const SITE_META = {
  zillow: { name: "Zillow", badge: "info" },
  realtor: { name: "realtor.com", badge: "err" },
};
let SERVER_HOST = hostLabel(DEFAULT_SERVER);

function connPill(state) {
  if (state === "off") return `<span class="conn off"><span class="dot"></span>Offline</span>`;
  if (state === "busy") return `<span class="conn busy"><span class="dot"></span>Saving…</span>`;
  return `<span class="conn"><span class="dot"></span>Connected <span class="host">${esc(SERVER_HOST)}</span></span>`;
}
function head(connState) {
  return `<div class="hip-head">
    <span class="hi-mark">${hiLogo(16)}</span>
    <div class="hip-name">HomeIndexr<span class="sub">Track this home's price</span></div>
    ${connPill(connState)}
  </div>`;
}
function matchPreview(listing, { estimate, estLow, estHigh, estSource } = {}) {
  const site = SITE_META[listing.site] || { name: "Listing", badge: "info" };
  const { line1, line2 } = splitAddress(listing.address);
  const specs = [];
  if (listing.beds != null) specs.push(`<span><b>${esc(listing.beds)}</b> bd</span>`);
  if (listing.baths != null) specs.push(`<span><b>${esc(fmt.baths(listing.baths))}</b> ba</span>`);
  if (listing.sqft != null) specs.push(`<span><b>${esc(fmt.num(listing.sqft))}</b> sqft</span>`);
  const specsRow = specs.length ? `<div class="specs">${specs.join("<i>·</i>")}</div>` : "";
  const priceStr = listing.price != null ? fmt.usd(listing.price) : "";
  const estStr = estimate != null
    ? `est. <b>${fmt.usd(estimate)}</b>${estLow != null && estHigh != null ? `<br>${fmt.usd(estLow, { compact: true })}–${fmt.usd(estHigh, { compact: true })}${estSource ? " · " + esc(estSource) : ""}` : ""}`
    : "";
  const foot = (priceStr || estStr)
    ? `<div class="match-foot"><span class="price">${priceStr}</span><span class="est">${estStr}</span></div>`
    : "";
  return `<div>
    <div class="hip-label">${icon("check", 12)} Listing detected<span class="badge ${site.badge} src" style="font-size:10px">${esc(site.name)}</span></div>
    <div class="match">
      <div class="ph thumb"></div>
      <div class="info">
        <div class="addr">${esc(line1)}</div>
        <div class="csub">${esc(line2)}</div>
        ${specsRow}
        ${foot}
      </div>
    </div>
  </div>`;
}

// ---------- render ----------
const root = document.getElementById("root");
function paint(html) { root.innerHTML = html; }
function $(sel) { return root.querySelector(sel); }
function openOptions() { chrome.runtime.openOptionsPage(); }

let LISTING = null;

function renderNotListing() {
  paint(`${head("ok")}
    <div class="hip-body">
      <div class="hip-result" style="padding:8px 0 6px">
        <div class="ring warn">${icon("home", 24)}</div>
        <h4>No listing on this page</h4>
        <p>Open a property page on <b>Zillow</b> or <b>realtor.com</b>, then click the HomeIndexr icon to track it.</p>
      </div>
    </div>
    <div class="hip-foot"><div class="hip-meta">Connected to <span class="confirm-code">${esc(SERVER_HOST)}</span></div></div>`);
}

function renderReady() {
  paint(`${head("ok")}
    <div class="hip-body">${matchPreview(LISTING)}</div>
    <div class="hip-foot">
      <button class="btn btn-primary btn-block" id="add">${icon("plus", 14)} Add to HomeIndexr</button>
      <div class="hip-meta">Saves to your instance · a first snapshot is captured now</div>
    </div>`);
  $("#add").onclick = () => doAdd(LISTING.address, false);
}

function renderSaving() {
  paint(`${head("busy")}
    <div class="hip-body" style="opacity:.55;pointer-events:none">${matchPreview(LISTING)}</div>
    <div class="hip-foot">
      <button class="btn btn-primary btn-block"><span class="hip-spin"></span> Adding…</button>
      <div class="hip-meta">Matching listing · capturing first snapshot</div>
    </div>`);
}

function renderSuccess(property) {
  paint(`${head("ok")}
    <div class="hip-result">
      <div class="ring ok">${icon("check", 26)}</div>
      <h4>Added to HomeIndexr</h4>
      <p>First snapshot captured. Open its page to watch the price from here.</p>
    </div>
    <div class="hip-foot">
      <button class="btn btn-primary btn-block" id="view">${icon("arrowUpRight", 14)} View property</button>
      <button class="btn btn-ghost btn-block" id="done">Done</button>
    </div>`);
  $("#view").onclick = async () => {
    const base = await getServer();
    chrome.tabs.create({ url: `${base}/#property/${property.id}` });
    window.close();
  };
  $("#done").onclick = () => window.close();
}

async function renderTracking(property) {
  const site = SITE_META[LISTING && LISTING.site] || null;
  const { line1, line2 } = splitAddress(property.canonical_address || property.input_address || "");
  // shell first; fill the series-derived stats once history loads
  paint(`${head("ok")}
    <div class="hip-body">
      <div class="hip-label" style="margin-bottom:0">${icon("activity", 12)} Already tracking this home</div>
      <div class="hip-tracking">
        <div class="tr-head">
          <div class="ph thumb" style="width:54px;height:54px;border-radius:8px"></div>
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;font-size:13px">${esc(line1)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${esc(line2)}</div>
            <div id="spark"></div>
          </div>
        </div>
        <div class="tr-stat"><span class="k">Latest estimate</span><span class="v">${fmt.usd(property.best_current_estimate)}</span></div>
        <div class="tr-stat" id="delta-row" style="border-top:1px solid var(--border)"><span class="k">Since first snapshot</span><span class="v">—</span></div>
        <div class="tr-stat" id="since-row" style="border-top:1px solid var(--border)"><span class="k">Tracking since</span><span class="v" style="font-weight:500">${esc(fmt.date(property.created_at))}</span></div>
      </div>
    </div>
    <div class="hip-foot">
      <button class="btn btn-primary btn-block" id="view">${icon("arrowUpRight", 14)} View property</button>
      <button class="btn btn-ghost btn-block" id="refresh">${icon("refresh", 13)} Refresh now</button>
    </div>`);

  $("#view").onclick = async () => {
    const base = await getServer();
    chrome.tabs.create({ url: `${base}/#property/${property.id}` });
    window.close();
  };
  $("#refresh").onclick = async () => {
    const btn = $("#refresh");
    btn.disabled = true; btn.innerHTML = `<span class="hip-spin" style="border-top-color:var(--accent)"></span> Refreshing…`;
    try {
      const updated = await apiPost(`/api/properties/${property.id}/refresh`, {});
      renderTracking(updated);
    } catch { renderOffline(); }
  };

  // enrich with history
  try {
    const full = await apiGet(`/api/properties/${property.id}`);
    const hist = (full.historical || []).filter((h) => h.estimate != null);
    const series = hist.map((h) => h.estimate);
    const latest = full.best_current_estimate != null ? full.best_current_estimate : series[series.length - 1];
    if (series.length) series.push(latest);
    const sp = $("#spark"); if (sp) sp.innerHTML = sparkline(series);
    if (hist.length) {
      const first = hist[0].estimate;
      if (first && latest != null) {
        const delta = latest - first, pct = delta / first;
        const cls = delta > 0 ? "pos" : (delta < 0 ? "neg" : "");
        const row = $("#delta-row");
        if (row) row.querySelector(".v").outerHTML = `<span class="v ${cls}">${fmt.signedUsd(delta)} (${fmt.pct(pct)})</span>`;
      }
      const since = $("#since-row");
      if (since) since.querySelector(".v").textContent = `${fmt.date(full.created_at)} · ${hist.length} snapshot${hist.length === 1 ? "" : "s"}`;
    }
  } catch { /* leave the shell stats as-is */ }
}

function renderMismatch(candidate) {
  const original = (candidate && candidate.input_address) || (LISTING && LISTING.address) || "";
  const matched = candidate && candidate.matched_address;
  const est = candidate && candidate.best_current_estimate;
  paint(`${head("ok")}
    <div class="hip-body">
      <div class="hip-result" style="padding:8px 0 4px">
        <div class="ring warn">${icon("search", 24)}</div>
        <h4>Couldn't match automatically</h4>
        <p>HomeIndexr resolved this to a different record. Confirm to track it as-is, or edit the address to try again.</p>
      </div>
      ${matched ? `<div class="hip-meta" style="text-align:left">Matched on Realtor.com · <b style="color:var(--text)">${esc(matched)}</b>${est != null ? ` · est. <b style="color:var(--text)">${fmt.usd(est)}</b>` : ""}</div>` : ""}
      <div>
        <label class="hip-fieldlbl">Address</label>
        <input class="hip-input" id="addr" value="${esc(original)}" />
      </div>
    </div>
    <div class="hip-foot">
      <button class="btn btn-primary btn-block" id="confirm">${icon("check", 14)} Match &amp; add</button>
      <div class="hip-meta">HomeIndexr re-matches it against Realtor.com listings</div>
    </div>`);
  // Unedited → accept the candidate (confirm_mismatch). Edited → fresh attempt.
  $("#confirm").onclick = () => {
    const edited = $("#addr").value.trim();
    doAdd(edited, norm(edited) === norm(original));
  };
}

function renderNomatch() {
  paint(`${head("ok")}
    <div class="hip-body">
      <div class="hip-result" style="padding:8px 0 4px">
        <div class="ring warn">${icon("search", 24)}</div>
        <h4>No match found</h4>
        <p>HomeIndexr couldn't find this address on Realtor.com. Edit it and try again.</p>
      </div>
      <div>
        <label class="hip-fieldlbl">Address</label>
        <input class="hip-input" id="addr" value="${esc((LISTING && LISTING.address) || "")}" />
      </div>
    </div>
    <div class="hip-foot">
      <button class="btn btn-primary btn-block" id="retry">${icon("refresh", 13)} Try again</button>
      <div class="hip-meta">HomeIndexr re-matches it against Realtor.com listings</div>
    </div>`);
  $("#retry").onclick = () => doAdd($("#addr").value.trim(), false);
}

function renderError(message) {
  paint(`${head("ok")}
    <div class="hip-body">
      <div class="hip-result" style="padding:8px 0 4px">
        <div class="ring off">${icon("alert", 24)}</div>
        <h4>Couldn't add this home</h4>
        <p>${esc(message || "The fetch failed upstream. Try again in a moment.")}</p>
      </div>
    </div>
    <div class="hip-foot">
      <button class="btn btn-primary btn-block" id="retry">${icon("refresh", 13)} Try again</button>
    </div>`);
  $("#retry").onclick = () => doAdd((LISTING && LISTING.address), false);
}

async function renderOffline() {
  const base = await getServer();
  paint(`${head("off")}
    <div class="hip-body">
      <div class="hip-result" style="padding:8px 0 6px">
        <div class="ring off">${icon("cpu", 24)}</div>
        <h4>HomeIndexr isn't reachable</h4>
        <p>Nothing is listening at <span class="confirm-code">${esc(hostLabel(base))}</span>. Start your local server, or point the extension at a different address.</p>
      </div>
      <div>
        <label class="hip-fieldlbl">Server URL</label>
        <input class="hip-input" id="server" value="${esc(base)}" />
      </div>
    </div>
    <div class="hip-foot">
      <button class="btn btn-primary btn-block" id="reconnect">${icon("refresh", 13)} Reconnect</button>
      <button class="btn btn-ghost btn-block" id="opts">${icon("settings", 13)} Extension options</button>
      <div class="hip-meta">Run <span class="confirm-code">./run.sh</span> to start it locally</div>
    </div>`);
  $("#reconnect").onclick = async () => {
    const url = $("#server").value.trim();
    if (url) { await setServer(url); SERVER_HOST = hostLabel(url); }
    boot();
  };
  $("#opts").onclick = openOptions;
}

// ---------- add flow ----------
async function doAdd(address, confirmMismatch) {
  if (!address) { renderNomatch(); return; }
  renderSaving();
  let res;
  try {
    res = await apiPost("/api/properties", { address, confirm_mismatch: !!confirmMismatch });
  } catch {
    renderOffline();
    return;
  }
  // A populated property means it was saved (matched, or a confirmed mismatch).
  if (res.property) { renderSuccess(res.property); return; }
  if (res.status === "candidate_mismatch") { renderMismatch(res.candidate); return; }
  if (res.status === "no_candidates") { renderNomatch(); return; }
  renderError(res.error);
}

// ---------- boot ----------
async function boot() {
  paint(`${head("ok")}<div class="hip-result" style="padding:34px 20px"><div class="hip-spin" style="border-top-color:var(--accent);width:22px;height:22px"></div></div>`);
  SERVER_HOST = hostLabel(await getServer());

  LISTING = await detectListing();
  if (LISTING.site === "other") { renderNotListing(); return; }

  // GET /api/properties doubles as the reachability check + tracking lookup.
  let props;
  try {
    props = await apiGet("/api/properties");
  } catch {
    renderOffline();
    return;
  }

  const existing = LISTING.address
    ? props.find((p) => [p.canonical_address, p.input_address].some((c) => c && norm(c) === norm(LISTING.address)))
    : null;
  if (existing) { renderTracking(existing); return; }

  renderReady();
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.close(); });
boot();
