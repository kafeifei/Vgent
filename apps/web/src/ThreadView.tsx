import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";
import { useEffect, useMemo, useState } from "react";
import { api, authHeaders } from "./api";
import type { AskUserQuestionsInput, AskUserQuestionsOutput, ThreadRecord } from "./types";

export function ThreadView({ threadId, token }: { threadId: string; token: string }) {
  const [thread, setThread] = useState<ThreadRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<ThreadRecord>(`/threads/${threadId}`, token)
      .then((record) => {
        if (!cancelled) setThread(record);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, token]);

  if (error != null) return <p>加载失败: {error}</p>;
  if (thread == null) return <p>加载中…</p>;
  return <Chat key={thread.id} thread={thread} token={token} />;
}

function Chat({ thread, token }: { thread: ThreadRecord; token: string }) {
  const [draft, setDraft] = useState("");

  const transport = useMemo(() => {
    const headers = authHeaders(token);
    return new DefaultChatTransport<UIMessage>({
      api: `/api/chat/${thread.id}`,
      headers,
      prepareReconnectToStreamRequest: ({ id }) => ({
        api: `/api/chat/${id}/stream`,
        headers,
      }),
    });
  }, [thread.id, token]);

  const chat = useChat({
    id: thread.id,
    messages: thread.messages,
    resume: true,
    transport,
    sendAutomaticallyWhen: ({ messages }) =>
      lastAssistantMessageIsCompleteWithApprovalResponses({ messages }) ||
      lastAssistantMessageIsCompleteWithToolCalls({ messages }),
  });

  function send() {
    if (draft.trim() === "") return;
    void chat.sendMessage({ text: draft });
    setDraft("");
  }

  return (
    <>
      <h3>{thread.title}</h3>
      {chat.messages.map((message) => (
        <section key={message.id} style={{ borderTop: "1px solid #eee", padding: "4px 0" }}>
          <b>{message.role}</b>
          {message.parts.map((part, index) => (
            <Part key={index} part={part} chat={chat} />
          ))}
        </section>
      ))}

      <hr />
      <textarea
        value={draft}
        rows={3}
        style={{ width: "100%" }}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div>
        <button onClick={send}>发送</button>
        <button
          onClick={() => {
            void chat.stop();
            void api(`/chat/${thread.id}/stop`, token, { method: "POST" }).catch(() => undefined);
          }}
        >
          停止
        </button>
        <button onClick={() => void chat.resumeStream()}>重连</button>
      </div>
      <div>
        status: {chat.status}
        {chat.error != null && ` · error: ${chat.error.message}`}
      </div>
    </>
  );
}

type ChatHelpers = ReturnType<typeof useChat<UIMessage>>;

function Part({ part, chat }: { part: UIMessage["parts"][number]; chat: ChatHelpers }) {
  if (part.type === "text") {
    return <p style={{ whiteSpace: "pre-wrap" }}>{part.text}</p>;
  }
  if (part.type === "reasoning") {
    return (
      <details>
        <summary>reasoning</summary>
        <p style={{ whiteSpace: "pre-wrap" }}>{part.text}</p>
      </details>
    );
  }
  if (isToolUIPart(part)) {
    return <ToolPart part={part} chat={chat} />;
  }
  return <pre>{JSON.stringify(part, null, 2)}</pre>;
}

function ToolPart({
  part,
  chat,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  chat: ChatHelpers;
}) {
  const toolName = getToolName(part);
  return (
    <details open={part.state === "approval-requested" || part.state === "input-available"}>
      <summary>
        {toolName} · {part.state}
      </summary>
      <pre>input: {JSON.stringify(part.input, null, 2)}</pre>
      {part.state === "output-available" && <pre>output: {JSON.stringify(part.output, null, 2)}</pre>}
      {part.state === "output-error" && <pre>error: {part.errorText}</pre>}

      {part.state === "approval-requested" && (
        <div>
          <button
            onClick={() => void chat.addToolApprovalResponse({ id: part.approval.id, approved: true })}
          >
            允许
          </button>
          <button
            onClick={() => void chat.addToolApprovalResponse({ id: part.approval.id, approved: false })}
          >
            拒绝
          </button>
        </div>
      )}

      {toolName === "askUserQuestions" && part.state === "input-available" && (
        <AskUserQuestionsForm
          input={part.input as AskUserQuestionsInput}
          toolCallId={part.toolCallId}
          chat={chat}
        />
      )}
    </details>
  );
}

function AskUserQuestionsForm({
  input,
  toolCallId,
  chat,
}: {
  input: AskUserQuestionsInput;
  toolCallId: string;
  chat: ChatHelpers;
}) {
  const [answers, setAnswers] = useState<Record<string, { optionIds: string[]; freeform?: string }>>(
    {},
  );

  function update(
    questionId: string,
    patch: Partial<{ optionIds: string[]; freeform?: string }>,
  ): void {
    setAnswers((previous) => {
      const current = previous[questionId] ?? { optionIds: [] };
      return { ...previous, [questionId]: { ...current, ...patch } };
    });
  }

  function submit(output: AskUserQuestionsOutput): void {
    void chat.addToolOutput({ tool: "askUserQuestions", toolCallId, output });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit({ action: "answered", answers });
      }}
    >
      {input.questions.map((question) => {
        const selected = answers[question.id]?.optionIds ?? [];
        return (
          <fieldset key={question.id}>
            <legend>{question.header ?? question.question}</legend>
            <p>{question.question}</p>
            {(question.options ?? []).map((option) => (
              <label key={option.id} style={{ display: "block" }}>
                <input
                  type={question.allowMultiple === true ? "checkbox" : "radio"}
                  name={question.id}
                  checked={selected.includes(option.id)}
                  onChange={(event) => {
                    update(question.id, {
                      optionIds:
                        question.allowMultiple === true
                          ? event.target.checked
                            ? [...selected, option.id]
                            : selected.filter((id) => id !== option.id)
                          : [option.id],
                    });
                  }}
                />
                {option.label}
                {option.description != null && <small> — {option.description}</small>}
              </label>
            ))}
            {question.allowFreeForm === true && (
              <input
                placeholder="自由输入"
                value={answers[question.id]?.freeform ?? ""}
                onChange={(event) => update(question.id, { freeform: event.target.value })}
              />
            )}
          </fieldset>
        );
      })}
      <button type="submit">提交</button>
      <button type="button" onClick={() => submit({ action: "declined" })}>
        拒绝回答
      </button>
    </form>
  );
}
