// HomeIndexr app shell

const { useState: useS, useEffect: useE, useMemo: useM, useCallback: useCB } = React;

function App() {
  const [route, setRoute] = useS({ page: "dashboard", arg: null });
  const [properties, setProperties] = useS([]);
  const [loading, setLoading] = useS(true);
  const [refreshingAll, setRefreshingAll] = useS(false);
  const [theme, setTheme] = useS(() => localStorage.getItem("hi_theme") || localStorage.getItem("ht_theme") || "light");
  const [sidebarOpen, setSidebarOpen] = useS(false);

  // Saved Browse searches — a named filter set, optionally alerting on new
  // matches. Local-first: persisted to localStorage and surfaced in the sidebar.
  const [savedSearches, setSavedSearches] = useS(() => {
    try { return JSON.parse(localStorage.getItem("hi_saved_searches") || "[]"); } catch (e) { return []; }
  });
  const [appliedSearch, setAppliedSearch] = useS(null);
  useE(() => {
    localStorage.setItem("hi_saved_searches", JSON.stringify(savedSearches.map(({ just, ...s }) => s)));
  }, [savedSearches]);

  useE(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("hi_theme", theme);
  }, [theme]);

  const reload = useCB(async () => {
    try {
      setLoading(true);
      const list = await API.listProperties();
      setProperties(list);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useE(() => { reload(); }, [reload]);

  // hash routing
  useE(() => {
    function apply() {
      const h = window.location.hash.replace(/^#/, "");
      const [page, arg] = h.split("/").filter(Boolean);
      if (page === "add") setRoute({ page: "add", arg: null });
      else if (page === "browse") setRoute({ page: "browse", arg: null });
      else if (page === "admin") setRoute({ page: "admin", arg: arg || null });
      else if (page === "property" && arg) setRoute({ page: "detail", arg: Number(arg) });
      else setRoute({ page: "dashboard", arg: null });
      setSidebarOpen(false);
    }
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  function navigate(page, arg) {
    let h = "";
    if (page === "dashboard") h = "";
    else if (page === "browse") h = "#browse";
    else if (page === "add") h = "#add";
    else if (page === "admin") h = arg ? `#admin/${arg}` : "#admin";
    else if (page === "detail") h = `#property/${arg}`;
    if (h !== window.location.hash) window.location.hash = h;
    else setRoute({ page, arg });
    setSidebarOpen(false);
  }

  function saveSearch({ name, filters }) {
    const id = `ss_${Date.now()}_${Math.round(Math.random() * 1e4)}`;
    setSavedSearches((list) => [{ id, name, filters, created_at: Date.now(), just: true }, ...list]);
    // Clear the just-saved highlight once its animation has run.
    setTimeout(() => setSavedSearches((l) => l.map((s) => (s.id === id ? { ...s, just: false } : s))), 2000);
  }
  function removeSearch(id) {
    setSavedSearches((l) => l.filter((s) => s.id !== id));
  }
  function applySearch(s) {
    setAppliedSearch({ id: s.id, filters: s.filters, nonce: Date.now() });
    navigate("browse");
  }

  async function handleRefreshAll() {
    setRefreshingAll(true);
    try {
      const result = await API.refreshAll();
      await reload();
      return result;
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      setRefreshingAll(false);
    }
  }

  const counts = useM(() => ({
    active: properties.filter((p) => p.active !== false).length,
    archived: properties.filter((p) => p.active === false).length,
  }), [properties]);

  const crumbs = useM(() => {
    if (route.page === "dashboard") return ["Properties"];
    if (route.page === "browse") return ["Browse"];
    if (route.page === "add") return ["Properties", "Add property"];
    if (route.page === "admin") return ["Admin"];
    if (route.page === "detail") {
      const p = properties.find((x) => x.id === route.arg);
      return ["Properties", p ? splitAddress(displayAddress(p)).line1 : "—"];
    }
    return [];
  }, [route, properties]);

  let pageEl = null;
  if (route.page === "dashboard") {
    pageEl = <DashboardPage
      properties={properties}
      loading={loading}
      navigate={navigate}
      onRefreshAll={handleRefreshAll}
      refreshingAll={refreshingAll}
      onChanged={reload}
    />;
  } else if (route.page === "browse") {
    pageEl = <BrowsePage navigate={navigate} onChanged={reload}
      onSaveSearch={saveSearch} applied={appliedSearch} />;
  } else if (route.page === "add") {
    pageEl = <AddPropertyPage navigate={navigate} onAdded={reload} />;
  } else if (route.page === "admin") {
    pageEl = <AdminPage
      properties={properties}
      loading={loading}
      navigate={navigate}
      initialSection={route.arg}
      onRefreshAll={handleRefreshAll}
      refreshingAll={refreshingAll}
    />;
  } else if (route.page === "detail") {
    pageEl = <PropertyDetailPage
      key={route.arg}
      propertyId={route.arg}
      navigate={navigate}
      onChanged={reload}
    />;
  }

  return (
    <ToastProvider>
      <div className={`app ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        <aside className="sidebar">
          <div className="sidebar-brand">
            <button className="brand-link" onClick={() => navigate("dashboard")} aria-label="Go to dashboard">
            <svg className="brand-icon" viewBox="0 0 256 256" role="img" aria-hidden="true">
              <defs>
                <linearGradient id="nav-blueLine" x1="48" y1="190" x2="220" y2="76" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#2563EB"/>
                  <stop offset="1" stopColor="#38A7FF"/>
                </linearGradient>
                <filter id="nav-softShadow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#0F172A" floodOpacity="0.12"/>
                </filter>
              </defs>
              <g fill="none" strokeLinecap="round" strokeLinejoin="round" filter="url(#nav-softShadow)">
                <path d="M41 188 V93 L128 29 L215 93 V143" stroke="currentColor" strokeWidth="15"/>
                <path d="M42 188 H89 L121 154 L160 171 L215 103" stroke="url(#nav-blueLine)" strokeWidth="15"/>
                <circle cx="215" cy="103" r="14" fill="#2F74FF" stroke="none"/>
              </g>
              <g fill="#6B7280" opacity="0.92">
                <rect x="107" y="83" width="16" height="16" rx="2"/>
                <rect x="133" y="83" width="16" height="16" rx="2"/>
                <rect x="107" y="109" width="16" height="16" rx="2"/>
                <rect x="133" y="109" width="16" height="16" rx="2"/>
              </g>
            </svg>
            <span className="brand-name"><span>Home</span><span className="brand-name-accent">Indexr</span></span>
            </button>
          </div>
          <div className="nav-group-label">Workspace</div>
          <div className={`nav-item ${route.page === "dashboard" || route.page === "detail" ? "active" : ""}`}
               onClick={() => navigate("dashboard")}>
            <Icon name="list" /> Properties
            <span className="count">{counts.active}</span>
          </div>
          <div className={`nav-item ${route.page === "browse" ? "active" : ""}`}
               onClick={() => navigate("browse")}>
            <Icon name="globe" /> Browse
            <span className="nav-new">New</span>
          </div>
          <div className={`nav-item ${route.page === "add" ? "active" : ""}`}
               onClick={() => navigate("add")}>
            <Icon name="plus" /> Add property
          </div>
          <div className={`nav-item ${route.page === "admin" ? "active" : ""}`}
               onClick={() => navigate("admin")}>
            <Icon name="settings" /> Admin
          </div>

          <div className="nav-group-label">Filters</div>
          <div className="nav-item" onClick={() => navigate("dashboard")}>
            <Icon name="eye" /> All properties
            {counts.archived > 0 && <span className="count">{counts.active + counts.archived}</span>}
          </div>

          {savedSearches.length > 0 && (
            <>
              <div className="nav-group-label">Saved searches</div>
              {savedSearches.map((s) => (
                <div key={s.id}
                     className={`nav-item saved-search ${route.page === "browse" && appliedSearch && appliedSearch.id === s.id ? "active" : ""} ${s.just ? "just" : ""}`}
                     onClick={() => applySearch(s)} title={s.name}>
                  <Icon name="bookmark" />
                  <span className="ss-nm">{s.name}</span>
                  <span className="ss-rm" title="Remove saved search"
                        onClick={(e) => { e.stopPropagation(); removeSearch(s.id); }}>
                    <Icon name="x" size={12} />
                  </span>
                </div>
              ))}
            </>
          )}


          <div className="sidebar-footer">
            <span className="dot" />
            HomeIndexr · local
          </div>
        </aside>

        <main className="main">
          <div className="topbar">
            <button className="icon-btn sidebar-toggle" title="Open menu"
                    onClick={() => setSidebarOpen(true)}>
              <Icon name="menu" size={16} />
            </button>
            <div className="crumbs">
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="sep"><Icon name="chevronRight" size={12} /></span>}
                  <span className={i === crumbs.length - 1 ? "here" : ""}>{c}</span>
                </React.Fragment>
              ))}
            </div>
            <div className="right">
              <button className="icon-btn" title="Toggle theme"
                      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
                <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
              </button>
              <button className="icon-btn" title="Admin"
                      onClick={() => navigate("admin")}>
                <Icon name="settings" size={15} />
              </button>
            </div>
          </div>

          <div className="page">{pageEl}</div>
        </main>
      </div>
    </ToastProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
