import { useEffect, useState } from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { createApi } from './api.mjs';
import { useAction, useResource } from './hooks';
import { Feedback, Loading, Page, Refresh } from './shared';
import type { Profile } from './types';

const api = createApi();

export function ProfilePage() {
  const source = useResource<Profile>('profile', signal => api.profile(signal));
  const [draft, setDraft] = useState<Profile | null>(null);
  const action = useAction();
  useEffect(() => { if (source.data) setDraft(structuredClone(source.data)); }, [source.data]);
  const changed = draft && source.data && JSON.stringify(draft) !== JSON.stringify(source.data);
  const user = (key: keyof Profile['user'], value: string) => setDraft(previous => previous && ({ ...previous, user: { ...previous.user, [key]: value } }));
  const assistant = (key: keyof Profile['assistant'], value: string) => setDraft(previous => previous && ({ ...previous, assistant: { ...previous.assistant, [key]: value } }));
  return <Page title="资料" actions={<Refresh onClick={source.refresh} loading={source.loading} />}>
    <Feedback error={source.error || action.error} notice={action.notice} retry={source.refresh} />
    {!draft && source.loading && <Loading />}
    {draft && <form className="kl-profile" onSubmit={event => { event.preventDefault(); void action.run(() => api.saveProfile({ expectedVersion: draft.version, user: draft.user, assistant: draft.assistant, captureEnabled: draft.captureEnabled }), () => source.refresh(), '已保存'); }}>
      <fieldset disabled={action.busy}><legend>关于你</legend>
        <label className="kl-field"><span>怎么称呼你</span><Input value={draft.user.name} maxLength={80} autoComplete="nickname" onChange={event => user('name', event.currentTarget.value)} /></label>
        <div className="kl-field-pair"><label className="kl-field"><span>交流语言</span><Input value={draft.user.language} maxLength={40} onChange={event => user('language', event.currentTarget.value)} /></label><label className="kl-field"><span>时区</span><Input value={draft.user.timeZone} maxLength={100} placeholder="Asia/Shanghai" onChange={event => user('timeZone', event.currentTarget.value)} /></label></div>
      </fieldset>
      <fieldset disabled={action.busy}><legend>你的助理</legend>
        <div className="kl-field-pair"><label className="kl-field"><span>名字</span><Input value={draft.assistant.name} maxLength={80} onChange={event => assistant('name', event.currentTarget.value)} /></label><label className="kl-field"><span>沟通风格</span><Input value={draft.assistant.tone} maxLength={500} onChange={event => assistant('tone', event.currentTarget.value)} /></label></div>
        <label className="kl-field"><span>长期约定</span><textarea className="kl-textarea" value={draft.assistant.instructions} rows={4} maxLength={4000} placeholder="你希望助理一直遵守的习惯" onChange={event => assistant('instructions', event.currentTarget.value)} /></label>
      </fieldset>
      <fieldset disabled={action.busy}><legend>记忆</legend><label className="kl-check-row"><input type="checkbox" checked={draft.captureEnabled} onChange={event => setDraft({ ...draft, captureEnabled: event.currentTarget.checked })} /><span><strong>从对话中发现记忆</strong><span className="kl-meta">发现的内容先放入“待确认”，由你决定是否记住。</span></span></label></fieldset>
      <div className="kl-form-actions"><Button variant="outline" disabled={!changed || action.busy} onClick={() => { if (source.data) setDraft(structuredClone(source.data)); action.clear(); }}>还原修改</Button><Button variant="primary" type="submit" disabled={!changed || action.busy || !draft.assistant.name.trim()}>{action.busy ? '保存中…' : '保存'}</Button></div>
    </form>}
  </Page>;
}
