import { useCallback, useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { useToast } from "@/lib/toast";
import type { ApiClient } from "@/lib/api";
import type { PlanDocument as PlanDoc } from "@/lib/types";
import { LIVE_REASON } from "@/lib/types";

const EMPTY: PlanDoc = { content: "" };

/**
 * 计划文档: the Plan turn's product, rendered as Markdown and editable in place.
 *
 * The document is the handover, so the two halves of that handover are the only
 * things this panel does: let the user change it, and hand exactly what is on
 * screen to 「Build」. A new Plan turn replaces the view — unless the user is
 * mid-edit, in which case it waits behind 「有新版本」 rather than eating their
 * words.
 */
export function PlanDocument({
  client,
  threadId,
  refreshKey,
  live,
  onBuild,
}: {
  client: ApiClient;
  threadId: string | null;
  /** The thread's `updatedAt`: a new one means a turn just ended, so re-read the file. */
  refreshKey: string;
  /** While a turn is alive neither saving nor building is allowed — the server refuses both. */
  live: boolean;
  onBuild: (threadId: string, content: string) => Promise<void>;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState<PlanDoc>(EMPTY);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  /** A newer version that landed while the user was editing; `载入` takes it. */
  const [incoming, setIncoming] = useState<PlanDoc | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = editing && draft !== saved.content;
  const content = editing ? draft : saved.content;

  // Read by the loader below, which must see the state at the moment the
  // response lands rather than the state its effect closed over.
  const dirtyRef = useRef(false);
  const savedRef = useRef(saved);
  dirtyRef.current = dirty;
  savedRef.current = saved;

  useEffect(() => {
    if (threadId == null) {
      setSaved(EMPTY);
      setDraft("");
      setEditing(false);
      setIncoming(null);
      return;
    }
    let cancelled = false;
    void client
      .getPlan(threadId)
      .then((document) => {
        if (cancelled) return;
        if (dirtyRef.current) {
          if (document.content !== savedRef.current.content) setIncoming(document);
          return;
        }
        setSaved(document);
        setDraft(document.content);
        setIncoming(null);
      })
      .catch((error: Error) => {
        if (!cancelled) toast(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [client, threadId, refreshKey, toast]);

  // A different task is a different document; nothing of this one carries over.
  useEffect(() => {
    setEditing(false);
    setIncoming(null);
  }, [threadId]);

  const save = useCallback(async (): Promise<void> => {
    if (threadId == null || !dirtyRef.current) return;
    setBusy(true);
    try {
      const document = await client.putPlan(threadId, draft);
      setSaved(document);
      setIncoming(null);
    } catch (error) {
      toast((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [client, draft, threadId, toast]);

  const build = async (): Promise<void> => {
    if (threadId == null) return;
    const text = content;
    await save();
    setEditing(false);
    await onBuild(threadId, text);
  };

  if (threadId == null) return <p className="text-fg-faint text-xs">选中一个任务才有计划。</p>;

  const buildReason = live ? LIVE_REASON : content.trim() === "" ? "还没有计划可执行" : "切回 Agent 模式，按这份计划开工";

  return (
    <section className="mb-sm">
      <div className="mb-xs flex items-center gap-2xs">
        <span className="text-fg-muted text-xs">计划文档</span>
        {dirty && <span className="text-warning text-2xs">未保存</span>}
        <span className="flex-1" />
        {editing ? (
          <button
            type="button"
            disabled={busy || live}
            {...(live ? { title: LIVE_REASON } : {})}
            // `mousedown`, so the textarea's blur-save does not race this click.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void save().then(() => setEditing(false))}
            className="inline-flex h-xl items-center rounded-sm px-xs text-fg-muted text-xs hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            保存
          </button>
        ) : (
          <button
            type="button"
            disabled={live}
            {...(live ? { title: LIVE_REASON } : {})}
            onClick={() => {
              setDraft(saved.content);
              setEditing(true);
            }}
            className="inline-flex h-xl items-center rounded-sm px-xs text-fg-muted text-xs hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            编辑
          </button>
        )}
        <button
          type="button"
          title={buildReason}
          disabled={live || content.trim() === "" || busy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void build()}
          className="inline-flex h-xl items-center rounded-sm bg-brand px-sm text-brand-fg text-xs hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Build
        </button>
      </div>

      {incoming != null && (
        <div className="mb-xs flex items-center gap-2xs rounded-sm border border-border bg-bg-inset px-xs py-2xs text-xs">
          <span className="min-w-0 flex-1 text-fg-muted">有新版本（你正在编辑，没有覆盖）</span>
          <button
            type="button"
            onClick={() => {
              setSaved(incoming);
              setDraft(incoming.content);
              setIncoming(null);
            }}
            className="flex-none rounded-sm px-2xs text-brand hover:bg-bg-hover"
          >
            载入
          </button>
        </div>
      )}

      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
            }
          }}
          className="block min-h-[calc(var(--spacing-xl)*8)] w-full resize-y rounded-sm border border-border bg-bg px-xs py-2xs font-mono text-code text-fg outline-none focus:border-border-strong"
        />
      ) : content === "" ? (
        <p className="text-fg-faint text-xs">还没有计划。用 Plan 模式发一条消息，代理调研完会把计划写在这里。</p>
      ) : (
        <div className="text-sm">
          <MessageResponse>{content}</MessageResponse>
        </div>
      )}
    </section>
  );
}
