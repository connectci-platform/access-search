export interface UkyDocument {
  text: string;
  url: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SNIPPET_MAX = 200;

function parseTitle(text: string, url: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("#")) {
      const heading = t.replace(/^#+\s*/, "").trim();
      if (heading) return heading;
    }
  }
  // fallback: last non-empty path segment of the url
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    const seg = path.split("/").filter(Boolean).pop();
    if (seg) return decodeURIComponent(seg);
  } catch {
    /* not a valid URL — fall through */
  }
  return url || "Untitled";
}

function parseSnippet(text: string): string {
  const lines = text.split("\n");
  const descLine = lines.find((l) => l.trim().startsWith("**Description:**"));
  const descContent = descLine
    ? descLine.trim().replace(/^\*\*Description:\*\*\s*/, "")
    : "";
  let body: string;
  if (descContent) {
    // use the Description line only when it actually has content; an unfilled
    // **Description:** template field falls through to the body prose below.
    body = descContent;
  } else {
    body = lines
      .filter((l) => {
        const t = l.trim();
        return (
          t &&
          !t.startsWith("#") &&
          !t.startsWith("**Source:**") &&
          !t.startsWith("**Keywords:**") &&
          !t.startsWith("**Description:**")
        );
      })
      .join(" ")
      .trim();
  }
  if (body.length <= SNIPPET_MAX) return body;
  // truncate on a word boundary, append an ellipsis
  const cut = body.slice(0, SNIPPET_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

// Only http(s) links are safe to render as an href. Everything else
// (javascript:, data:, mailto:, ftp:, …) is dropped — this is the server-side
// XSS/open-redirect defense and cannot be bypassed by calling /api/search directly.
function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function transformDocuments(documents: UkyDocument[]): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const doc of documents ?? []) {
    const url = doc?.url ?? "";
    if (!url || seen.has(url) || !isSafeHttpUrl(url)) continue;
    seen.add(url);
    const text = doc?.text ?? "";
    out.push({ title: parseTitle(text, url), url, snippet: parseSnippet(text) });
    if (out.length >= 10) break;
  }
  return out;
}
