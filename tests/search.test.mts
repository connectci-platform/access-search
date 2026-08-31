import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function makeRequest(method: string, body?: unknown, headers?: Record<string, string>): Request {
  const h = new Headers({ "Content-Type": "application/json", ...headers });
  return new Request("https://access-search.netlify.app/api/search", {
    method,
    headers: h,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = { ip: "1.2.3.4" } as any;

async function loadHandler() {
  vi.resetModules();
  const mod = await import("../netlify/functions/search.mts");
  return mod.default;
}

describe("search proxy function", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      UKY_API_KEY: "secret-key-123",
      UKY_RETRIEVE_URL: "https://uky.example/retrieve-docs",
    };
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("rejects non-POST with 405", async () => {
    const handler = await loadHandler();
    const res = await handler(makeRequest("GET"), ctx);
    expect(res.status).toBe(405);
  });

  it("returns 400 for missing/empty query", async () => {
    const handler = await loadHandler();
    const res = await handler(makeRequest("POST", { query: "" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const handler = await loadHandler();
    const bad = new Request("https://x/api/search", {
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      body: "{not json",
    });
    const res = await handler(bad, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 for an over-long query (F3)", async () => {
    const handler = await loadHandler();
    const res = await handler(makeRequest("POST", { query: "x".repeat(1001) }), ctx);
    expect(res.status).toBe(400);
    expect(fetch as any).not.toHaveBeenCalled();
  });

  it("truncates the logged query to a prefix (F4)", async () => {
    (fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ query_id: "q", documents: [] }), { status: 200 })
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = await loadHandler();
    await handler(makeRequest("POST", { query: "y".repeat(500) }), ctx);
    const logged = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('"event":"search"'));
    expect(logged).toBeTruthy();
    // the logged query field must be truncated (<= 80 chars), not the full 500
    const rec = JSON.parse(logged!);
    expect(rec.query.length).toBeLessThanOrEqual(80);
    logSpy.mockRestore();
  });

  it("proxies to UKY and returns transformed results", async () => {
    (fetch as any).mockResolvedValue(
      new Response(
        JSON.stringify({
          query_id: "q1",
          documents: [
            { text: "# Globus\n\n**Description:** Move data.", url: "https://x/globus" },
            { text: "# Globus\n\ndupe", url: "https://x/globus" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const handler = await loadHandler();
    const res = await handler(makeRequest("POST", { query: "globus" }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query_id).toBe("q1");
    expect(body.results).toHaveLength(1); // deduped
    expect(body.results[0].title).toBe("Globus");
  });

  it("sends the required headers to UKY", async () => {
    (fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ query_id: "q", documents: [] }), { status: 200 })
    );
    const handler = await loadHandler();
    await handler(makeRequest("POST", { query: "anvil" }), ctx);
    const [, init] = (fetch as any).mock.calls[0];
    const h = new Headers(init.headers);
    expect(h.get("X-API-KEY")).toBe("secret-key-123");
    expect(h.get("X-Origin")).toBe("access-search");
    expect(h.get("X-Session-ID")).toBeTruthy();
    expect(h.get("X-Query-ID")).toBeTruthy();
    expect(JSON.parse(init.body)).toMatchObject({ query: "anvil", top_k: 20 });
  });

  it("uses the client-supplied session_id as X-Session-ID, distinct from a fresh X-Query-ID", async () => {
    (fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ query_id: "q", documents: [] }), { status: 200 })
    );
    const handler = await loadHandler();
    await handler(makeRequest("POST", { query: "anvil", session_id: "abc-123" }), ctx);
    const [, init] = (fetch as any).mock.calls[0];
    const h = new Headers(init.headers);
    expect(h.get("X-Session-ID")).toBe("abc-123");
    expect(h.get("X-Query-ID")).toBeTruthy();
    expect(h.get("X-Query-ID")).not.toBe("abc-123");
  });

  it("returns 502 on UKY failure and never leaks the key", async () => {
    (fetch as any).mockResolvedValue(new Response("upstream boom", { status: 500 }));
    const handler = await loadHandler();
    const res = await handler(makeRequest("POST", { query: "x" }), ctx);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("secret-key-123");
  });

  it("never includes the api key in a successful response", async () => {
    (fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ query_id: "q", documents: [] }), { status: 200 })
    );
    const handler = await loadHandler();
    const res = await handler(makeRequest("POST", { query: "x" }), ctx);
    const text = await res.text();
    expect(text).not.toContain("secret-key-123");
    for (const v of res.headers.values()) expect(v).not.toContain("secret-key-123");
  });

  it("widget contract: success response is exactly { query_id, results: [{ title, url, snippet }] }", async () => {
    (fetch as any).mockResolvedValue(
      new Response(
        JSON.stringify({
          query_id: "q-contract-1",
          documents: [
            { text: "# Globus\n\n**Description:** Move data between systems.", url: "https://x.example/globus" },
            { text: "# Open OnDemand\n\n**Description:** Web portal for HPC.", url: "https://x.example/ood" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const handler = await loadHandler();
    const res = await handler(makeRequest("POST", { query: "hpc" }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(typeof body.query_id).toBe("string");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(2);
    for (const r of body.results) {
      expect(typeof r.title).toBe("string");
      expect(typeof r.url).toBe("string");
      expect(typeof r.snippet).toBe("string");
    }
  });

  it("echoes an allowed origin and falls back to the support site otherwise", async () => {
    process.env.ALLOWED_ORIGINS = "https://support.access-ci.org";
    (fetch as any).mockResolvedValue(
      new Response(JSON.stringify({ query_id: "q", documents: [] }), { status: 200 })
    );
    const handler = await loadHandler();
    const allowed = await handler(
      makeRequest("POST", { query: "x" }, { Origin: "https://support.access-ci.org" }),
      ctx
    );
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://support.access-ci.org");

    const disallowed = await handler(
      makeRequest("POST", { query: "x" }, { Origin: "https://evil.example" }),
      ctx
    );
    expect(disallowed.headers.get("Access-Control-Allow-Origin")).toBe("https://support.access-ci.org");
  });
});
