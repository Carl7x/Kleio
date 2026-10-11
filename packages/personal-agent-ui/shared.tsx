import type { ReactNode } from 'react';
import { Button, IconRefreshOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Source } from './types';

export function dateLabel(value?: string) {
  if (!value || Number.isNaN(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
export function Page({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return <section className="kl-page" aria-label={title}><div className="kl-page-content"><header className="kl-heading"><h1>{title}</h1><div className="kl-actions">{actions}</div></header>{children}</div></section>;
}
export function Refresh({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  return <Button aria-label="刷新" title="刷新" disabled={loading} onClick={onClick}><IconRefreshOutlineRegular size={16} /></Button>;
}
export function Feedback({ error, notice, retry }: { error?: string; notice?: string; retry?: () => void }) {
  if (error) return <div className="kl-feedback kl-error" role="alert"><span>{error}</span>{retry && <Button size="sm" variant="outline" onClick={retry}>刷新</Button>}</div>;
  if (notice) return <div className="kl-feedback" role="status">{notice}</div>;
  return null;
}
export function Loading() {
  return <div className="kl-skeleton" role="status" aria-label="正在读取"><span /><span /><span /></div>;
}
export function Empty({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) {
  return <div className="kl-empty" role="status"><h2>{title}</h2>{children && <p>{children}</p>}{action}</div>;
}
export function Filter({ items, value, onChange, label }: { items: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="kl-filters" role="group" aria-label={label}>{items.map(item => <Button key={item.value} size="sm" className={value === item.value ? 'kl-filter-active' : ''} aria-pressed={value === item.value} onClick={() => onChange(item.value)}>{item.label}</Button>)}</div>;
}
export function SourceLink({ source, onOpen }: { source?: Source; onOpen: (id: string) => void }) {
  const id = source?.sessionId;
  if (!id || source?.kind === 'app-ui' || id === 'app:ui' || id === 'legacy-reference-import' || id.startsWith('ui:') || id.startsWith('profile:')) return <span className="kl-meta">{id === 'legacy-reference-import' ? '来自迁移记录' : '由你编辑'}</span>;
  return <Button size="sm" onClick={() => onOpen(id)}>查看来源对话</Button>;
}
export function Confirm({ title, description, action, open, busy, error, onClose, onConfirm }: { title: string; description: string; action: string; open: boolean; busy: boolean; error?: string; onClose: () => void; onConfirm: () => void }) {
  return <Modal open={open} title={title} description={description} closeLabel="关闭" onClose={() => { if (!busy) onClose(); }} footer={<><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={onConfirm}>{busy ? '处理中…' : action}</Button></>}><Feedback error={error} /></Modal>;
}
