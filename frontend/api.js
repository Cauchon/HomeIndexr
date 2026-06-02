// Tiny API client for HomeIndexr backend.
// All Realtor.com scraping happens server-side.
(function () {
  async function req(path, opts) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch (e) {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  const API = {
    listProperties: () => req("/api/properties"),
    getProperty: (id) => req(`/api/properties/${id}`),
    getAreaListings: (id, filters) => {
      const qs = new URLSearchParams();
      Object.entries(filters || {}).forEach(([k, v]) => {
        if (v != null) qs.set(k, v);
      });
      const s = qs.toString();
      return req(`/api/properties/${id}/area${s ? `?${s}` : ""}`);
    },
    browse: () => req("/api/browse"),
    addProperty: (address, confirm_mismatch = false) =>
      req("/api/properties", {
        method: "POST",
        body: JSON.stringify({ address, confirm_mismatch }),
      }),
    refresh: (id) =>
      req(`/api/properties/${id}/refresh`, { method: "POST" }),
    refreshAll: () =>
      req("/api/properties/refresh-all", { method: "POST" }),
    getAISettings: () => req("/api/admin/ai-settings"),
    updateAISettings: (changes) =>
      req("/api/admin/ai-settings", {
        method: "PATCH",
        body: JSON.stringify(changes),
      }),
    askPropertyAI: (id, question) =>
      req(`/api/properties/${id}/ai/ask`, {
        method: "POST",
        body: JSON.stringify({ question }),
      }),
    backfill: (id) =>
      req(`/api/properties/${id}/backfill`, { method: "POST" }),
    updateProperty: (id, changes) =>
      req(`/api/properties/${id}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      }),
    archiveProperty: (id) =>
      req(`/api/properties/${id}/archive`, { method: "POST" }),
    restoreProperty: (id) =>
      req(`/api/properties/${id}/restore`, { method: "POST" }),
    deleteProperty: (id) =>
      req(`/api/properties/${id}`, { method: "DELETE" }),
  };

  window.API = API;
})();
