export interface DeletionEffects {
  /** The chat registry lets go of the task's chat. */
  forgetChat: (threadId: string) => void;
  /** A task created a moment ago is held apart until the snapshot has it; this one is gone. */
  forgetCreated: (threadId: string) => void;
  /**
   * The task on screen *now*. It is asked when the server has answered, not when
   * 删除 was clicked: the request takes a while (it stops a run and takes a
   * worktree apart), and the user may have opened another task in the meantime —
   * who must not be thrown back to the empty state for a task they left.
   */
  selected: () => string | null;
  deselect: () => void;
  toast: (message: string) => void;
}

/** 删除任务: the request, then what the window does once the server has really deleted it. */
export function deleteTask(threadId: string, remove: () => Promise<void>, effects: DeletionEffects): Promise<void> {
  return remove().then(
    () => {
      effects.forgetChat(threadId);
      effects.forgetCreated(threadId);
      if (effects.selected() === threadId) effects.deselect();
      effects.toast("已删除任务");
    },
    (error: Error) => effects.toast(error.message),
  );
}
