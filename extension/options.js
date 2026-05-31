const DEFAULT_SERVER = "http://127.0.0.1:5173";
const input = document.getElementById("server");
const status = document.getElementById("status");

chrome.storage.sync.get("serverUrl").then(({ serverUrl }) => {
  input.value = serverUrl || DEFAULT_SERVER;
});

function save() {
  const url = (input.value.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
  input.value = url;
  chrome.storage.sync.set({ serverUrl: url }).then(() => {
    status.classList.add("show");
    setTimeout(() => status.classList.remove("show"), 1400);
  });
}

document.getElementById("save").onclick = save;
input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
