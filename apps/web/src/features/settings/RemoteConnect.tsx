import { Copy, ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { BUTTON_SECONDARY, SettingsGroup } from "./layout";

export const REMOTE_PORTAL_URL = "https://saymiao-remote.vercel.app/";

export function RemoteConnect({ onCopy }: { onCopy: (url: string) => void }) {
  return (
    <SettingsGroup title="从其他设备连接" note="保持这台电脑的 Vgent 运行并开启远程访问；在访问端登录同一个 GitHub 账户后选择这台设备。">
      <div className="flex flex-col items-start gap-lg px-md py-md sm:flex-row sm:items-center">
        <div className="flex-none rounded-md bg-white p-xs">
          <QRCodeSVG value={REMOTE_PORTAL_URL} size={144} marginSize={2} title="SayMiao Remote 连接二维码" />
        </div>
        <div className="flex min-w-0 flex-col items-start gap-sm">
          <p className="text-fg-muted text-sm">扫码或打开 SayMiao Remote，登录后从设备列表连接 Vgent。</p>
          <a href={REMOTE_PORTAL_URL} target="_blank" rel="noreferrer" className="break-all text-fg text-sm underline underline-offset-2 hover:text-fg-secondary">{REMOTE_PORTAL_URL}</a>
          <div className="flex flex-wrap gap-xs">
            <button type="button" className={BUTTON_SECONDARY} onClick={() => onCopy(REMOTE_PORTAL_URL)}><Copy className="size-md" />复制连接链接</button>
            <a href={REMOTE_PORTAL_URL} target="_blank" rel="noreferrer" className={BUTTON_SECONDARY}>打开连接页面<ExternalLink className="size-md" /></a>
          </div>
        </div>
      </div>
    </SettingsGroup>
  );
}
