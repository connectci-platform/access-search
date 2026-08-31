// public/search.js
const MIN_QUERY_LEN = 2; // ignore degenerate 1-char submits; short acronyms (mfa, gpu) still allowed

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderResults(listEl, statusEl, results, query) {
  const n = results.length;
  statusEl.textContent = n
    ? `${n} result${n === 1 ? "" : "s"} for "${query}"`
    : `No results for "${query}"`;
  if (!n) {
    listEl.innerHTML =
      '<li class="as-empty">No matches — try rephrasing, or ask the chatbot below.</li>';
    return;
  }
  listEl.innerHTML = results
    .map((r) => {
      const host = hostOf(r.url);
      // r.url is already scheme-validated server-side (only http/https reach here).
      return (
        `<li class="as-result">` +
        `<a class="as-title" href="${escapeHtml(r.url)}" rel="noopener noreferrer">${escapeHtml(r.title)}</a>` +
        (host ? `<span class="as-host">${escapeHtml(host)}</span>` : "") +
        `<p class="as-snippet">${escapeHtml(r.snippet)}</p>` +
        `</li>`
      );
    })
    .join("");
}

export function initSearch(mountEl) {
  mountEl.innerHTML =
    '<form class="as-form" role="search">' +
    '<label class="as-visually-hidden" for="as-input">Search ACCESS documentation</label>' +
    '<input id="as-input" class="as-input" type="search" placeholder="Search ACCESS documentation" autocomplete="off">' +
    '<button type="submit">Search</button>' +
    "</form>" +
    '<p class="as-count" aria-hidden="true"></p>' +
    '<div class="as-visually-hidden" role="status" aria-live="polite"></div>' +
    '<ul class="as-results" role="list"></ul>' +
    '<p class="as-error" role="alert" hidden></p>';

  const form = mountEl.querySelector(".as-form");
  const input = mountEl.querySelector(".as-input");
  const countEl = mountEl.querySelector(".as-count");
  const statusEl = mountEl.querySelector('[role="status"]');
  const listEl = mountEl.querySelector(".as-results");
  const errEl = mountEl.querySelector(".as-error");

  let seq = 0; // race guard: only the latest search may render
  let inflight = null; // AbortController for the current request

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (query.length < MIN_QUERY_LEN) return;

    const mySeq = ++seq;
    if (inflight) inflight.abort();
    inflight = new AbortController();

    errEl.hidden = true;
    listEl.setAttribute("aria-busy", "true");
    listEl.innerHTML = '<li class="as-loading">Searching…</li>';
    countEl.textContent = "";

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: inflight.signal,
      });
      if (mySeq !== seq) return; // a newer search superseded this one
      if (!res.ok) throw new Error("search failed");
      const data = await res.json();
      if (mySeq !== seq) return;
      const results = data.results || [];
      renderResults(listEl, statusEl, results, query);
      countEl.textContent = statusEl.textContent; // visible mirror of the announced count
    } catch (err) {
      if (err && err.name === "AbortError") return; // superseded — ignore
      if (mySeq !== seq) return;
      listEl.innerHTML = "";
      countEl.textContent = "";
      statusEl.textContent = "Search is temporarily unavailable.";
      errEl.textContent = "Search is temporarily unavailable. Please try again.";
      errEl.hidden = false;
    } finally {
      if (mySeq === seq) listEl.setAttribute("aria-busy", "false");
    }
  });
}

if (typeof window !== "undefined") {
  window.initAccessSearch = initSearch;
  const el = document.getElementById("access-search");
  if (el) initSearch(el);
}
