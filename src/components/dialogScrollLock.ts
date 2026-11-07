/**
 * 弹窗共享滚动锁：最后一个持有者释放后才恢复最初样式。
 * Viewer 与认证弹窗可以按任意顺序卸载；每个 release 都只生效一次。
 */
interface ScrollLockTarget {
  style: { overflow: string };
}

interface ScrollLockState {
  originalOverflow: string;
  holders: Set<symbol>;
}

const scrollLocks = new WeakMap<ScrollLockTarget, ScrollLockState>();

export function acquireBodyScrollLock(body: ScrollLockTarget): () => void {
  let state = scrollLocks.get(body);
  if (!state) {
    state = { originalOverflow: body.style.overflow, holders: new Set() };
    scrollLocks.set(body, state);
  }
  const token = Symbol('dialog-scroll-lock');
  state.holders.add(token);
  body.style.overflow = 'hidden';
  const acquiredState = state;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    acquiredState.holders.delete(token);
    if (acquiredState.holders.size || scrollLocks.get(body) !== acquiredState) return;
    body.style.overflow = acquiredState.originalOverflow;
    scrollLocks.delete(body);
  };
}
