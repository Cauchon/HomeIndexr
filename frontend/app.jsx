// HomeTracker — app shell

const { useState: useS, useEffect: useE, useMemo: useM, useCallback: useCB } = React;

function App() {
  const [route, setRoute] = useS({ page: "dashboard", arg: null });
  const [properties, setProperties] = useS([]);
  const [loading, setLoading] = useS(true);
  const [refreshingAll, setRefreshingAll] = useS(false);
  const [theme, setTheme] = useS(() => localStorage.getItem("ht_theme") || "light");
  const [sidebarOpen, setSidebarOpen] = useS(false);

  useE(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ht_theme", theme);
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
      else if (page === "admin") setRoute({ page: "admin", arg: null });
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
    else if (page === "add") h = "#add";
    else if (page === "admin") h = "#admin";
    else if (page === "detail") h = `#property/${arg}`;
    if (h !== window.location.hash) window.location.hash = h;
    else setRoute({ page, arg });
    setSidebarOpen(false);
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
    all: properties.length,
    issues: properties.filter((p) => p.status && p.status !== "matched").length,
  }), [properties]);

  const crumbs = useM(() => {
    if (route.page === "dashboard") return ["Properties"];
    if (route.page === "add") return ["Properties", "Add property"];
    if (route.page === "admin") return ["Refresh jobs"];
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
    />;
  } else if (route.page === "add") {
    pageEl = <AddPropertyPage navigate={navigate} onAdded={reload} />;
  } else if (route.page === "admin") {
    pageEl = <AdminPage
      properties={properties}
      loading={loading}
      navigate={navigate}
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
            <div className="mark">HT</div>
            <div className="name">HomeTracker</div>
            <div className="badge">local</div>
          </div>
          <div className="nav-group-label">Workspace</div>
          <div className={`nav-item ${route.page === "dashboard" || route.page === "detail" ? "active" : ""}`}
               onClick={() => navigate("dashboard")}>
            <Icon name="list" /> Properties
            <span className="count">{counts.all}</span>
          </div>
          <div className={`nav-item ${route.page === "add" ? "active" : ""}`}
               onClick={() => navigate("add")}>
            <Icon name="plus" /> Add property
          </div>
          <div className={`nav-item ${route.page === "admin" ? "active" : ""}`}
               onClick={() => navigate("admin")}>
            <Icon name="settings" /> Refresh jobs
            {counts.issues > 0 && <span className="count" style={{ color: "var(--warn)" }}>{counts.issues}</span>}
          </div>

          <div className="nav-group-label">Filters</div>
          <div className="nav-item" onClick={() => navigate("dashboard")}>
            <Icon name="eye" /> All properties
          </div>
          {counts.issues > 0 && (
            <div className="nav-item" onClick={() => navigate("dashboard")}>
              <Icon name="alert" /> Issues
              <span className="count" style={{ color: "var(--warn)" }}>{counts.issues}</span>
            </div>
          )}

          <div className="sidebar-footer">
            <span className="dot" />
            HomeHarvest · local
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
              <button className="icon-btn" title="Refresh jobs"
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
