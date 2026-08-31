import type { Config, Context } from "@netlify/functions";
import { transformDocuments } from "./lib/transform.mts";

const UKY_TIMEOUT_MS = 10_000;
const MAX_QUERY_LEN = 1000; // F3: reject oversized queries before spending a UKY call
const MAX_UKY_BYTES = 5_000_000; // F2: reject an upstream body larger than ~5MB (best-effort, see note)
const MAX_DOCS = 100; // F2: hard ceiling on docs transformed, well ABOVE top_k (20) so it
                      // actually constrains a buggy/compromised upstream that returns far more
                      // than requested — not equal to top_k (which would make the slice a no-op)
const LOG_QUERY_PREFIX = 80; // F4: only a short prefix of the query is logged

function getCorsHeaders(request: Request): Record<string, string> {
  const allowed = (process.env.ALLOWED_ORIGINS ?? "https://support.access-ci.org")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reqOrigin = request.headers.get("Origin") ?? "";
  const origin = allowed.includes(reqOrigin) ? reqOrigin : allowed[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: object, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

function randomId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

export default async (request: Request, _context: Context): Promise<Response> => {
  const cors = getCorsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  let body: { query?: unknown; session_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, cors);
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return json({ error: "Missing query" }, 400, cors);
  if (query.length > MAX_QUERY_LEN) return json({ error: "Query too long" }, 400, cors); // F3

  // Prefer the widget-supplied session id (one per page load) so UKY's session-level
  // reporting groups searches by visit. Fall back to a generated id for direct callers
  // that don't send one, keeping backward compatibility.
  const sessionId =
    typeof body.session_id === "string" && body.session_id.trim() ? body.session_id.trim() : randomId();

  const apiKey = process.env.UKY_API_KEY;
  const ukyUrl = process.env.UKY_RETRIEVE_URL;
  if (!apiKey || !ukyUrl) return json({ error: "Search is misconfigured" }, 500, cors);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UKY_TIMEOUT_MS);
  try {
    const ukyRes = await fetch(ukyUrl, {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "X-Origin": "access-search",
        "X-Session-ID": sessionId,
        "X-Query-ID": randomId(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, top_k: 20 }),
      signal: controller.signal,
    });
    if (!ukyRes.ok) return json({ error: "Search is temporarily unavailable" }, 502, cors);
    // F2 (best-effort): if the upstream advertises an oversized Content-Length, reject
    // early. This is defense-in-depth only — the header is often absent (chunked encoding,
    // proxies) in which case this does nothing, and it does NOT prevent res.json() from
    // buffering. The real, reliable cap is MAX_DOCS below, which bounds work regardless.
    const len = Number(ukyRes.headers.get("content-length") ?? "0");
    if (len > MAX_UKY_BYTES) return json({ error: "Search is temporarily unavailable" }, 502, cors);
    const data = (await ukyRes.json()) as { documents?: any[]; query_id?: string };
    // F2 (reliable): only transform up to MAX_DOCS (100), well above top_k, so a buggy or
    // compromised upstream returning far more than requested cannot blow up the transform.
    const docs = Array.isArray(data.documents) ? data.documents.slice(0, MAX_DOCS) : [];
    const results = transformDocuments(docs);
    // Analytics: emit a structured line for query volume + zero-result rate.
    // NOTE: Netlify function logs are ephemeral and hard to aggregate over days,
    // so this console line is NOT sufficient on its own to compute the multi-day
    // zero-result rate that gates Elastic decommission (Task 8). Either UKY's
    // X-Origin reporting must be the source of record for that gate, or this line
    // must be shipped to a durable sink (e.g. a log drain). Resolve which before
    // Task 8 — see the analytics-sink decision in Task 3 Step 6.
    console.log(
      JSON.stringify({
        event: "search",
        query: query.slice(0, LOG_QUERY_PREFIX), // F4: prefix only, avoids logging pasted secrets in full
        count: results.length,
        query_id: data.query_id,
      })
    );
    return json({ query_id: data.query_id ?? "", results }, 200, cors);
  } catch {
    return json({ error: "Search is temporarily unavailable" }, 502, cors);
  } finally {
    clearTimeout(timer);
  }
};

// 30 requests per 60s per IP — the concrete abuse control replacing Turnstile.
export const config: Config = {
  rateLimit: {
    action: "rate_limit",
    aggregateBy: "ip",
    windowSize: 60,
    windowLimit: 30,
  },
};
