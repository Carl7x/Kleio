import { useState } from 'react';
import { MemoryFiles } from './MemoryFiles';
import { Button, Input, Modal, Tag, IconPlusOutlineRegular, IconSearchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { createApi } from './api.mjs';
import { useAction, useDebounced, useResource } from './hooks';
import { Confirm, dateLabel, Empty, Feedback, Filter, Loading, Page, Refresh, SourceLink } from './shared';
import type { Candidate, Memory, MemoryCapture, Navigation, Revision } from './types';

const api = createApi();
type Dialog = { kind: 'edit' | 'forget'; record: Memory } | { kind: 'restore'; record: Memory; revision: Revision } | null;

function History({ memory, navigation, onRestore }: { memory: Memory; navigation: Navigation; onRestore: (revision: Revision) => void }) {
  const history = useResource<Revision[]>(`${memory.id}:${memory.version}`, signal => api.history(memory.id, signal));
  const names: Record<string, string> = { remember: '记住', correct: '更正', forget: '移除', restore: '恢复', import: '导入' };
  return <div className="kl-history" aria-label="修改记录">
    <h3>修改记录</h3><Feedback error={history.error} retry={history.refresh} />
    {!history.data && history.loading && <Loading />}
    {history.data && <ol>{[...history.data].reverse().map(revision => <li key={revision.version}>
      <div className="kl-row-heading"><span>{names[revision.operation] || '更新'} <span className="kl-meta">v{revision.version}</span></span><time className="kl-meta" dateTime={revision.createdAt}>{dateLabel(revision.createdAt)}</time></div>
      <p className={revision.record.deleted ? 'kl-muted' : ''}>{revision.record.text}</p>
      <div className="kl-actions"><SourceLink source={revision.source} onOpen={navigation.openSession} />{revision.version < memory.version && !revision.record.deleted && <Button size="sm" variant="outline" onClick={() => onRestore(revision)}>恢复此版本</Button>}</div>
    </li>)}</ol>}
  </div>;
}

function Candidates({ navigation, onChanged, refreshEpoch }: { navigation: Navigation; onChanged: () => void; refreshEpoch: number }) {
  const source = useResource<Candidate[]>(`pending-candidates:${refreshEpoch}`, signal => api.candidates(signal), 5000);
  const capture = useResource<MemoryCapture>(`memory-capture:${refreshEpoch}`, signal => api.memoryCapture(signal), 5000);
  const action = useAction();
  const [confirm, setConfirm] = useState<Candidate | null>(null);
  const latest = capture.data?.latestJob;
  const processing = !!(capture.data?.started && ((capture.data.jobs.queued || 0) + (capture.data.jobs.running || 0) > 0));
  const today = latest && new Date(latest.endedAt || latest.createdAt).toDateString() === new Date().toDateString();
  const captureMessage = processing ? '正在整理…' : latest?.status === 'failed' ? '这次整理未完成' : latest?.skipReason === 'daily_budget' && today ? '今天的记忆整理已暂停' : '';
  const accept = (item: Candidate) => action.run(() => api.acceptCandidate(item.id, {
    expectedVersion: item.version,
    mode: item.conflict ? 'correct' : 'create',
    ...(item.conflict ? { memoryId: item.conflict.id, memoryVersion: item.conflict.version } : {}),
  }), () => { setConfirm(null); source.refresh(); onChanged(); }, '已加入记忆');
  return <>
    <Feedback error={source.error || (!confirm ? action.error : '')} notice={action.notice} retry={source.refresh} />
    {capture.error && <Feedback error="整理状态暂时无法读取。" retry={capture.refresh} />}
    {captureMessage && <div className="kl-feedback" role="status"><span>{captureMessage}</span>{!processing && latest?.status === 'failed' && latest.sessionId && <Button size="sm" onClick={() => navigation.openSession(latest.sessionId!)}>查看来源对话</Button>}</div>}
    {!source.data && source.loading && <Loading />}
    {source.data?.length === 0 && <Empty title="没有待确认的记忆">对话中发现的长期偏好会出现在这里。</Empty>}
    <div className="kl-records">{source.data?.map(item => <article className="kl-record" key={item.id}>
      <div className="kl-row-heading"><h2>{item.subject}<span className="kl-key">{item.key}</span></h2><Tag tone={item.conflict ? 'warning' : 'neutral'}>{item.conflict ? '已有不同记录' : '待确认'}</Tag></div>
      <p className="kl-memory-text">{item.text}</p>
      {item.sourceQuote && <details className="kl-quote"><summary>对话原文</summary><blockquote>{item.sourceQuote}</blockquote></details>}
      {item.conflict && <p className="kl-meta">当前：{item.conflict.text}</p>}
      <div className="kl-row-footer"><SourceLink source={item.source} onOpen={navigation.openSession} /><div className="kl-actions"><Button size="sm" disabled={action.busy} onClick={() => action.run(() => api.rejectCandidate(item.id, item.version), () => source.refresh(), '已忽略')}>忽略</Button><Button variant="outline" size="sm" disabled={action.busy} onClick={() => { action.clear(); if (item.conflict) setConfirm(item); else void accept(item); }}>{item.conflict ? '查看并更正' : '记住'}</Button></div></div>
    </article>)}</div>
    <Confirm open={confirm !== null} title="更正已有记忆？" description={confirm ? `原记录：${confirm.conflict?.text}\n更正为：${confirm.text}` : ''} action="确认更正" busy={action.busy} error={action.error} onClose={() => setConfirm(null)} onConfirm={() => { if (confirm) void accept(confirm); }} />
  </>;
}

export function MemoryPage({ navigation }: { navigation: Navigation }) {
  const [filter, setFilter] = useState('active');
  const [query, setQuery] = useState('');
  const settledQuery = useDebounced(query);
  const source = useResource<Memory[]>(`memories:${filter}:${settledQuery}`, signal => api.memories({ query: settledQuery, includeDeleted: filter === 'deleted' }, signal));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draft, setDraft] = useState('');
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const action = useAction();
  const rows = source.data?.filter(record => filter === 'deleted' ? record.deleted : !record.deleted) || [];
  const close = () => { setDialog(null); action.clear(); };
  const changeDone = () => { setDialog(null); source.refresh(); };
  const openDialog = (value: Dialog) => { action.clear(); setDialog(value); if (value) setDraft(value.record.text); };

  return <Page title="记忆" actions={<><Refresh onClick={() => { source.refresh(); setRefreshEpoch(value => value + 1); }} loading={source.loading} /><Button size="sm" variant="primary" icon={<IconPlusOutlineRegular size={14} />} onClick={() => navigation.startSession('请记住：')}>记住一件事</Button></>}>
    <Filter label="记忆范围" items={[{ value: 'active', label: '已记住' }, { value: 'files', label: '文件' }, { value: 'candidates', label: '待确认' }, { value: 'deleted', label: '已移除' }]} value={filter} onChange={value => { setFilter(value); setExpanded(null); action.clear(); }} />
    {filter === 'files' ? <MemoryFiles /> : filter === 'candidates' ? <Candidates navigation={navigation} onChanged={source.refresh} refreshEpoch={refreshEpoch} /> : <>
      <div className="kl-search"><Input icon={<IconSearchOutlineRegular />} type="search" aria-label="搜索记忆" placeholder="搜索人物、偏好或约定" value={query} onChange={event => setQuery(event.currentTarget.value)} /></div>
      <Feedback error={source.error || (!dialog ? action.error : '')} notice={dialog ? '' : action.notice} retry={source.refresh} />
      {!source.data && source.loading && <Loading />}
      {source.data && rows.length === 0 && <Empty title={settledQuery ? '没有找到相关记忆' : filter === 'deleted' ? '没有已移除的记忆' : '从一件小事开始'} action={!settledQuery && filter === 'active' ? <Button variant="outline" onClick={() => navigation.startSession('请记住：')}>告诉我一个偏好</Button> : undefined}>{settledQuery ? '换个关键词再试。' : filter === 'active' ? '你的偏好和长期约定，会留在这里。' : '移除的记忆可以在这里恢复。'}</Empty>}
      <div className="kl-records" aria-busy={source.loading}>{rows.map(record => <article className="kl-record" key={record.id}>
        <div className="kl-row-heading"><h2>{record.subject}<span className="kl-key">{record.key}</span></h2>{record.deleted && <Tag tone="quiet">已移除</Tag>}</div>
        <p className={`kl-memory-text${record.deleted ? ' kl-muted' : ''}`}>{record.text}</p>
        <div className="kl-row-footer"><span className="kl-meta">{dateLabel(record.updatedAt)}</span><div className="kl-actions">
          <Button size="sm" aria-expanded={expanded === record.id} onClick={() => setExpanded(expanded === record.id ? null : record.id)}>{record.deleted ? '查看并恢复' : '来源与记录'}</Button>
          {!record.deleted && <><Button size="sm" onClick={() => openDialog({ kind: 'edit', record })}>更正</Button><Button size="sm" onClick={() => openDialog({ kind: 'forget', record })}>移除</Button></>}
        </div></div>
        {expanded === record.id && <History memory={record} navigation={navigation} onRestore={revision => openDialog({ kind: 'restore', record, revision })} />}
      </article>)}</div>
    </>}
    <Modal open={dialog?.kind === 'edit'} title="更正记忆" closeLabel="关闭" onClose={() => { if (!action.busy) close(); }} footer={<><Button variant="outline" disabled={action.busy} onClick={close}>取消</Button><Button variant="primary" disabled={action.busy || !draft.trim() || draft.trim() === dialog?.record.text} onClick={() => { if (dialog?.kind === 'edit') void action.run(() => api.correctMemory(dialog.record.id, { expectedVersion: dialog.record.version, text: draft.trim() }), changeDone, '记忆已更正'); }}>{action.busy ? '保存中…' : '确认更正'}</Button></>}>
      <label className="kl-field"><span>{dialog?.record.subject} · {dialog?.record.key}</span><textarea className="kl-textarea" rows={4} maxLength={4000} value={draft} data-modal-autofocus onChange={event => setDraft(event.currentTarget.value)} /></label><Feedback error={action.error} retry={source.refresh} />
    </Modal>
    <Confirm open={dialog?.kind === 'forget'} title="移除这条记忆？" description="它将退出召回，历史记录保留，之后可以恢复。" action="移除记忆" busy={action.busy} error={action.error} onClose={close} onConfirm={() => { if (dialog?.kind === 'forget') void action.run(() => api.forgetMemory(dialog.record.id, dialog.record.version), changeDone, '已移除，可在“已移除”中恢复'); }} />
    <Confirm open={dialog?.kind === 'restore'} title="恢复这个版本？" description={dialog?.kind === 'restore' ? dialog.revision.record.text : ''} action="恢复记忆" busy={action.busy} error={action.error} onClose={close} onConfirm={() => { if (dialog?.kind === 'restore') void action.run(() => api.restoreMemory(dialog.record.id, { expectedVersion: dialog.record.version, targetVersion: dialog.revision.version }), changeDone, '记忆已恢复'); }} />
  </Page>;
}
