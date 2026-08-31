import { describe, it, expect } from "vitest";
import { transformDocuments } from "../netlify/functions/lib/transform.mts";

const doc = (text: string, url: string) => ({ text, url });

describe("transformDocuments", () => {
  it("parses the title from the first markdown heading", () => {
    const out = transformDocuments([
      doc("# Bridges-2 (PSC) — Accounts\n\n**Source:** https://x\n\nBody text here.", "https://psc.edu/b2"),
    ]);
    expect(out[0].title).toBe("Bridges-2 (PSC) — Accounts");
  });

  it("falls back to the last url path segment when there is no heading", () => {
    const out = transformDocuments([doc("no heading here", "https://x.org/docs/globus-guide")]);
    expect(out[0].title).toBe("globus-guide");
  });

  it("prefers the Description line for the snippet and strips metadata", () => {
    const text = "# Title\n\n**Source:** https://x\n\n**Keywords:** a, b\n\n**Description:** Globus moves large datasets between ACCESS resources.\n\nMore body.";
    const out = transformDocuments([doc(text, "https://x")]);
    expect(out[0].snippet).toContain("Globus moves large datasets");
    expect(out[0].snippet).not.toContain("**Source:**");
    expect(out[0].snippet).not.toContain("**Keywords:**");
    expect(out[0].snippet).not.toContain("**Description:**");
  });

  it("falls back to body prose when there is no Description line", () => {
    const out = transformDocuments([doc("# Title\n\nJust body prose about SSH.", "https://x")]);
    expect(out[0].snippet).toContain("Just body prose about SSH");
  });

  it("caps the snippet length near 200 chars", () => {
    const long = "# T\n\n**Description:** " + "x".repeat(500);
    const out = transformDocuments([doc(long, "https://x")]);
    expect(out[0].snippet.length).toBeLessThanOrEqual(205);
  });

  it("dedupes by url keeping the first (highest-ranked) occurrence", () => {
    const out = transformDocuments([
      doc("# First\n\nbody", "https://same"),
      doc("# Second\n\nbody", "https://same"),
      doc("# Other\n\nbody", "https://other"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe("First");
    expect(out[1].url).toBe("https://other");
  });

  it("drops documents with no url", () => {
    const out = transformDocuments([doc("# T\n\nbody", ""), doc("# Keep\n\nbody", "https://k")]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://k");
  });

  it("drops documents with non-http(s) url schemes (XSS defense)", () => {
    const out = transformDocuments([
      doc("# Evil\n\nbody", "javascript:alert(document.cookie)"),
      doc("# Data\n\nbody", "data:text/html,<script>x</script>"),
      doc("# Mail\n\nbody", "mailto:x@y.com"),
      doc("# Good\n\nbody", "https://good.example/doc"),
      doc("# AlsoGood\n\nbody", "http://plain.example/doc"),
    ]);
    expect(out.map((r) => r.url)).toEqual(["https://good.example/doc", "http://plain.example/doc"]);
  });

  it("truncates the snippet on a word boundary with an ellipsis", () => {
    // 7-char repeating unit ("longww ") so a naive slice at 200 lands MID-word
    // (200 % 7 !== 0). A correct word-boundary trim must back up to the last space,
    // so the result is strictly shorter than 200 and its last word is intact.
    const long = "# T\n\n**Description:** " + "longww ".repeat(60);
    const out = transformDocuments([doc(long, "https://x")]);
    const snip = out[0].snippet;
    expect(snip.endsWith("…")).toBe(true);
    // the body before the ellipsis must be shorter than the hard cap (proves it backed up)
    expect(snip.length - 1).toBeLessThan(200);
    // the last word before the ellipsis is a complete "longww", not a fragment
    expect(snip.replace(/…$/, "").trimEnd().endsWith("longww")).toBe(true);
  });

  it("caps at 10 results", () => {
    const many = Array.from({ length: 15 }, (_, i) => doc(`# T${i}\n\nbody`, `https://u${i}`));
    expect(transformDocuments(many)).toHaveLength(10);
  });

  it("returns [] for empty input and never throws on junk", () => {
    expect(transformDocuments([])).toEqual([]);
    expect(() => transformDocuments([{ text: "", url: "" } as any])).not.toThrow();
  });
});
