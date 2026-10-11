import { useEffect, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path';
import { Button, IconChecklistOutlineRegular, IconDatabaseOutlineRegular, IconFolderOpenOutlineRegular, IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { MemoryPage } from './MemoryPage';
import { TasksPage } from './TasksPage';
import { ArtifactsPage } from './ArtifactsPage';
import { ProfilePage } from './ProfilePage';
import type { Artifact, Navigation } from './types';
import css from './style.css';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'kleio.navigation': 'tasks' | 'memory' | 'artifacts' | 'profile'; }
}

export const inject = ['slots', 'locale', 'layout', 'uiWorkspace', 'sidebarRight'];

/** Add personal-assistant panels through the documented native client slots. */
export function apply(ctx: Context) {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@kleio/personal-agent-ui';
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.effect(() => ctx.locale.register('kleio.navigation', {
    zh: { tasks: '任务', memory: '记忆', artifacts: '成果', profile: '资料' },
    en: { tasks: 'Tasks', memory: 'Memory', artifacts: 'Results', profile: 'Profile' },
  }));
  const t = ctx.locale.bind('kleio.navigation');
  const notices = createSnapshotStore<{ artifact?: Artifact; error?: string }>({});
  let pending: { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const fail = (message: string) => {
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); pending = undefined; }
    notices.set({ error: message });
  };
  const navigation: Navigation = {
    openSession(id) {
      try { ctx.uiWorkspace.openSession(SessionId(id)); }
      catch { fail('来源对话暂时无法打开，请刷新后重试。'); }
    },
    startSession(prompt) { ctx.uiWorkspace.startSession(undefined, prompt ? { prompt } : undefined); },
    openArtifact(artifact) {
      if (!artifact.sessionId || !artifact.path) return Promise.reject(new Error('成果来源不完整，请刷新后重试。'));
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error('已切换到另一份成果。')); pending = undefined; }
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => fail('预览未能打开，请重新打开来源对话后再试。'), 10000) };
        notices.set({ artifact });
        try { ctx.uiWorkspace.openSession(SessionId(artifact.sessionId)); }
        catch { fail('成果来源对话暂时无法打开，请刷新后重试。'); }
      });
    },
  };
  function PreviewBridge() {
    const state = useSyncExternalStore(notices.subscribe, notices.getSnapshot);
    const mounted = useSyncExternalStore(ctx.sidebarRight.mounted.subscribe, ctx.sidebarRight.mounted.getSnapshot);
    useEffect(() => {
      if (!state.artifact || mounted !== state.artifact.sessionId || !pending) return;
      try {
        // Effects run after the native session's right-panel store has mounted.
        const address = state.artifact.resourceAddress || fileAddressFor(state.artifact.sessionId, state.artifact.cwd, state.artifact.path);
        ctx.sidebarRight.openResource(address);
        clearTimeout(pending.timer); pending.resolve(); pending = undefined; notices.set({});
      } catch { fail('原生预览暂时无法打开。你可以在来源对话中查看成果。'); }
    }, [state.artifact, mounted]);
    return state.error ? <div className="kl-native-notice" role="alert"><span>{state.error}</span><Button size="sm" onClick={() => notices.set({})}>关闭</Button></div> : null;
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kleio.preview-feedback', order: 20 }, PreviewBridge));
  ctx.effect(() => () => {
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('界面已关闭。')); pending = undefined; }
  });
  const panels = [
    { id: 'kleio-tasks', name: 'tasks', order: -40, Component: TasksPage, Icon: IconChecklistOutlineRegular },
    { id: 'kleio-memory', name: 'memory', order: -30, Component: MemoryPage, Icon: IconDatabaseOutlineRegular },
    { id: 'kleio-artifacts', name: 'artifacts', order: -20, Component: ArtifactsPage, Icon: IconFolderOpenOutlineRegular },
    { id: 'kleio-profile', name: 'profile', order: -10, Component: ProfilePage, Icon: IconUserOutlineRegular },
  ] as const;
  for (const { id, name, order, Component, Icon } of panels) {
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id, inject: () => ({ navigation }) }, Component));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, order, label: () => t(name) }, ({ size }: { size: number }) => <Icon size={size} />));
  }
}
