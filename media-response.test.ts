import { describe, expect, it } from "vitest";
import { mediaResponse } from "./media-response.js";

function file() { return new Response(new Uint8Array([0,1,2,3,4,5,6,7,8,9]), { headers: { "Content-Length": "10", "Content-Type": "video/mp4", ETag: '"v1"' } }); }
function req(range?: string, method = "GET") { return new Request("https://robb.getbb.app/media", { method, headers: range ? { Range: range } : {} }); }
describe("mobile media byte ranges", () => {
  it.each([["bytes=0-1", 0, 1], ["bytes=3-", 3, 9], ["bytes=-3", 7, 9], ["bytes=8-100", 8, 9]])("serves %s", async (range, start, end) => {
    const r = await mediaResponse(req(String(range)), file());
    expect(r.status).toBe(206);
    expect(r.headers.get("Content-Range")).toBe(`bytes ${start}-${end}/10`);
    expect(r.headers.get("Content-Length")).toBe(String(Number(end)-Number(start)+1));
    expect(r.headers.get("Content-Type")).toBe("video/mp4");
    expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual(Array.from({ length: Number(end)-Number(start)+1 }, (_, i) => i+Number(start)));
  });
  it.each(["bytes=10-", "bytes=5-3", "bytes=-0"])("rejects unsatisfiable %s", async range => {
    const r = await mediaResponse(req(range), file());
    expect(r.status).toBe(416); expect(r.headers.get("Content-Range")).toBe("bytes */10");
  });
  it("serves whole files and bodyless HEAD responses", async () => {
    expect((await mediaResponse(req(), file())).status).toBe(200);
    const r = await mediaResponse(req(undefined, "HEAD"), file());
    expect(r.headers.get("Accept-Ranges")).toBe("bytes"); expect(await r.text()).toBe("");
  });
  it("streams ranges across chunk boundaries", async () => {
    const upstream = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0,1,2])); c.enqueue(new Uint8Array([3,4,5])); c.enqueue(new Uint8Array([6,7,8,9])); c.close(); } }), { headers: { "Content-Length": "10" } });
    const r = await mediaResponse(req("bytes=2-7"), upstream);
    expect(Array.from(new Uint8Array(await r.arrayBuffer()))).toEqual([2,3,4,5,6,7]);
  });
});
