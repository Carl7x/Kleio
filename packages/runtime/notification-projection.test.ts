import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RuntimeStore} from './store.ts';
import {RuntimeHost} from './host.ts';
import {createRuntimeApp} from '../../apps/runtime/app.ts';
import {projectNotification} from '../../apps/runtime/notification-projection.ts';
import type {WorkNotification} from '../personal-tasks/runtime.ts';

test('six notification projections redact forgotten titles and text while preserving domain records and durable reads',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'kleio-notification-projection-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const database=join(directory,'synthetic.sqlite');
 const store=new RuntimeStore(database);
 const token='isolated-notification-projection-token';
 const host=new RuntimeHost(store,{id:'unused',execute:async()=>{throw Error('No model required');},close:async()=>{}},{port:31999,token,listenHost:'127.0.0.1',dataDirectory:directory,model:{baseURL:'https://example.invalid',id:'unused',apiKey:''},memoryIdleMs:120000});
 const phrase='我喜欢桂花乌龙拿铁';
 try{
  const conversation=store.createConversation('Notification projection');
  host.work.create({requestId:'notification-projection',title:phrase,prompt:phrase,kind:'reminder'},{kind:'user',conversationId:conversation.id,messageId:'reminder-source'});
  await host.work.tick({runResearch:async()=>{throw Error('unused');},review:async()=>{throw Error('unused');}},{limit:1});
  const original=host.work.notifications({conversationId:conversation.id})[0]!;
  assert.equal(original.title,phrase);assert.equal(original.text,phrase);assert.equal(original.readAt,null);
  const claim=host.memory.remember({key:'饮品偏好',text:phrase,source:{messageId:'memory-source',conversationId:conversation.id,createdAt:new Date().toISOString(),quote:phrase}});
  host.forget(claim.id);
  const displayed=projectNotification(Object.freeze({...original}),text=>host.memory.redactBlocked(text));
  assert.notEqual(displayed,original);assert.deepEqual(Object.keys(displayed).sort(),Object.keys(original).sort());
  assert.deepEqual(displayed,{...original,title:'[已停止使用]',text:'[已停止使用]'});
  const app=createRuntimeApp(host,()=>{});
  const request=async(path:string,method='GET')=>{
   const response=await app.request(`http://127.0.0.1:31999${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
   assert.equal(response.status,200);return await response.json() as any;
  };
  const all=await request(`/api/notifications?conversationId=${conversation.id}`) as WorkNotification[];
  assert.equal(all.length,1);assert.deepEqual(all[0],displayed);
  assert.equal(host.work.notifications()[0]!.readAt,null); // GET projection never marks read.
  const read=await request(`/api/notifications/${original.id}/read`,'POST') as WorkNotification;
  assert.equal(read.id,original.id);assert.equal(read.title,'[已停止使用]');assert.equal(read.text,'[已停止使用]');assert.ok(read.readAt);
  assert.deepEqual(Object.keys(read).sort(),Object.keys(original).sort());
  const agentShape={id:original.id,taskId:original.taskId,title:'[已停止使用]',body:'[已停止使用]',createdAt:original.createdAt,read:true};
  const agent=await request('/api/agent');assert.deepEqual(agent.notifications,[agentShape]);
  assert.deepEqual(await request('/api/agent/notifications'),[agentShape]);
  assert.deepEqual(await request(`/api/agent/notifications/${original.id}/read`,'POST'),agentShape);
  const workspace=await request('/api/workspace');assert.deepEqual(workspace.activity,[{id:original.id,title:'[已停止使用]',detail:'[已停止使用]',date:original.createdAt,status:'read'}]);
  const reread=await request(`/api/notifications/${original.id}/read`,'POST') as WorkNotification;
  assert.equal(reread.readAt,read.readAt);
  assert.deepEqual(host.work.notifications(),[{...original,readAt:read.readAt}]);
  const raw=store.db.prepare('SELECT record,read_at FROM kw_notifications WHERE id=?').get(original.id)!;
  assert.deepEqual(JSON.parse(String(raw.record)),{...original,readAt:read.readAt});assert.equal(raw.read_at,read.readAt);
 }finally{await host.close();store.close();}
 // A fresh connection observes the same original delivery and durable read state.
 try{const reopened=new RuntimeStore(database);try{const row=reopened.db.prepare('SELECT record,read_at FROM kw_notifications').get()!;const value=JSON.parse(String(row.record));assert.equal(value.text,phrase);assert.equal(value.title,phrase);assert.ok(value.readAt);assert.equal(row.read_at,value.readAt);}finally{reopened.close();}}finally{rmSync(directory,{recursive:true,force:true});}
});
