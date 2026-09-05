import { describe, expect, it, vi } from "vitest";
import { fetchWebPreview, isPrivateNetworkAddress } from "./web-preview.js";

const publicAddresses = async () => [{ address: "93.184.216.34", family: 4 }];

describe("web previews", () => {
  it("blocks local and private network destinations", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      fetchWebPreview("http://127.0.0.1/private", { fetcher }),
    ).rejects.toThrow("Private network");
    expect(fetcher).not.toHaveBeenCalled();
    expect(isPrivateNetworkAddress("10.0.0.4")).toBe(true);
    expect(isPrivateNetworkAddress("93.184.216.34")).toBe(false);
  });

  it("extracts readable metadata and text without executable page content", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        '<html><head><title>Example essay</title><meta name="description" content="A useful abstract."><script>secret()</script></head><body><main><h1>Example essay</h1><p>First readable paragraph.</p><p>Second paragraph.</p></main></body></html>',
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      ),
    );
    const preview = await fetchWebPreview("https://example.com/essay", {
      fetcher,
      resolveAddresses: publicAddresses,
    });
    expect(preview).toMatchObject({
      url: "https://example.com/essay",
      title: "Example essay",
      siteName: "example.com",
      format: "text",
      truncated: false,
    });
    expect(preview.content).toContain("A useful abstract.");
    expect(preview.content).toContain("First readable paragraph.");
    expect(preview.content).not.toContain("secret()");
  });

  it("renders remote Markdown without YAML frontmatter", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("---\ntitle: Remote\n---\n\n# Remote note\n\nReadable **Markdown**.", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      }),
    );
    const preview = await fetchWebPreview("https://example.com/Remote.md", {
      fetcher,
      resolveAddresses: publicAddresses,
    });
    expect(preview).toMatchObject({
      title: "Remote note",
      format: "markdown",
      content: "# Remote note\n\nReadable **Markdown**.",
    });
  });
});
