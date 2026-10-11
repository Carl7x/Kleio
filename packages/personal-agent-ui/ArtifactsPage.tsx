import { useState } from 'react';
import { Button, FileTypeIcon, IconSearchOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { createApi } from './api.mjs';
import { useAction, useResource } from './hooks';
import { dateLabel, Empty, Feedback, Loading, Page, Refresh } from './shared';
import type { Artifact, Navigation } from './types';

const api = createApi();
export function ArtifactRows({ items, navigation }: { items: Artifact[]; navigation: Navigation }) {
  const action = useAction();
  return <><Feedback error={action.error} /><ul className="kl-artifacts">{items.map(item => <li key={item.id}>
    <div className="kl-artifact-name"><FileTypeIcon path={item.path} size={24} /><div><h2>{item.title || item.path.split(/[\\/]/u).at(-1) || '未命名成果'}</h2><span className="kl-meta">{dateLabel(item.createdAt)}</span></div></div>
    <div className="kl-actions"><Button size="sm" disabled={action.busy} onClick={() => action.run(async () => navigation.openSession(item.sessionId))}>来源</Button><Button variant="outline" size="sm" disabled={action.busy} onClick={() => action.run(() => navigation.openArtifact(item))}>预览</Button></div>
  </li>)}</ul></>;
}
export function ArtifactsPage({ navigation }: { navigation: Navigation }) {
  const source = useResource<Artifact[]>('artifacts', signal => api.artifacts({}, signal));
  const [query, setQuery] = useState('');
  const items = source.data?.filter(item => `${item.title || ''} ${item.path}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) || [];
  return <Page title="成果" actions={<Refresh onClick={source.refresh} loading={source.loading} />}>
    <div className="kl-search"><Input type="search" icon={<IconSearchOutlineRegular />} aria-label="搜索成果" placeholder="搜索文件或成果" value={query} onChange={event => setQuery(event.currentTarget.value)} /></div>
    <Feedback error={source.error} retry={source.refresh} />
    {!source.data && source.loading && <Loading />}
    {source.data && !items.length && <Empty title={query ? '没有找到相关成果' : '完成的作品，留在这里'} action={!query ? <Button variant="outline" onClick={() => navigation.startSession()}>开始对话</Button> : undefined}>{query ? '换个文件名再试。' : '助理交付的文档和文件会自动收录。'}</Empty>}
    <ArtifactRows items={items} navigation={navigation} />
  </Page>;
}
