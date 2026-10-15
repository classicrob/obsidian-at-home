import type { ReactNode } from "react";
import {
  IFRAME_ALLOW,
  IFRAME_SANDBOX,
  iframeFrameStyle,
  iframeLinkLabel,
  parseIframeEmbeds,
} from "./iframe-embed.js";

/** Renders the iframes in a chunk of raw note HTML through the allowlist. */
export function IframeEmbeds({
  html,
  inline,
  renderUrlLink,
}: {
  html: string;
  inline: boolean;
  renderUrlLink(url: string, children: ReactNode): ReactNode;
}) {
  const Wrapper = inline ? "span" : "div";
  return (
    <Wrapper className={inline ? "wikilinks-iframe-group is-inline" : "wikilinks-iframe-group"}>
      {parseIframeEmbeds(html).map((embed, index) => {
        if (embed.kind === "embed") {
          return (
            <Wrapper key={index} className="wikilinks-iframe-embed" style={iframeFrameStyle(embed)}>
              <iframe
                src={embed.src}
                title={embed.title}
                sandbox={IFRAME_SANDBOX}
                allow={IFRAME_ALLOW}
                allowFullScreen
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </Wrapper>
          );
        }
        if (embed.kind === "link") {
          return <span key={index} className="wikilinks-iframe-link">{renderUrlLink(embed.href, iframeLinkLabel(embed))}</span>;
        }
        return <code key={index} className="wikilinks-iframe-link">{embed.text}</code>;
      })}
    </Wrapper>
  );
}
