import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import { describe, expect, it } from "vitest";
import { REMOTE_PORTAL_URL, RemoteConnect } from "./RemoteConnect";

describe("RemoteConnect", () => {
  it("uses the same public portal for its QR code and connection links", () => {
    expect(REMOTE_PORTAL_URL).toBe("https://saymiao-remote.vercel.app/");
    const html = renderToStaticMarkup(<RemoteConnect onCopy={() => {}} />);
    const qr = renderToStaticMarkup(<QRCodeSVG value={REMOTE_PORTAL_URL} size={144} marginSize={2} title="SayMiao Remote 连接二维码" />);

    expect(html).toContain(qr);
    expect(html).toContain(`href="${REMOTE_PORTAL_URL}"`);
    expect(html).toContain("复制连接链接");
    expect(html).toContain("登录同一个 GitHub 账户");
    expect(html).not.toContain("token=");
  });
});
