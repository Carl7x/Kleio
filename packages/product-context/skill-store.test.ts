import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore } from './skill-store.ts';
import type { EffectiveToolSet } from '../context-contracts/tools.ts';
const scope = {scopeId:'test',executionId:'exec'};
const tools: EffectiveToolSet = {schemaVersion:1,scope,profile:'conversation',catalogVersion:'x',policy:{memoryEnabled:true,searchConfigured:false},registeredNames:['web_search'],tools:[{name:'web_search',description:'search',inputSchema:{}}],availability:[]};
function fixture(t: {after(fn:()=>void):void}) {
  const root = mkdtempSync(join(tmpdir(),'kleio-skills-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const add = (id:string, extra='') => { mkdirSync(join(root,'skills',id),{recursive:true}); writeFileSync(join(root,'skills',id,'SKILL.md'),`---\nname: ${id}\ndescription: synthetic\n${extra}---\nbody ${id}`); };
  return {root,add,store:new SkillStore({dataDirectory:root,scopeId:'test'})};
}
test('discovery is not index whitelist; effective tools and metadata constraints', t => {
  const {root,add,store}=fixture(t); for(const id of ['one','two','three','four','five']) add(id);
  writeFileSync(join(root,'skills-index.json'),JSON.stringify({version:1,skills:[{id:'one',enabled:false}]}));
  add('needs','metadata:\n  kleio:\n    requiresTools: [missing_tool]\n');
  const snap=store.capture(scope,tools); assert.equal(snap.skills.length,4); assert.ok(snap.skills.some(x=>x.skillId==='five')); assert.ok(snap.diagnostics.some(x=>x.code==='INELIGIBLE'));
  assert.ok(Object.isFrozen(snap.skills)); assert.throws(()=>store.readResource({...snap},'five',snap.skills[0]!.skillVersion));
});
test('complete package is immutable, next execution sees edits, live disable refuses cached reads',t=>{
  const {root,add,store}=fixture(t); add('four'); const file=join(root,'skills/four/reference.txt'); writeFileSync(file,'original');
  const snap=store.capture(scope,tools), version=snap.skills[0]!.skillVersion;
  const read=store.readResource(snap,'four',version); assert.equal(read.metadata.relatedResources.length,1); assert.ok(!JSON.stringify(read).includes('original'));
  writeFileSync(file,'changed'); writeFileSync(join(root,'skills/four/SKILL.md'),'---\nname: four\ndescription: changed\n---\nnew');
  assert.equal(store.readResource(snap,'four',version,'reference.txt').text,'original');
  assert.notEqual(store.capture(scope,tools).skills[0]!.skillVersion,version);
  writeFileSync(join(root,'skills-index.json'),JSON.stringify({version:1,skills:[{id:'four',enabled:false}]}));
  assert.throws(()=>store.readResource(snap,'four',version),/SKILL_DISABLED/); store.release(snap); assert.throws(()=>store.readResource(snap,'four',version),/INVALID_SNAPSHOT/);
});
test('first read version change poisons skill for execution even when restored',t=>{
  const {root,add,store}=fixture(t); add('four'); const snap=store.capture(scope,tools),version=snap.skills[0]!.skillVersion;
  writeFileSync(join(root,'skills/four/SKILL.md'),'changed'); assert.throws(()=>store.readResource(snap,'four',version),/STALE_RESOURCE/); add('four'); assert.throws(()=>store.readResource(snap,'four',version),/STALE_RESOURCE/);
});
test('path encodings, absolute paths, links, UTF8 and file/package caps refuse whole package',t=>{
  for(const mode of ['symlink','hardlink','utf8','large','many']) {
    const {root,add,store}=fixture(t); add('four'); const folder=join(root,'skills/four');
    if(mode==='symlink') symlinkSync(join(folder,'SKILL.md'),join(folder,'linked.txt'));
    if(mode==='hardlink') linkSync(join(folder,'SKILL.md'),join(folder,'linked.txt'));
    if(mode==='utf8') writeFileSync(join(folder,'bad.txt'),Buffer.from([0xc0,0xaf]));
    if(mode==='large') writeFileSync(join(folder,'large.txt'),'a'.repeat(65537));
    if(mode==='many') for(let i=0;i<64;i++)writeFileSync(join(folder,`file${i}.txt`),'a');
    const snap=store.capture(scope,tools);
    if(mode==='hardlink') { assert.equal(snap.skills.length,0); continue; }
    const version=snap.skills[0]!.skillVersion; assert.throws(()=>store.readResource(snap,'four',version));
  }
  const {add,store}=fixture(t); add('four'); const snap=store.capture(scope,tools),v=snap.skills[0]!.skillVersion;
  for(const path of ['/etc/passwd','../SKILL.md','%2e%2e/secret','a\\b','a//b','a/%252e'])assert.throws(()=>store.readResource(snap,'four',v,path),/INVALID_RESOURCE/);
});
test('oversized package and execution cache are rejected atomically; metadata list is whole',t=>{
  const {root,add,store}=fixture(t); add('many');
  for(let i=0;i<63;i++)writeFileSync(join(root,'skills/many',`r${i}.txt`),'x');
  const snap=store.capture(scope,tools); const resource=store.readResource(snap,'many',snap.skills[0]!.skillVersion);
  assert.equal(resource.metadata.relatedResources.length,63);
  assert.ok(Object.isFrozen(resource.metadata.relatedResources));
  add('oversize'); for(let i=0;i<8;i++)writeFileSync(join(root,'skills/oversize',`r${i}.txt`),'x'.repeat(65536));
  const second=store.capture(scope,tools), over=second.skills.find(x=>x.skillId==='oversize')!;
  assert.throws(()=>store.readResource(second,'oversize',over.skillVersion),/PACKAGE_LIMIT/);
  for(let i=0;i<17;i++) { const id=`pack-${i}`; add(id); for(let j=0;j<7;j++)writeFileSync(join(root,'skills',id,`r${j}.txt`),'x'.repeat(65536)); }
  const third=store.capture(scope,tools);
  for(const skill of third.skills.filter(x=>x.skillId.startsWith('pack-')))store.readResource(third,skill.skillId,skill.skillVersion);
  add('last'); for(let j=0;j<7;j++)writeFileSync(join(root,'skills/last',`r${j}.txt`),'x'.repeat(65536));
  const fourth=store.capture(scope,tools);
  let rejected=0;
  for(const skill of fourth.skills.filter(x=>x.skillId.startsWith('pack-')||x.skillId==='last'))try{store.readResource(fourth,skill.skillId,skill.skillVersion);}catch(error){assert.match(String(error),/CACHE_LIMIT/);rejected++;}
  assert.equal(rejected,0); // 18 bounded packages still fit; subsequent package crosses 8 MiB.
  // A nineteenth package must exceed the same execution's cap, so use a fresh catalog with all nineteen.
  add('extra'); for(let j=0;j<7;j++)writeFileSync(join(root,'skills/extra',`r${j}.txt`),'x'.repeat(65536));
  const fifth=store.capture(scope,tools);
  rejected=0;
  for(const skill of fifth.skills.filter(x=>!['many','oversize'].includes(x.skillId)))try{store.readResource(fifth,skill.skillId,skill.skillVersion);}catch(error){assert.match(String(error),/CACHE_LIMIT/);rejected++;}
  assert.equal(rejected,1);
});
test('catalog bounds and invalid index produce explicit diagnostics without a partial whitelist',t=>{
  const {root,add,store}=fixture(t); add('valid');
  writeFileSync(join(root,'skills-index.json'),'{broken'); assert.equal(store.capture(scope,tools).diagnostics[0]!.code,'INVALID_INDEX');
  rmSync(join(root,'skills-index.json'));
  for(let i=0;i<256;i++)mkdirSync(join(root,'skills',`extra-${i}`));
  const snap=store.capture(scope,tools); assert.equal(snap.skills.length,0);assert.equal(snap.diagnostics[0]!.code,'CATALOG_LIMIT');
});
test('real required tools cannot be replaced by aliases; index constraints only add requirements',t=>{
  const {root,add,store}=fixture(t);
  add('required','metadata:\n  kleio:\n    requiresTools: [web_search]\n');
  writeFileSync(join(root,'skills-index.json'),JSON.stringify({version:1,skills:[{id:'required',requiresTools:[],toolBindings:{web_search:'web_read'}}]}));
  const readOnlyTools: EffectiveToolSet={...tools,registeredNames:['web_search','web_read'],tools:[{name:'web_read',description:'read',inputSchema:{}}]};
  const denied=store.capture(scope,readOnlyTools);
  assert.equal(denied.skills.length,0);assert.equal(denied.diagnostics[0]!.code,'INELIGIBLE');
  writeFileSync(join(root,'skills-index.json'),JSON.stringify({version:1,skills:[{id:'required',requiresTools:['web_read'],toolBindings:{optional_alias:'web_read'}}]}));
  const unionDenied=store.capture(scope,{...tools,registeredNames:['web_search','web_read']});
  assert.equal(unionDenied.skills.length,0);assert.equal(unionDenied.diagnostics[0]!.code,'INELIGIBLE');
  writeFileSync(join(root,'skills-index.json'),JSON.stringify({version:1,skills:[{id:'required',toolBindings:{optional_alias:'web_read'}}]}));
  const admitted=store.capture(scope,{...tools,registeredNames:['web_search','web_read']});
  assert.deepEqual(admitted.skills[0]!.requiresTools,['web_search']);
  assert.equal(admitted.skills[0]!.toolBindings.optional_alias,'web_read');
});
test('policy view and setter preserve unrelated fields, entries and skill bodies',t=>{
 const {root,add,store}=fixture(t);add('four');
 const original={version:1,skills:[{id:'four',enabled:true,requiresTools:['web_search'],toolBindings:{search:'web_search'}},{id:'other',enabled:false,requiresTools:[],toolBindings:{}}]};
 const indexPath=join(root,'skills-index.json');writeFileSync(indexPath,JSON.stringify(original));
 const before=store.readPolicy();assert.deepEqual(before.disabledIds,['other']);assert.ok(Object.isFrozen(before));assert.ok(Object.isFrozen(before.disabledIds));
 const disabled=store.setEnabled('four',false);assert.deepEqual(disabled.disabledIds,['four','other']);
 const read=JSON.parse(readFileSync(indexPath,'utf8'));assert.deepEqual(read.skills[0],{...original.skills[0],enabled:false});assert.deepEqual(read.skills[1],original.skills[1]);
 assert.match(readFileSync(join(root,'skills/four/SKILL.md'),'utf8'),/body four/);
 const exact=readFileSync(indexPath,'utf8');const same=store.setEnabled('four',false);assert.equal(readFileSync(indexPath,'utf8'),exact);assert.equal(same.sourceVersion,disabled.sourceVersion);
 assert.deepEqual(store.setEnabled('four',true).disabledIds,['other']);
 const formatted=store.readPolicy();writeFileSync(indexPath,JSON.stringify(JSON.parse(readFileSync(indexPath,'utf8'))));
 const reformatted=store.readPolicy();assert.deepEqual(reformatted.disabledIds,formatted.disabledIds);assert.notEqual(reformatted.sourceVersion,formatted.sourceVersion);
});
test('missing policy creates only index; unknown future ids supported; invalid index never repaired',t=>{
 const {root,store}=fixture(t);const missing=store.readPolicy();assert.deepEqual(missing.disabledIds,[]);
 assert.deepEqual(store.setEnabled('future-skill',false).disabledIds,['future-skill']);assert.equal(existsSync(join(root,'skills')),false);
 const path=join(root,'skills-index.json');for(const content of ['{broken','{"version":1,"skills":[{"id":"x","enabled":"no"}]}']){
  writeFileSync(path,content);assert.throws(()=>store.readPolicy());assert.throws(()=>store.setEnabled('future-skill',true));assert.equal(readFileSync(path,'utf8'),content);
 }
 for(const id of ['../bad','/absolute','UPPER','encoded%2f'])assert.throws(()=>store.setEnabled(id,true),/INVALID_POLICY_ARGUMENTS/);
});
test('policy IO refuses soft/hard links without changing the target',t=>{
 for(const kind of ['soft','hard']){
  const {root,store}=fixture(t);const target=join(root,'outside.json'),path=join(root,'skills-index.json');const content='{"version":1,"skills":[]}';writeFileSync(target,content);
  if(kind==='soft')symlinkSync(target,path);else linkSync(target,path);
  assert.throws(()=>store.readPolicy(),/UNSAFE_FILE/);assert.throws(()=>store.setEnabled('four',false),/UNSAFE_FILE/);assert.equal(readFileSync(target,'utf8'),content);
 }
});
