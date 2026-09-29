// The security headers Cloudflare Pages sends with every page (public/_headers). The content policy allows only what the site
// really uses: its own files. The build has no data: URL and no worker, and the clip recorder's download is a link to a blob
// that no directive governs, so none of those is allowed. What the browser does under this policy is checked by the page
// tests run against a site that sends these headers (`npm run test:live`, with LIVE_URL set to it if it is not the deployed one).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The headers every page gets: the `/*` block of the file, by name. */
function pageHeaders(): Map<string, string> {
  const headers = new Map<string, string>();
  let inBlock = false;
  for (const line of readFileSync("public/_headers", "utf8").split("\n")) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) {
      inBlock = line.trim() === "/*";
      continue;
    }
    if (!inBlock) continue;
    const colon = line.indexOf(":");
    headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

function policy(): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of (pageHeaders().get("Content-Security-Policy") ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

describe("public/_headers", () => {
  it("sends the headers every page needs", () => {
    const h = pageHeaders();
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("no-referrer");
    expect(h.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(h.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=(), payment=()");
  });

  it("keeps the site on https for a year, for this address only", () => {
    // no includeSubDomains or preload: pages.dev is shared with other people's sites
    expect(pageHeaders().get("Strict-Transport-Security")).toBe("max-age=31536000");
  });

  it("lets only this site embed its files", () => {
    expect(pageHeaders().get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it("has a content policy that allows the site's own files and nothing else", () => {
    const p = policy();
    for (const name of ["default-src", "script-src", "style-src", "img-src", "media-src", "connect-src"]) expect(p.get(name), name).toEqual(["'self'"]);
    for (const name of ["object-src", "base-uri", "form-action", "frame-ancestors"]) expect(p.get(name), name).toEqual(["'none'"]);
    // data: and blob: were allowed for images and media, and blob: for workers; the built site uses none of them
    for (const [name, sources] of p) {
      expect(sources, name).not.toContain("data:");
      expect(sources, name).not.toContain("blob:");
      expect(sources, name).not.toContain("'unsafe-inline'");
      expect(sources, name).not.toContain("'unsafe-eval'");
    }
    expect(p.has("worker-src")).toBe(false);
  });
});
