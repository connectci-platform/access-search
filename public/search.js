// public/search.js
const MIN_QUERY_LEN = 2; // ignore degenerate 1-char submits; short acronyms (mfa, gpu) still allowed

// One session id per page load, shared across every search on this page —
// lets UKY's session-level reporting group searches by visit instead of by request.
const sessionId =
  (typeof crypto !== "undefined" && crypto.randomUUID?.()) ??
  String(Date.now()) + Math.random().toString(16).slice(2);

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
  // Optional cross-origin API base for embeds (e.g. Drupal pages on another
  // domain), set via data-api-base on the mount element. Falls back to the
  // relative path, which works on the standalone same-origin Netlify page.
  const apiBase = mountEl.dataset.apiBase || "/api/search";

  mountEl.innerHTML =
    '<form class="as-form" role="search">' +
    '<label class="as-visually-hidden" for="as-input">Search ACCESS documentation</label>' +
    '<input id="as-input" class="as-input" type="search" placeholder="Search" autocomplete="off">' +
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
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, session_id: sessionId }),
        signal: inflight.signal,
      });
      if (mySeq !== seq) return; // a newer search superseded this one
      if (!res.ok) {
        const err = new Error("search failed");
        err.status = res.status;
        throw err;
      }
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
      const message =
        err && err.status === 429
          ? "You're searching too quickly — please wait a moment and try again."
          : "Search is temporarily unavailable. Please try again.";
      statusEl.textContent =
        err && err.status === 429
          ? "You're searching too quickly — please wait a moment and try again."
          : "Search is temporarily unavailable.";
      errEl.textContent = message;
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
