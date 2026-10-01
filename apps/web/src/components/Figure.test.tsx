import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemoteFigure, externalHost } from "./Figure";

describe("externalHost", () => {
  it("names the server a web address would be fetched from", () => {
    expect(externalHost("https://evil.example/pixel.png?d=secret")).toBe("evil.example");
    expect(externalHost("http://user:pw@cdn.example:8080/a.png")).toBe("cdn.example:8080");
    // No scheme, still another server.
    expect(externalHost("//evil.example/a.png")).toBe("evil.example");
    expect(externalHost("  HTTPS://Evil.Example/a.png ")).toBe("evil.example");
  });

  it("says nothing of pictures that need no request", () => {
    expect(externalHost("data:image/png;base64,iVBORw0KGgo=")).toBeUndefined();
    expect(externalHost("DATA:image/svg+xml,%3Csvg%3E")).toBeUndefined();
    expect(externalHost("blob:http://127.0.0.1:7412/3f2a")).toBeUndefined();
    // On the page's own origin, whatever it is.
    expect(externalHost("/api/threads/t1/files/raw?path=a.png")).toBeUndefined();
    expect(externalHost("./a.png")).toBeUndefined();
    expect(externalHost("")).toBeUndefined();
  });

  it("does not let an odd scheme through as something local", () => {
    expect(externalHost("ftp://files.example/a.png")).toBe("files.example");
    expect(externalHost("javascript:alert(1)")).toBe("javascript:");
  });
});

describe("RemoteFigure", () => {
  it("asks before it fetches: an address on the web renders no image at all", () => {
    const html = renderToStaticMarkup(<RemoteFigure src="https://evil.example/pixel.png?d=secret" alt="x" />);
    expect(html).not.toContain("<img");
    expect(html).toContain("evil.example");
    expect(html).toContain("<button");
  });

  it("shows a picture that carries its own bytes straight away", () => {
    const html = renderToStaticMarkup(<RemoteFigure src="data:image/png;base64,iVBORw0KGgo=" alt="x" />);
    expect(html).toContain("<img");
  });
});
