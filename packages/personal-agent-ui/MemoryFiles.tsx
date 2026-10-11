import { useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { createApi } from './api.mjs';
import { useResource, useAction } from './hooks';
import { Feedback, Loading } from './shared';

type MemoryFile = { path: string; sha256: string; text: string; totalLines: number };
const api = createApi();
export function MemoryFiles() {
  const paths = useResource<{ path: string; editable: boolean }[]>('memory-files', signal => api.memoryFiles(signal));
  const [path, setPath] = useState('MEMORY.md');
  const source = useResource<MemoryFile>(`memory-file:${path}`, signal => api.memoryFile(path, signal));
  const [draft, setDraft] = useState<string | null>(null);
  const action = useAction();
  const editable = paths.data?.find(file => file.path === path)?.editable && (source.data?.totalLines || 0) <= 120;
  return <>
    <label className="kl-field"><span>记忆文件</span><select aria-label="记忆文件" value={path} onChange={event => { setPath(event.currentTarget.value); setDraft(null); action.clear(); }}>{(paths.data || [{ path: 'MEMORY.md', editable: true }]).map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
    <Feedback error={paths.error || source.error || action.error} notice={action.notice} retry={() => { paths.refresh(); source.refresh(); }} />
    {source.loading && !source.data && <Loading />}
    {source.data && <>
      <textarea className="kl-textarea" rows={16} aria-label="文件正文" readOnly={!editable} value={draft ?? source.data.text} maxLength={16000} onChange={event => setDraft(event.currentTarget.value)} />
      <div className="kl-actions"><span className="kl-meta">{editable ? '新会话生效' : '只读 · 正式事实可在“已记住”中更正'}</span>{editable && <Button variant="primary" disabled={action.busy || draft === null || draft === source.data.text} onClick={() => { if (!source.data || draft === null) return; void action.run(() => api.editMemoryFile({ path, expectedHash: source.data!.sha256, oldText: source.data!.text, newText: draft }), () => { setDraft(null); source.refresh(); }, '已保存'); }}>{action.busy ? '保存中…' : '保存'}</Button>}</div>
    </>}
  </>;
}
