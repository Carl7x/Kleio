import { randomBytes } from 'node:crypto';
import type { ContextScope } from '../context-contracts/context.ts';
import type { EffectiveToolSet } from '../context-contracts/tools.ts';
import type { CatalogMetadata, ContextBudget, ContextHistoryGroup, ContextManifestEntry } from '../context-contracts/bundle.ts';
import type { ContextResource, ResourcePage, ResourceReference } from '../context-contracts/resources.ts';
import { SkillStore } from '../product-context/skill-store.ts';
import { digest, freeze, type SkillCatalogSnapshot } from '../product-context/skill-catalog.ts';
import { canonicalResourceJson, ResourceLedger } from './resource-ledger.ts';
const STANDING = ['IDENTITY.md','SOUL.md','USER.md','TOOLS.md','AGENTS.md'] as const;
type StandingName = typeof STANDING[number];
export interface ExecutionResourcesOptions {
  readonly scope: ContextScope; readonly effectiveTools: EffectiveToolSet; readonly skillStore: SkillStore;
  readonly standing: readonly {readonly name:StandingName;readonly text:string;readonly sourceVersion:string}[];
  readonly redact: (text:string)=>string; readonly history: readonly ContextHistoryGroup[];
}
export interface PublishedSkill extends CatalogMetadata {
  readonly requiresTools: readonly string[];
  readonly toolBindings: Readonly<Record<string,string>>;
  readonly bindingAvailability: Readonly<Record<string,boolean>>;
}
export interface SkillsListPage { readonly kind:'skills-list'; readonly sourceVersion:string; readonly entries:readonly PublishedSkill[]; readonly nextCursor:string|null; readonly complete:boolean }
function fail(code:string):never { throw new Error(code); }
function inputObject(value:unknown, keys:readonly string[]):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(x=>!keys.includes(x)))fail('INVALID_RESOURCE_ARGUMENTS');
  return value as Record<string,unknown>;
}
function string(value:unknown):string { if(typeof value!=='string'||!value)fail('INVALID_RESOURCE_ARGUMENTS');return value; }
function optionalString(value:unknown):string|undefined {return value===undefined?undefined:string(value);}
/** One trusted execution owns one catalog, one resource ledger and all opaque cursors. */
export class ExecutionResources {
  readonly #scope:ContextScope; readonly #store:SkillStore; readonly #snapshot:SkillCatalogSnapshot;
  readonly #redact:(text:string)=>string;
  readonly #catalog: {readonly entries:readonly PublishedSkill[];readonly sourceVersion:string;readonly diagnostics:readonly unknown[]};
  readonly #skills=new Map<string,{skillId:string;version:string}>();
  readonly #contexts=new Map<string,ContextResource>();
  readonly #history:readonly {sourceRef:string;sourceVersion:string;originalSourceRef:string}[];
  readonly #listCursors=new Map<string,{query:string;offset:number}>();
  #ledger:ResourceLedger|undefined; #closed=false; #selected=false;
  constructor(options:ExecutionResourcesOptions) {
    this.#scope=freeze(structuredClone(options.scope));this.#store=options.skillStore;this.#redact=options.redact;
    this.#snapshot=this.#store.capture(this.#scope,options.effectiveTools);
    try {
    const available=new Set(options.effectiveTools.tools.map(x=>x.name));
    const entries=this.#snapshot.skills.filter(skill=>this.#redact(skill.skillId)===skill.skillId).map(skill=>{
      const id=skill.skillId;
      this.#skills.set(id,{skillId:skill.skillId,version:skill.skillVersion});
      return freeze({id,sourceRef:`skill:${id}`,sourceVersion:skill.skillVersion,name:this.#redact(skill.name),description:this.#redact(skill.description),requiresTools:this.#sanitize(skill.requiresTools),toolBindings:this.#sanitize(skill.toolBindings),bindingAvailability:Object.fromEntries(Object.entries(skill.toolBindings).map(([alias,target])=>[this.#redact(alias),available.has(target)]))});
    });
    const diagnostics=[...this.#sanitize(this.#snapshot.diagnostics),...this.#snapshot.skills.filter(skill=>this.#redact(skill.skillId)!==skill.skillId).map(()=>({code:'REDACTED_SKILL_IDENTIFIER'}))];
    this.#catalog=freeze({entries,sourceVersion:digest(canonicalResourceJson({entries,diagnostics})),diagnostics});
    for(const file of options.standing) {
      if(!STANDING.includes(file.name))fail('INVALID_CONTEXT_SOURCE');
      const sourceRef=`standing/${file.name}`;this.#register({sourceRef,sourceVersion:file.sourceVersion,text:file.text,metadata:{kind:'standing',name:file.name}});
    }
    const history: {sourceRef:string;sourceVersion:string;originalSourceRef:string}[]=[];
    for(const group of options.history) {
      if(!group.sourceRef||group.sourceRef==='history-index'||group.sourceRef.startsWith('standing/'))fail('INVALID_CONTEXT_SOURCE');
      const ref=this.#redact(group.sourceRef)===group.sourceRef?group.sourceRef:`history:${digest(group.sourceRef)}`;
      const stored=this.#register({sourceRef:ref,sourceVersion:group.sourceVersion,text:canonicalResourceJson(group.messages),metadata:{kind:'history',messageCount:group.messages.length}});
      history.push({sourceRef:ref,sourceVersion:stored.sourceVersion,originalSourceRef:group.sourceRef});
    }
    this.#history=freeze(history);
    } catch(error) {
      this.#store.release(this.#snapshot);this.#contexts.clear();this.#skills.clear();throw error;
    }
  }
  get catalog(){this.#assert();return this.#catalog;}
  get ledger():ResourceLedger {this.#assert();if(!this.#ledger)fail('RESOURCE_BUDGET_NOT_INITIALIZED');return this.#ledger;}
  /** Selection facts are frozen once; the original groups remain readable in full. */
  setHistorySelection(manifest:readonly ContextManifestEntry[]):void {
    this.#assert();if(this.#selected||this.#ledger)fail('HISTORY_SELECTION_ALREADY_SET');
    const included=new Set(manifest.filter(x=>x.kind==='history'&&x.included).map(x=>x.sourceRef));
    const entries=this.#history.map(x=>({sourceRef:x.sourceRef,sourceVersion:x.sourceVersion,originallyIncluded:included.has(x.originalSourceRef)}));
    this.#register({sourceRef:'history-index',sourceVersion:digest(canonicalResourceJson(entries)),text:'',metadata:{kind:'history-index',entries}});this.#selected=true;
  }
  initializeBudget(budget:ContextBudget):void {
    this.#assert();if(this.#ledger)fail('RESOURCE_BUDGET_ALREADY_INITIALIZED');if(!this.#selected)fail('HISTORY_SELECTION_REQUIRED');
    this.#ledger=new ResourceLedger({scopeId:this.#scope.scopeId,executionId:this.#scope.executionId,inputLimitTokens:budget.inputBudget,initialOccupiedTokens:budget.estimatedInputTokens});
  }
  skillsList(args:unknown={}):SkillsListPage {
    this.#assert();const input=inputObject(args,['query','cursor']);const query=(optionalString(input.query)??'').toLocaleLowerCase();const cursor=optionalString(input.cursor);
    if(query.length>1024)fail('INVALID_RESOURCE_ARGUMENTS');
    let offset=0;if(cursor){const state=this.#listCursors.get(cursor);if(!state||state.query!==query)fail('INVALID_CATALOG_CURSOR');offset=state.offset;}
    const matching=this.#catalog.entries.filter(x=>!query||[x.id,x.name,x.description].some(v=>v.toLocaleLowerCase().includes(query)));
    const entries:PublishedSkill[]=[];let nextCursor:string|null=null;
    while(offset<matching.length){
      const candidate=matching[offset]!;const tentative={kind:'skills-list',sourceVersion:this.#catalog.sourceVersion,entries:[...entries,candidate],nextCursor:'x'.repeat(48),complete:false};
      if(Buffer.byteLength(JSON.stringify(tentative))>4096){if(!entries.length)fail('CATALOG_ENTRY_TOO_LARGE');break;}
      entries.push(candidate);offset++;
    }
    if(offset<matching.length){nextCursor=randomBytes(24).toString('hex');this.#listCursors.set(nextCursor,{query,offset});}
    return freeze({kind:'skills-list',sourceVersion:this.#catalog.sourceVersion,entries,nextCursor,complete:nextCursor===null});
  }
  skillRead(args:unknown):ResourcePage|ResourceReference {
    this.#assert();const input=inputObject(args,['skillId','expectedVersion','resource','cursor']);
    const id=string(input.skillId),version=string(input.expectedVersion),resource=optionalString(input.resource),cursor=optionalString(input.cursor);
    const skill=this.#skills.get(id);if(!skill)fail('SKILL_UNAVAILABLE');if(skill.version!==version)fail('STALE_RESOURCE');
    const read=this.#store.readResource(this.#snapshot,skill.skillId,version,resource);
    if([read.metadata.resource,...read.metadata.relatedResources.map(x=>x.resource)].some(x=>this.#redact(x)!==x))fail('RESOURCE_REDACTED_IDENTIFIER');
    return this.ledger.read({sourceRef:`skill:${id}/${read.metadata.resource}`,sourceVersion:digest(canonicalResourceJson(this.#sanitize({text:read.text,metadata:read.metadata}))),text:this.#redact(read.text),metadata:this.#sanitize(read.metadata)},this.#binding(cursor));
  }
  contextRead(args:unknown):ResourcePage|ResourceReference {
    this.#assert();const input=inputObject(args,['sourceRef','cursor']);const resource=this.#contexts.get(string(input.sourceRef));if(!resource)fail('INVALID_CONTEXT_SOURCE');
    return this.ledger.read(resource,this.#binding(optionalString(input.cursor)));
  }
  close():void {if(this.#closed)return;this.#closed=true;this.#ledger?.close();this.#store.release(this.#snapshot);this.#contexts.clear();this.#skills.clear();this.#listCursors.clear();}
  #binding(cursor?:string){return {scopeId:this.#scope.scopeId,executionId:this.#scope.executionId,...(cursor!==undefined?{cursor}:{})};}
  #assert(){if(this.#closed)fail('EXECUTION_RESOURCES_CLOSED');}
  #sanitize<T>(value:T):T {
    if(typeof value==='string')return this.#redact(value) as T;
    if(Array.isArray(value))return value.map(x=>this.#sanitize(x)) as T;
    if(value&&typeof value==='object'){
      const entries=Object.entries(value).map(([key,item])=>[this.#redact(key),this.#sanitize(item)] as const);
      if(new Set(entries.map(x=>x[0])).size!==entries.length)fail('REDACTED_METADATA_COLLISION');
      return Object.fromEntries(entries) as T;
    }
    return value;
  }
  #register(resource:ContextResource){
    if(this.#contexts.has(resource.sourceRef))fail('DUPLICATE_CONTEXT_SOURCE');
    const text=this.#redact(resource.text),metadata=this.#sanitize(resource.metadata);
    const stored=freeze({...resource,text,metadata,sourceVersion:digest(canonicalResourceJson({text,metadata}))});
    this.#contexts.set(resource.sourceRef,stored);return stored;
  }
}
