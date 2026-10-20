import test from 'node:test';
import assert from 'node:assert/strict';
import type {Execution,Message as SavedMessage,ProductEvent} from '../src/api.ts';
import {projectConversationMessages,executionMessages} from './conversation-history.ts';
const timestamp='2026-10-19T00:00:00.000Z';
const saved=(id:string,sequence:number,role:'user'|'assistant',executionId:string,content=id,status='completed'):SavedMessage=>({id,sequence,role,executionId,content,status,conversationId:'c',createdAt:timestamp});
const execution=(id:string,messageId:string|null,kind:Execution['kind']='conversation',status='completed',text=id):Execution=>({id,messageId,kind,status,text,conversationId:'c',error:null,createdAt:timestamp,updatedAt:timestamp});
const project=(messages:SavedMessage[],executions:Execution[]=[],eventsByExecution=new Map<string,ProductEvent[]>())=>projectConversationMessages({conversationId:'c',saved:messages,executions,eventsByExecution});
test('persistent sequence anchors completed responses and independent deliveries between user turns',()=>{
 const rows=[saved('u1',1,'user','e1'),saved('a1',2,'assistant','e1'),saved('delivery',3,'assistant','review','research'),saved('u2',4,'user','e2'),saved('a2',5,'assistant','e2')];
 const turns=[execution('e1','u1'),execution('review',null,'review','completed','INTERNAL JSON'),execution('e2','u2')];
 const result=project([...rows].reverse(),turns);
 assert.deepEqual(result.map(x=>x.content),['u1','e1','research','u2','e2']);
 assert.deepEqual(result[2],{id:'delivery',role:'assistant',content:'research'});assert.ok(!JSON.stringify(result).includes('INTERNAL JSON'));
});
test('same timestamp and identical delivery text retain distinct IDs; replay and duplicated inputs are stable',()=>{
 const rows=[saved('u',1,'user','e'),saved('a',2,'assistant','e'),saved('d1',3,'assistant','r1','same'),saved('d2',4,'assistant','r2','same')];
 const turns=[execution('e','u')];const first=project([...rows,rows[2]!],turns);
 assert.deepEqual(first.map(x=>x.content),['u','e','same','same']);assert.deepEqual(first,project(rows,turns));
 assert.equal(first.filter(x=>x.id==='d1').length,1);assert.equal(first.filter(x=>x.id==='d2').length,1);
});
test('conversation blocks preserve text/call/result/next-text ordering and remain intact at assistant anchor',()=>{
 const events:ProductEvent[]=[{sequence:1,executionId:'e',type:'text.delta',data:{text:'before'}},{sequence:2,executionId:'e',type:'tool.started',data:{callId:'call',name:'web_search',args:{q:'test'}}},{sequence:3,executionId:'e',type:'tool.completed',data:{callId:'call',name:'web_search',result:{answer:'found'}}},{sequence:4,executionId:'e',type:'text.delta',data:{text:'after'}}].map(x=>({...x,createdAt:timestamp}));
 const turn=execution('e','u');const rows=[saved('u',1,'user','e'),saved('d',2,'assistant','review','delivery'),saved('a',3,'assistant','e')];
 const result=project(rows,[turn],new Map([['e',events]]));
 assert.deepEqual(result.slice(0,2).map(x=>x.content),['u','delivery']);assert.deepEqual(result.slice(2),executionMessages(turn,events));
 assert.deepEqual(result.slice(2).map(x=>x.role),['assistant','tool','assistant']);
});
test('unpersisted live and failed attempts stay at user anchor while persisted retry uses its own sequence',()=>{
 const failed=execution('failed','u','conversation','failed','partial');const live=execution('live','u','conversation','running','stream');
 const rows=[saved('u',1,'user','failed'),saved('d',2,'assistant','review','delivery'),saved('retry-answer',3,'assistant','retry')];
 const retry=execution('retry','u','conversation','completed','retried');
 const result=project(rows,[failed,live,retry]);assert.deepEqual(result.map(x=>x.content),['u','partial','stream','delivery','retried']);
 assert.equal(result.filter(x=>x.content==='stream').length,1);
 assert.deepEqual(result,project([...rows,rows[0]!],[failed,live,retry,live]));
});
test('completed orphan fallback displays saved text; noncompleted orphan and unpersisted internal jobs stay hidden',()=>{
 const rows=[saved('delivery',1,'assistant','missing','saved report'),saved('failed-orphan',2,'assistant','missing-failed','unsafe partial','failed')];
 const turns=[execution('internal-review',null,'review','completed','PRIVATE REVIEW JSON'),execution('internal-memory',null,'memory','completed','PRIVATE MEMORY JSON')];
 assert.deepEqual(project(rows,turns),[{id:'delivery',role:'assistant',content:'saved report'}]);
});
test('cross-conversation messages, executions and misbound event records cannot affect output',()=>{
 const own=saved('u',1,'user','e');const foreign={...saved('foreign',2,'assistant','foreign-execution','foreign'),conversationId:'other'};
 const turn=execution('e','u');const foreignTurn={...execution('foreign-execution','u','conversation','running','foreign'),conversationId:'other'};
 const badEvent:ProductEvent={sequence:1,executionId:'foreign-execution',type:'text.delta',data:{text:'injected'},createdAt:timestamp};
 const result=project([own,foreign],[turn,foreignTurn],new Map([['e',[badEvent]]]));assert.deepEqual(result.map(x=>x.content),['u','e']);
});
test('persisted failed conversation attempt remains visible once, followed by retry without implicit success',()=>{
 const rows=[saved('u',1,'user','failed'),saved('failed-answer',2,'assistant','failed','partial','failed'),saved('retry-answer',3,'assistant','retry','done')];
 const result=project(rows,[execution('failed','u','conversation','failed','partial'),execution('retry','u','conversation','completed','done')]);
 assert.deepEqual(result.map(x=>x.content),['u','partial','done']);
});
