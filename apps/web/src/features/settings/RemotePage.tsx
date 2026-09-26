import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import type { ApiClient } from "@/lib/api";
import type { RemoteAccessState } from "@/lib/types";
import { useToast } from "@/lib/toast";
import { BUTTON_SECONDARY, SettingsEmpty, SettingsGroup, SettingsPage, SettingsRow, Switch, Tag } from "./layout";
import { INPUT_CLASS } from "./styles";

const STATUS = { disabled: "已关闭", connecting: "连接中…", online: "在线", offline: "离线，正在重试" };
const ERROR = {
  configuration: "远程登录配置不可用。请检查 GitHub 应用是否启用了设备登录。",
  authentication: "GitHub 登录已失效或未完成，请重新登录。",
  connection: "暂时无法连接远程服务。请检查网络后刷新。",
};
type Action = Parameters<ApiClient["remoteAction"]>[0];

export function RemotePage({ client }: { client: ApiClient }) {
  const toast = useToast();
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [name, setName] = useState("");
  const editingName = useRef(false);
  const revision = useRef(0);
  const request = useRef(0);

  useEffect(() => {
    if (client.remoteSession) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const id = ++request.current;
      try {
        const next = await client.getRemote();
        if (disposed || id !== request.current) return;
        setState(next);
        if (!editingName.current) setName(next.deviceName);
      } catch (failure) {
        if (!disposed && id === request.current) setError(failure instanceof Error ? failure.message : "读取远程状态失败");
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); revision.current++; };
  }, [client]);

  const act = async (action: Action, input: Parameters<ApiClient["remoteAction"]>[1] = {}) => {
    const id = ++revision.current;
    ++request.current;
    setPending(action);
    setError(null);
    try {
      const next = await client.remoteAction(action, input);
      if (id !== revision.current) return;
      ++request.current;
      setState(next);
      if (action === "rename") editingName.current = false;
      if (!editingName.current) setName(next.deviceName);
    } catch (failure) {
      if (id === revision.current) setError(failure instanceof Error ? failure.message : "远程操作失败");
    } finally {
      if (id === revision.current) setPending(null);
    }
  };
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => toast("已复制")).catch(() => setError("复制失败，请手动选择并复制。"));
  };

  if (client.remoteSession) return <SettingsPage title="远程访问"><p className="text-fg-muted text-sm">当前已远程连接到这台电脑。登录、设备命名和远程开关请在主机上管理。</p></SettingsPage>;
  const busy = pending != null;
  const authorizing = state?.authorization != null || pending === "signIn" || (pending === "setEnabled" && state?.account == null);
  return (
    <SettingsPage title="远程访问" actions={
      <button className={BUTTON_SECONDARY} disabled={busy || state == null} onClick={() => void act("refresh")}><RefreshCw className="size-md" />刷新</button>
    }>
      <p className="text-fg-muted text-sm">在其他电脑或手机的浏览器中使用这台电脑上的 Vgent。远程访问时需登录同一个 GitHub 账户。</p>
      {(error || state?.error) && <p role="alert" className="text-danger text-sm">{error ?? (state?.error ? ERROR[state.error] : null)}</p>}
      {!state ? <SettingsEmpty>{error ? "远程访问暂不可用。" : "正在读取远程状态…"}</SettingsEmpty> : <>
        <SettingsGroup title="账户">
          <SettingsRow title={state.account ? `@${state.account.username}` : "GitHub"} help={state.account?.name ?? "登录后即可开启远程访问。"}>
            {authorizing ? <button className={BUTTON_SECONDARY} onClick={() => void act("cancelSignIn")}>取消登录</button> :
              <button className={BUTTON_SECONDARY} disabled={busy} onClick={() => void act(state.account ? "signOut" : "signIn")}>{state.account ? "退出登录" : "登录 GitHub"}</button>}
          </SettingsRow>
          {state.authorization && <SettingsRow title={<code className="font-mono select-text">{state.authorization.userCode}</code>} help="复制验证码，在 GitHub 的设备登录页面完成授权。">
            <button className={BUTTON_SECONDARY} onClick={() => copy(state.authorization!.userCode)}><Copy className="size-md" />复制</button>
            <a className={BUTTON_SECONDARY} href={state.authorization.verificationUri} target="_blank" rel="noreferrer">前往授权<ExternalLink className="size-md" /></a>
          </SettingsRow>}
        </SettingsGroup>
        <SettingsGroup title="这台电脑" note="开启后保持 Vgent 运行。关闭窗口后仍可连接；退出应用或电脑休眠时无法连接。">
          <SettingsRow title="允许远程访问" help={STATUS[state.status]}>
            <Switch checked={state.enabled} label="允许远程访问" disabled={busy && !state.enabled} onChange={(enabled) => void act("setEnabled", { enabled })} />
          </SettingsRow>
          <SettingsRow title="设备名称">
            <input aria-label="设备名称" maxLength={40} className={`${INPUT_CLASS} w-48`} value={name} disabled={busy} onChange={(event) => { editingName.current = true; setName(event.target.value); }} />
            <button className={BUTTON_SECONDARY} disabled={busy || !name.trim() || name.trim() === state.deviceName} onClick={() => void act("rename", { name: name.trim() })}>保存</button>
          </SettingsRow>
          {state.url && state.status === "online" && <SettingsRow title="访问地址" help={<span className="break-all font-mono select-text">{state.url}</span>}>
            <button className={BUTTON_SECONDARY} onClick={() => copy(state.url!)}><Copy className="size-md" />复制链接</button>
            <a href={state.url} className={BUTTON_SECONDARY} target="_blank" rel="noreferrer">打开<ExternalLink className="size-md" /></a>
          </SettingsRow>}
        </SettingsGroup>
        <SettingsGroup title="我的设备">
          {state.devices.length === 0 ? <SettingsEmpty>{state.account ? "还没有启用远程访问的设备。" : "登录后查看你的设备。"}</SettingsEmpty> : state.devices.map((device) => (
            <SettingsRow key={device.id} title={<><span className="truncate">{device.name}</span>{device.current && <Tag>本机</Tag>}</>} help={device.online == null ? "状态未知" : device.online ? "在线" : "离线"}>
              {device.url && device.online && <a className={BUTTON_SECONDARY} href={device.url} target="_blank" rel="noreferrer">打开<ExternalLink className="size-md" /></a>}
            </SettingsRow>
          ))}
        </SettingsGroup>
      </>}
    </SettingsPage>
  );
}
