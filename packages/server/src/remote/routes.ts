import type { Hono } from "hono";
import { BadRequestError, VgentServerError } from "../errors.js";
import type { RemoteService } from "./service.js";

/** Mounted after the local API's token/Host checks. The relay blocks these routes. */
export function registerRemoteRoutes(app: Hono, remote?: RemoteService, accountChanged?: () => void) {
  const service = () => {
    if (!remote) throw new VgentServerError({ message: "远程控制暂不可用，请使用包含 Web 界面的 Vgent", code: "remote_unavailable", status: 503 });
    return remote;
  };
  app.get("/api/remote", async (c) => c.json(await service().getState()));
  app.post("/api/remote", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== "object" || !("action" in body)) throw new BadRequestError("缺少远程操作", "invalid_remote_action");
    const host = service();
    if (["signIn", "signOut", "refresh"].includes(String(body.action))) { accountChanged?.(); }
    switch (body.action) {
      case "signIn": { const state = await host.signIn(); accountChanged?.(); return c.json(state); }
      case "cancelSignIn": return c.json(await host.cancelSignIn());
      case "signOut": { const state = await host.signOut(); accountChanged?.(); return c.json(state); }
      case "refresh": return c.json(await host.refresh());
      case "setEnabled":
        if (!("enabled" in body) || typeof body.enabled !== "boolean") throw new BadRequestError("enabled 必须为布尔值", "invalid_remote_action");
        return c.json(await host.setEnabled(body.enabled));
      case "rename":
        if (!("name" in body) || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 40) throw new BadRequestError("设备名称需要 1–40 个字符", "invalid_remote_action");
        return c.json(await host.rename(body.name));
      default: throw new BadRequestError("不支持的远程操作", "invalid_remote_action");
    }
  });
}
