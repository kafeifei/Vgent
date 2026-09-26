import { useState } from "react";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, SettingsGroup, SettingsRow } from "./layout";
import { INPUT_CLASS } from "./styles";

export function WorktreesSection({ value, saving, onSave }: {
  value: number | undefined;
  saving: boolean;
  onSave: (value: number | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const saved = value == null ? "" : String(value);
  const input = draft ?? saved;
  const dirty = draft != null && draft !== saved;
  const parsed = input.trim() === "" ? null : Number(input);
  const valid = parsed == null || (Number.isSafeInteger(parsed) && parsed >= 1);

  return (
    <SettingsGroup title="工作目录">
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || !valid || saving) return;
        void onSave(parsed).then((ok) => { if (ok) setDraft(null); });
      }}>
        <SettingsRow title="工作目录回收上限" help="超过上限时回收最旧的空闲 worktree 任务目录。留空恢复默认值 25。">
          <input aria-label="工作目录回收上限" type="number" min={1} step={1} disabled={saving} value={input} placeholder="25"
            onChange={(event) => setDraft(event.target.value)} className={`${INPUT_CLASS} w-[calc(var(--spacing-3xl)*2)] font-mono`} />
        </SettingsRow>
        {dirty && <div className="flex items-center justify-end gap-xs px-md pb-sm">
          {!valid && <p role="alert" className="flex-1 text-danger text-sm">请输入不小于 1 的整数。</p>}
          <button type="button" disabled={saving} className={BUTTON_SECONDARY} onClick={() => setDraft(null)}>取消</button>
          <button type="submit" disabled={saving || !valid} className={BUTTON_PRIMARY}>{saving ? "保存中…" : "保存"}</button>
        </div>}
      </form>
    </SettingsGroup>
  );
}
