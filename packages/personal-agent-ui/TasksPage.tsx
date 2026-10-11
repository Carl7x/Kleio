import { useRef, useState } from 'react';
import { Button, Input, Modal, RiskConfirmation, Tag, IconPlusOutlineRegular, IconSearchOutlineRegular, IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { createApi } from './api.mjs';
import { useAction, useResource } from './hooks';
import { Confirm, dateLabel, Empty, Feedback, Filter, Loading, Page, Refresh } from './shared';
import { ArtifactRows } from './ArtifactsPage';
import type { Navigation, Task, TaskDetail } from './types';

const api = createApi();
const statusNames: Record<string, string> = { queued: '排队中', running: '执行中', waiting: '等你处理', completed: '已完成', failed: '未完成', cancelled: '已停止' };
const tones: Record<string, 'quiet' | 'info' | 'warning' | 'success' | 'danger'> = { queued: 'quiet', running: 'info', waiting: 'warning', completed: 'success', failed: 'danger', cancelled: 'quiet' };
const activeStates = new Set(['queued', 'running', 'waiting']);
function Status({ task }: { task: Task }) { return <Tag tone={tones[task.status] || 'quiet'}>{task.cancelRequested && activeStates.has(task.status) ? '正在停止' : statusNames[task.status] || '状态待确认'}</Tag>; }

function TaskView({ id, navigation, onBack }: { id: string; navigation: Navigation; onBack: () => void }) {
  const source = useResource<TaskDetail>(`task:${id}`, signal => api.task(id, signal), 5000);
  const action = useAction();
  const [confirm, setConfirm] = useState<'stop' | 'retry' | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const retryKey = useRef('');
  const task = source.data?.task;
  const currentRun = source.data?.runs.find(run => run.id === task?.runId) || source.data?.runs.at(-1);
  const requiresAcknowledgement = !!(task?.uncertainEffects || currentRun?.dispatched);
  const canRetry = task && (task.status === 'failed' || task.status === 'cancelled' || (task.status === 'waiting' && !['approval', 'cancelling'].includes(task.waitingReason || '')));
  const errorText = typeof task?.error === 'string' ? task.error : task?.error?.message;
  const eventNames: Record<string, string> = { created: '任务已创建', started: '开始执行', dispatched: '已交给助理', 'native-turn-started': '继续执行', 'tool-started': '正在执行操作', 'tool-succeeded': '操作已完成', 'tool-failed': '操作未完成', 'approval-requested': '等待你的确认', 'approval-decided': '已收到确认结果', 'question-requested': '等待你的答复', completed: '成果已交付', failed: '执行未完成', cancelled: '已停止', waiting: '等待处理', 'cancel-requested': '正在停止', 'retry-requested': '已安排重试', 'finish-receipt': '已提交成果检查', artifact: '已收录成果', 'artifact-verification-failed': '成果检查未通过', 'completion-invalidated': '继续执行，成果需要重新检查', 'host-stopping': '运行环境正在关闭', 'recovered-interruption': '运行中断，等待检查', settled: '执行状态已更新' };
  const retry = () => action.run(() => api.retryTask(id, { requestId: retryKey.current, ...(requiresAcknowledgement ? { acknowledgeUncertainEffects: acknowledged } : {}) }), () => { setConfirm(null); source.refresh(); }, '已安排重试');
  return <Page title={task?.title || '任务'} actions={<><Button onClick={onBack}>返回任务</Button><Refresh onClick={source.refresh} loading={source.loading} /></>}>
    <Feedback error={source.error || (!confirm ? action.error : '')} notice={action.notice} retry={source.refresh} />
    {!task && source.loading && <Loading />}
    {task && <>
      <div className="kl-task-top"><Status task={task} /><span className="kl-meta">{dateLabel(task.updatedAt)}</span></div>
      {task.status !== 'completed' && <p className="kl-task-goal">{task.goal}</p>}
      <div className={`kl-task-actions${task.status === 'completed' ? ' kl-task-actions-completed' : ''}`}>
        {task.sessionId && <Button variant="primary" onClick={() => action.run(async () => navigation.openSession(task.sessionId!))}>{task.status === 'waiting' ? '去处理' : '查看执行过程'}</Button>}
        {activeStates.has(task.status) && <Button variant="outline" disabled={action.busy || task.cancelRequested} onClick={() => { action.clear(); setConfirm('stop'); }}>停止任务</Button>}
        {canRetry && <Button variant="outline" disabled={action.busy} onClick={() => { action.clear(); setAcknowledged(false); retryKey.current = crypto.randomUUID(); setConfirm('retry'); }}>再试一次</Button>}
      </div>
      {task.status === 'waiting' && <div className="kl-task-note">{task.waitingReason === 'result-needs-review' ? '成果需要检查，请在执行对话中继续。' : '助理需要你的确认或补充，请打开执行过程。'}</div>}
      {(task.status === 'failed' || task.status === 'cancelled') && errorText && <div className="kl-task-note">{task.uncertainEffects ? '部分操作可能已经发生。再次执行前，请先检查过程。' : task.status === 'cancelled' ? '任务已停止。' : '任务未完成，可以查看过程后重试。'}</div>}
      {task.summary && <section className="kl-section"><h2>结果</h2><p className="kl-task-summary">{task.summary}</p></section>}
      {!!source.data?.artifacts.length && <section className="kl-section"><h2>成果</h2><ArtifactRows items={source.data.artifacts} navigation={navigation} /></section>}
      {task.status === 'completed' && <details className="kl-task-requirements"><summary>任务要求</summary><p className="kl-task-goal">{task.goal}</p></details>}
      {!!source.data?.events.length && <details className="kl-timeline"><summary>执行记录</summary><ol>{source.data.events.slice(-30).reverse().map(event => <li key={event.seq}><span>{eventNames[event.type] || '任务状态更新'}</span><time className="kl-meta" dateTime={event.createdAt}>{dateLabel(event.createdAt)}</time></li>)}</ol></details>}
    </>}
    <Confirm open={confirm === 'stop'} title="停止这个任务？" description="正在执行的工作将停止，已经发生的操作不会撤销。" action="停止任务" busy={action.busy} error={action.error} onClose={() => setConfirm(null)} onConfirm={() => action.run(() => api.cancelTask(id), () => { setConfirm(null); source.refresh(); }, '已请求停止')} />
    {requiresAcknowledgement ? <RiskConfirmation open={confirm === 'retry'} title="再次执行前，请先检查" description={`之前的执行可能已有外部结果，重试可能重复这些操作。${action.error ? `\n${action.error}` : ''}`} acknowledgeLabel="我已检查执行过程，确认可以重试" cancelLabel="取消" closeLabel="关闭" confirmLabel={action.busy ? '提交中…' : '确认重试'} acknowledged={acknowledged} disabled={action.busy} onAcknowledgedChange={setAcknowledged} onCancel={() => { if (!action.busy) setConfirm(null); }} onConfirm={() => void retry()} /> : <Confirm open={confirm === 'retry'} title="再试一次？" description="将保留原执行记录，并开始一次新的执行。" action="开始重试" busy={action.busy} error={action.error} onClose={() => setConfirm(null)} onConfirm={() => void retry()} />}
  </Page>;
}

export function TasksPage({ navigation }: { navigation: Navigation }) {
  const source = useResource<Task[]>('tasks', signal => api.tasks(signal), 5000);
  const action = useAction();
  const [filter, setFilter] = useState('active');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [goal, setGoal] = useState('');
  const request = useRef({ id: '', goal: '' });
  const rows = source.data?.filter(task => (filter === 'all' || (filter === 'active' ? activeStates.has(task.status) : task.status === filter)) && `${task.title} ${task.goal}`.toLowerCase().includes(query.trim().toLowerCase())) || [];
  const openCreate = () => { action.clear(); request.current = { id: crypto.randomUUID(), goal: '' }; setGoal(''); setCreating(true); };
  if (selected) return <TaskView id={selected} navigation={navigation} onBack={() => { setSelected(null); source.refresh(); }} />;
  return <Page title="任务" actions={<><Refresh onClick={source.refresh} loading={source.loading} /><Button size="sm" variant="primary" icon={<IconPlusOutlineRegular size={14} />} onClick={openCreate}>新任务</Button></>}>
    <Filter label="任务状态" value={filter} onChange={setFilter} items={[{ value: 'active', label: '进行中' }, { value: 'completed', label: '已完成' }, { value: 'all', label: '全部' }]} />
    <div className="kl-search"><Input icon={<IconSearchOutlineRegular />} type="search" aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.currentTarget.value)} /></div>
    <Feedback error={source.error || (!creating ? action.error : '')} retry={source.refresh} />
    {!source.data && source.loading && <Loading />}
    {source.data && !rows.length && <Empty title={query ? '没有找到相关任务' : filter === 'completed' ? '还没有完成的任务' : filter === 'active' ? '把一件事交给我' : '还没有任务'} action={!query && filter !== 'completed' ? <Button variant="outline" onClick={openCreate}>创建任务</Button> : undefined}>{!query && filter === 'active' ? '说清目标，执行和成果都会留在这里。' : undefined}</Empty>}
    <ul className="kl-task-list" aria-busy={source.loading}>{rows.map(task => <li key={task.id}><button className="kl-task-row" type="button" onClick={() => setSelected(task.id)}><IconChecklistOutlineRegular size={20} /><div className="kl-task-row-content"><div className="kl-row-heading"><h2>{task.title}</h2><Status task={task} /></div><p>{task.summary || task.goal}</p><time className="kl-meta" dateTime={task.updatedAt}>{dateLabel(task.updatedAt)}</time></div></button></li>)}</ul>
    <Modal open={creating} title="交给助理" closeLabel="关闭" onClose={() => { if (!action.busy) setCreating(false); }} footer={<><Button variant="outline" disabled={action.busy} onClick={() => setCreating(false)}>取消</Button><Button variant="primary" disabled={action.busy || !goal.trim()} onClick={() => {
      if (request.current.goal && request.current.goal !== goal.trim()) request.current.id = crypto.randomUUID();
      request.current.goal = goal.trim();
      void action.run(() => api.createTask({ goal: goal.trim(), requestId: request.current.id }), (task: Task) => { setCreating(false); source.refresh(); setSelected(task.id); });
    }}>{action.busy ? '提交中…' : '开始执行'}</Button></>}>
      <label className="kl-field"><span>想完成什么？</span><textarea className="kl-textarea" rows={5} maxLength={12000} value={goal} placeholder="告诉我目标、要求，以及希望得到的成果。" data-modal-autofocus onChange={event => setGoal(event.currentTarget.value)} /></label><Feedback error={action.error} retry={source.refresh} />
    </Modal>
  </Page>;
}
