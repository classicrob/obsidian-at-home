import { useEffect, useState } from "react";
import { useRpc, type PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.js";
import { mediaKind } from "./wikilink-markdown.js";

export function WikilinkMedia({ reference, alias, path, source }: {
  reference: string;
  alias: string;
  path: string;
  source: PluginFileOpenerProps["source"];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const sourceKey = JSON.stringify(source);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setUrl(null);
    setFailed(false);
    const load = async () => {
      try {
        const result = await rpc.call("resolve_media", { path, source: JSON.parse(sourceKey), reference });
        if (!active) return;
        setUrl(result.url);
        setFailed(!result.url);
        if (result.url) timer = setTimeout(load, Math.max(30_000, result.expiresAtMs - Date.now() - 60_000));
      } catch { if (active) setFailed(true); }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [rpc, path, sourceKey, reference]);
  const dimensions = /^(\d+)(?:x(\d+))?$/.exec(alias);
  const label = dimensions ? reference : alias || reference;
  const style = { maxWidth: "100%", height: "auto", display: "block" } as const;
  const width = dimensions ? Number(dimensions[1]) : undefined;
  const height = dimensions?.[2] ? Number(dimensions[2]) : undefined;
  if (!url || failed) return <span data-wikilink-media="" role="status">{failed ? `Attachment unavailable: ${reference}` : `Loading ${reference}…`}</span>;
  const common = { src: url, style, width, height, onError: () => setFailed(true) };
  if (mediaKind(reference) === "video") return <video {...common} controls playsInline preload="metadata" aria-label={label} />;
  if (mediaKind(reference) === "audio") return <audio src={url} controls preload="metadata" aria-label={label} onError={() => setFailed(true)} />;
  return <img {...common} alt={label} loading="lazy" />;
}
