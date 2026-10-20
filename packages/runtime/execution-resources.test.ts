import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ExecutionResources} from './execution-resources.ts';import {SkillStore} from '../product-context/skill-store.ts';
import type {EffectiveToolSet} from '../context-contracts/tools.ts';import type {ContextBudget} from '../context-contracts/bundle.ts';
import type {ResourcePage,ResourceReference} from '../context-contracts/resources.ts';
const budget:ContextBudget={contextWindow:1000000,maxTokens:1000,safetyTokens:100000,inputBudget:899000,dynamicReserve:200000,initialLimit:699000,estimatedInputTokens:1000,estimatorId:'utf8-bytes-plus-framing-v1'};
function fixture(t:{after(fn:()=>void):void},count=5,description='synthetic') {
 const root=mkdtempSync(join(tmpdir(),'kleio-resource-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(let i=0;i<count;i++){mkdirSync(join(root,'skills',`skill-${i}`),{recursive:true});writeFileSync(join(root,'skills',`skill-${i}`,'SKILL.md'),`---\nname: skill-${i}\ndescription: ${description}\n---\nBODY ${i} FORGOTTEN`);}
 const scope={scopeId:'s',executionId:'e'};const tools:EffectiveToolSet={schemaVersion:1,scope,profile:'conversation',catalogVersion:'t',policy:{memoryEnabled:true,searchConfigured:false},registeredNames:['web_search'],tools:[],availability:[]};
 const store=new SkillStore({dataDirectory:root,scopeId:'s'});
 const create=(executionId='e',redact=(x:string)=>x)=>new ExecutionResources({scope:{...scope,executionId},effectiveTools:{...tools,scope:{...scope,executionId}},skillStore:store,standing:[{name:'IDENTITY.md',text:'standing FORGOTTEN',sourceVersion:'standing-version'}],redact,history:[{sourceRef:'history:one',sourceVersion:'old',messages:[{role:'user',content:'history FORGOTTEN'}]}]});
 return {root,create};
}
function initialize(resources:ExecutionResources){resources.setHistorySelection([{kind:'history',sourceRef:'history:one',sourceVersion:'old',authority:'external-data',required:false,estimatedTokens:1,included:false,reason:'budget-omitted'}]);resources.initializeBudget(budget);}
function full(first:ResourcePage|ResourceReference,next:(cursor:string)=>ResourcePage|ResourceReference):ResourcePage[]{
 const pages:ResourcePage[]=[];let page=first;while(page.kind==='context-resource'){assert.ok(Buffer.byteLength(JSON.stringify(page))<=4096);pages.push(page);if(!page.nextCursor)break;page=next(page.nextCursor);}return pages;
}
test('fourth skill discovered without body; on demand text and separate referenced resources',t=>{
 const {root,create}=fixture(t);writeFileSync(join(root,'skills/skill-3/ref.txt'),'REFERENCE');writeFileSync(join(root,'skills/skill-3/unread.txt'),'UNREAD SENTINEL');
 const session=create();const metadata=session.skillsList();assert.equal(metadata.entries.length,5);assert.ok(!JSON.stringify(metadata).includes('BODY'));assert.ok(!JSON.stringify(session.catalog).includes('UNREAD'));
 initialize(session);const skill=metadata.entries[3]!;const args={skillId:skill.id,expectedVersion:skill.sourceVersion};
 const pages=full(session.skillRead(args),cursor=>session.skillRead({...args,cursor}));assert.ok(pages.filter(x=>x.section==='text').map(x=>x.text).join('').includes('BODY 3'));assert.ok(!JSON.stringify(pages).includes('UNREAD SENTINEL'));assert.equal(pages.at(-1)!.resourceComplete,true);
 const refs=full(session.skillRead({...args,resource:'ref.txt'}),cursor=>session.skillRead({...args,resource:'ref.txt',cursor}));assert.equal(refs.filter(x=>x.section==='text').map(x=>x.text).join(''),'REFERENCE');
 assert.equal(session.skillRead(args).kind,'context-resource-reference');
});
test('only issued context handles; index states original selection and metadata is paged',t=>{
 const {create}=fixture(t);const session=create();initialize(session);
 const pages=full(session.contextRead({sourceRef:'history-index'}),cursor=>session.contextRead({sourceRef:'history-index',cursor}));assert.ok(JSON.stringify(pages).includes('originallyIncluded'));assert.ok(JSON.stringify(pages).includes('false'));
 const history=full(session.contextRead({sourceRef:'history:one'}),cursor=>session.contextRead({sourceRef:'history:one',cursor}));assert.ok(JSON.stringify(history).includes('history FORGOTTEN'));
 assert.equal(session.contextRead({sourceRef:'standing/IDENTITY.md'}).kind,'context-resource');
 for(const sourceRef of ['../../secret','/etc/passwd','standing/secret','history:fake'])assert.throws(()=>session.contextRead({sourceRef}),/INVALID_CONTEXT_SOURCE/);
 assert.throws(()=>session.contextRead({sourceRef:'history:one',path:'/etc/passwd'}),/INVALID_RESOURCE_ARGUMENTS/);
});
test('catalog cursors bind query and execution, stable version excludes execution identity',t=>{
 const {create}=fixture(t,15,'x'.repeat(800));const first=create(),second=create('other');const page=first.skillsList();assert.ok(page.nextCursor);assert.ok(Buffer.byteLength(JSON.stringify(page))<=4096);assert.equal(first.catalog.sourceVersion,second.catalog.sourceVersion);
 assert.throws(()=>second.skillsList({cursor:page.nextCursor}),/INVALID_CATALOG_CURSOR/);assert.throws(()=>first.skillsList({query:'skill-1',cursor:page.nextCursor}),/INVALID_CATALOG_CURSOR/);
 let ids=page.entries.map(x=>x.id);let cursor:string|null=page.nextCursor;while(cursor){const next=first.skillsList({cursor});ids.push(...next.entries.map(x=>x.id));cursor=next.nextCursor;}assert.equal(new Set(ids).size,15);
 assert.equal(first.skillsList({query:'BODY'}).entries.length,0);assert.equal(first.skillsList({query:'skill-14'}).entries.length,1);
});
test('resource cursors reject cross source/execution and versions, budget initialization and close enforce lifecycle',t=>{
 const {create}=fixture(t);const first=create(),other=create('other');assert.throws(()=>first.contextRead({sourceRef:'standing/IDENTITY.md'}),/RESOURCE_BUDGET_NOT_INITIALIZED/);initialize(first);initialize(other);
 const page=first.contextRead({sourceRef:'standing/IDENTITY.md'});assert.equal(page.kind,'context-resource');if(page.kind!=='context-resource')return;
 assert.throws(()=>other.contextRead({sourceRef:'standing/IDENTITY.md',cursor:page.nextCursor}),/INVALID_RESOURCE_CURSOR/);assert.throws(()=>first.contextRead({sourceRef:'history:one',cursor:page.nextCursor}),/INVALID_RESOURCE_CURSOR/);
 assert.throws(()=>first.initializeBudget(budget),/ALREADY_INITIALIZED/);assert.throws(()=>first.skillRead({skillId:'skill-1',expectedVersion:'forged'}),/STALE_RESOURCE/);
 first.close();first.close();assert.throws(()=>first.skillsList(),/CLOSED/);assert.throws(()=>first.contextRead({sourceRef:'history:one'}),/CLOSED/);assert.throws(()=>first.catalog,/CLOSED/);
});
test('redaction applies to catalog, skill text, standing, history and nested metadata',t=>{
 const {create}=fixture(t,5,'FORGOTTEN description');const session=create('e',x=>x.replaceAll('FORGOTTEN','[removed]'));initialize(session);assert.ok(!JSON.stringify(session.catalog).includes('FORGOTTEN'));
 const args={skillId:'skill-4',expectedVersion:session.catalog.entries[4]!.sourceVersion};const skill=full(session.skillRead(args),cursor=>session.skillRead({...args,cursor}));assert.ok(!JSON.stringify(skill).includes('FORGOTTEN'));assert.ok(JSON.stringify(skill).includes('[removed]'));
 for(const sourceRef of ['standing/IDENTITY.md','history:one']){const pages=full(session.contextRead({sourceRef}),cursor=>session.contextRead({sourceRef,cursor}));assert.ok(!JSON.stringify(pages).includes('FORGOTTEN'));}
});
test('whole oversized catalog entry errors explicitly; resource budget is enforced',t=>{
 const {root,create}=fixture(t,1);const aliases=Array.from({length:64},(_,i)=>`    ${'alias_'.padEnd(50,'x')}${i}: web_search`).join('\n');
 writeFileSync(join(root,'skills/skill-0/SKILL.md'),`---\nname: large\ndescription: ${'x'.repeat(1024)}\nmetadata:\n  kleio:\n    toolBindings:\n${aliases.split('\n').map(x=>'  '+x).join('\n')}\n---\nbody`);
 const session=create();assert.equal(session.catalog.entries.length,1);assert.throws(()=>session.skillsList(),/CATALOG_ENTRY_TOO_LARGE/);
 session.setHistorySelection([]);session.initializeBudget({...budget,inputBudget:10});assert.throws(()=>session.contextRead({sourceRef:'standing/IDENTITY.md'}),/CONTEXT_BUDGET_EXCEEDED/);
});
test('blocked identifiers are omitted or explicitly refused; locator redaction cannot redirect a read',t=>{
 const {root,create}=fixture(t,2);const omitted=create('e',x=>x.replaceAll('skill-1','[removed]'));assert.equal(omitted.catalog.entries.length,1);
 writeFileSync(join(root,'skills/skill-0/FORGOTTEN.txt'),'private');const session=create('other',x=>x.replaceAll('FORGOTTEN','[removed]'));initialize(session);
 assert.throws(()=>session.skillRead({skillId:'skill-0',expectedVersion:session.catalog.entries[0]!.sourceVersion}),/RESOURCE_REDACTED_IDENTIFIER/);
});
test('history index versions identify actual delivered content with and without redaction',t=>{
 const {create}=fixture(t);
 for(const redact of [(x:string)=>x,(x:string)=>x.replaceAll('FORGOTTEN','[removed]')]){
  const session=create('e',redact);initialize(session);
  const index=full(session.contextRead({sourceRef:'history-index'}),cursor=>session.contextRead({sourceRef:'history-index',cursor}));
  const metadata=JSON.parse(index.filter(x=>x.section==='metadata').map(x=>x.text).join('')) as {entries:{sourceRef:string;sourceVersion:string}[]};
  const entry=metadata.entries[0]!;const history=session.contextRead({sourceRef:entry.sourceRef});
  assert.equal(history.kind,'context-resource');if(history.kind!=='context-resource')throw new Error('Expected content page');
  assert.equal(entry.sourceVersion,history.sourceVersion);assert.notEqual(entry.sourceVersion,'old');
 }
});
test('constructor failure after capture releases the execution snapshot',t=>{
 const {root}=fixture(t);const store=new SkillStore({dataDirectory:root,scopeId:'s'});
 const scope={scopeId:'s',executionId:'e'};const tools:EffectiveToolSet={schemaVersion:1,scope,profile:'conversation',catalogVersion:'t',policy:{memoryEnabled:true,searchConfigured:false},registeredNames:[],tools:[],availability:[]};
 let released=0;const release=store.release.bind(store);store.release=snapshot=>{released++;release(snapshot);};
 assert.throws(()=>new ExecutionResources({scope,effectiveTools:tools,skillStore:store,redact:x=>x,history:[],standing:[{name:'IDENTITY.md',text:'one',sourceVersion:'v1'},{name:'IDENTITY.md',text:'two',sourceVersion:'v2'}]}),/DUPLICATE_CONTEXT_SOURCE/);
 assert.equal(released,1);
});
