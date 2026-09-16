/** Adapt a full file response to the byte ranges used by mobile video players. */
export async function mediaResponse(request: Request, upstream: Response): Promise<Response> {
  if (!upstream.ok || upstream.status === 206) return upstream;
  const headers = new Headers(upstream.headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-cache");
  const rawSize = headers.get("Content-Length");
  const size = rawSize === null ? NaN : Number(rawSize);
  const range = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  const canRange = request.method !== "HEAD" && (!ifRange || ifRange === headers.get("ETag") || ifRange === headers.get("Last-Modified"));
  const match = canRange && range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (request.method === "HEAD") {
    await upstream.body?.cancel();
    return new Response(null, { status: 200, headers });
  }
  if (!match || !Number.isSafeInteger(size) || !upstream.body) return new Response(upstream.body, { status: upstream.status, headers });
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if ((!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    await upstream.body.cancel();
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  const reader = upstream.body.getReader();
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          const chunkStart = offset;
          offset += value.length;
          if (offset <= start) continue;
          const bytes = value.subarray(Math.max(0, start - chunkStart), Math.min(value.length, end + 1 - chunkStart));
          if (bytes.length) controller.enqueue(bytes);
          if (offset > end) { controller.close(); await reader.cancel(); }
          return;
        }
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: 206, headers });
}
