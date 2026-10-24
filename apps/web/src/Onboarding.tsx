import React,{useEffect,useState} from 'react';
import {proposeOnboardingPlan} from './onboarding-plan';
import {ConnectBrowser} from '../../../packages/sdk/src/browser';

type Row=Record<string,any>;
const stateLabels:Record<string,string>={pending:'In attesa',approved:'Approvata',migrating:'Migrazione in corso',completed:'Completata',rejected:'Rifiutata',expired:'Scaduta',failed:'Da verificare'};
const stateColor:Record<string,string>={pending:'amber',approved:'blue',migrating:'amber',completed:'green',rejected:'red',expired:'red',failed:'red'};
const date=(value:any)=>value?new Date(value).toLocaleString('it-IT'):'—';
const lines=(value:string)=>value.split(',').map(v=>v.trim()).filter(Boolean);
const catalogState=(detail:Row)=>detail.installation?.catalogVersion?`Sincronizzato · v${detail.installation.catalogVersion}`:detail.source?.catalogUrl?'Da sincronizzare con la preparazione':'URL catalogo mancante';

function friendlyError(error:unknown){
 const message=(error as Error).message||'Operazione non riuscita.';
 try{const parsed=JSON.parse(message);if(parsed.fieldErrors){const names:Row={id:'ID sorgente',name:'Nome',appId:'Applicazione',origins:'Origini',deploymentIdentity:'Identità deployment'};return 'Controlla i campi: '+Object.keys(parsed.fieldErrors).map(k=>names[k]||k).join(', ')+'.';}}catch{}
 return message;
}

function Status({value}:{value:string}){return <span className={`badge ${stateColor[value]||'blue'}`}><span className="dot"/>{stateLabels[value]||value}</span>;}

export function Onboarding({sdk}:{sdk:ConnectBrowser}){
 const [practices,setPractices]=useState<Row[]>([]),[sources,setSources]=useState<Row[]>([]),[presenters,setPresenters]=useState<Row[]>([]),[applications,setApplications]=useState<Row[]>([]);
 const [presenterForm,setPresenterForm]=useState({name:'',deploymentIdentity:'',verifiedOrigins:'',verifiedAppId:'',expiresAt:new Date(Date.now()+7*86400000).toISOString().slice(0,16)}),[verifiedPresenter,setVerifiedPresenter]=useState(false);
 const [detail,setDetail]=useState<Row|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [identityLinks,setIdentityLinks]=useState<Record<string,string>>({}),[identities,setIdentities]=useState<Row[]>([]);
 const [search,setSearch]=useState(''),[filter,setFilter]=useState('open'),[quick,setQuick]=useState('');
 const [resolution,setResolution]=useState(false),[resolutionFunctions,setResolutionFunctions]=useState<Row[]>([]);
 const [savedPlanText,setSavedPlanText]=useState(''),[planText,setPlanText]=useState(''),[reason,setReason]=useState('');
 const [activationTenant,setActivationTenant]=useState(''),[activationUser,setActivationUser]=useState(''),[activationRole,setActivationRole]=useState('owner');
 const [sourceForm,setSourceForm]=useState({id:'',appId:'',name:'',environment:'development',origins:'',catalogUrl:'',oidcCallbacks:'',deploymentIdentity:''});
 const [secret,setSecret]=useState('');
 const [binding,setBinding]=useState({sourceId:'',installationId:''});
 const [localUser,setLocalUser]=useState({sourceId:'',installationId:'',localTenantId:'',localUserId:'',subject:'',email:'',firstName:'',lastName:'',role:'owner',permissions:'',enabled:true});

 async function act(fn:()=>Promise<unknown>,success='Operazione completata.'){
  setBusy(true);setError('');
  try{await fn();if(success)setNotice(success);}catch(e){setError(friendlyError(e));}finally{setBusy(false);}
 }
 async function load(){
  await act(async()=>{
   const [practiceList,sourceList,presenterList,applicationList]=await Promise.all([sdk.request<Row[]>('/v1/onboarding/practices'),sdk.request<Row[]>('/v1/connect-sources'),sdk.request<Row[]>('/v1/onboarding/presenters'),sdk.request<Row[]>('/v1/applications')]);
   setPresenters(presenterList);setApplications(applicationList);
   setPractices(practiceList);setSources(sourceList);
   if(detail)await open(detail.id,false);
  },'');
 }
 async function refreshPractices(){setPractices(await sdk.request<Row[]>('/v1/onboarding/practices'));}
 async function open(id:string,clearNotice=true){
  await act(async()=>{
   const value=await sdk.request<Row>('/v1/onboarding/practices/'+encodeURIComponent(id));
   setIdentityLinks(Object.fromEntries((value.requests||[]).map((r:Row)=>[r.id,value.plan?.identities?.[r.id]||r.identitySubject||''])));
   let proposed=proposeOnboardingPlan(value);
   const appId=proposed.application?.id;
   if(!value.plan?.license&&appId&&(value.review?.applications||[]).some((a:Row)=>a.id===appId)){
    try{const catalogs=await sdk.request<Row[]>('/v1/applications/'+encodeURIComponent(appId)+'/catalogs');proposed=proposeOnboardingPlan(value,catalogs[0]?.document);}catch{/* Catalog unavailable: no invented feature mapping. */}
   }
   setResolution(false);setDetail(value);setSavedPlanText(JSON.stringify(value.plan||{},null,2));setPlanText(JSON.stringify(proposed,null,2));
   setActivationTenant(value.plan?.activation?.localTenantId||value.tenant?.localId||'');
   setActivationUser(value.plan?.activation?.localUserId||'');
   setActivationRole(value.plan?.activation?.localRole||'owner');
   setReason('');
   if(clearNotice)setNotice('');
  },'');
 }
 useEffect(()=>{void load();},[]);

 function savePlan(){
  if(!detail)return;
  let plan:Row;
  try{plan=planText.trim()?JSON.parse(planText):{roles:[]};}catch{setError('Piano non valido: correggi il JSON prima di salvare.');return;}
  if(plan.application?.mode==='create'&&!/^[a-z][a-z0-9_.:-]{0,79}$/.test(plan.application.id)){setError('ID app non valido: usa lettere minuscole, numeri, punti o trattini. Il nome può contenere maiuscole.');return;}
  if(plan.sso&&!Object.values(plan.sso).some(Boolean))delete plan.sso;
  else if(plan.sso&&(!plan.sso.issuer||!plan.sso.clientId||!plan.sso.redirectUri)){setError('Completa issuer, client ID e callback SSO oppure svuota i campi: SSO si configura separatamente dopo la verifica del provider.');return;}
  if(detail.kind==='activation')plan.activation={localTenantId:activationTenant,localUserId:activationUser,localRole:activationRole};
  const overrides:Row={};
  for(const request of detail.requests||[]){
   const subject=identityLinks[request.id]?.trim();
   if(subject)overrides[request.id]=subject;
  }
  plan.identities=overrides;
  void act(async()=>{await sdk.request('/v1/onboarding/practices/'+detail.id+'/plan','PUT',plan);await open(detail.id,false);await refreshPractices();},'Piano salvato.');
 }
 async function execute(){
  if(!detail)return;
  setBusy(true);setError('');
  try{const result=await sdk.request<Row>('/v1/onboarding/practices/'+detail.id+'/execute','POST',{});setDetail(result);setSavedPlanText(JSON.stringify(result.plan||{},null,2));setPlanText(JSON.stringify(result.plan||{},null,2));await refreshPractices();setNotice(result.state==='completed'?'Migrazione completata.':'Esecuzione terminata: verifica lo stato delle richieste.');}
  catch(e){setError(friendlyError(e));await open(detail.id,false);}finally{setBusy(false);}
 }
 async function prepare(){
  if(!detail)return;
  await act(async()=>{await sdk.request('/v1/onboarding/practices/'+detail.id+'/prepare','POST',{});await open(detail.id,false);await refreshPractices();},'Prerequisiti verificati.');
 }
 async function resolve(){
  if(!detail)return;
  await act(async()=>{
   const result=await sdk.request<Row>('/v1/onboarding/practices/'+detail.id+'/resolution');
   setPlanText(JSON.stringify(result.plan,null,2));setIdentities(result.identities||[]);setResolutionFunctions(result.functions||[]);
   setIdentityLinks(Object.fromEntries((detail.requests||[]).map((r:Row)=>[r.id,result.plan.identities?.[r.id]||r.identitySubject||''])));
   setResolution(true);
  },'');
 }
 async function applyResolution(){
  if(!detail)return;
  await act(async()=>{
   const plan=JSON.parse(planText);
   plan.identities=Object.fromEntries(Object.entries(identityLinks).filter(([,subject])=>subject));
   try{
    const result=await sdk.request<Row>('/v1/onboarding/practices/'+detail.id+'/resolve','POST',plan);
    await open(detail.id,false);await refreshPractices();
    if(result.state!=='completed')throw Error(result.safeError||'La risoluzione richiede un intervento: consulta il dettaglio della pratica.');
   }catch(e){await open(detail.id,false);throw e;}
  },'Pratica risolta: migrazione completata.');
 }
 async function reject(id:string){
  if(!reason.trim()){setError('Indica il motivo del rifiuto.');return;}
  await act(async()=>{await sdk.request('/v1/onboarding/practices/'+id+'/reject','POST',{reason:reason.trim()});await load();if(detail?.id===id)await open(id,false);},'Pratica rifiutata e credenziali transitorie cancellate.');
 }

 function patchPlan(patch:Row){try{setPlanText(JSON.stringify({...JSON.parse(planText||'{}'),...patch},null,2));setError('');}catch{setError('Correggi prima il piano JSON.');}}
 let draft:Row={};try{draft=JSON.parse(planText||'{}');}catch{}
 const differences:Record<string,string>={app_id_differs:'L’app verificata differisce dall’app dichiarata.',name_differs:'Il nome dichiarato differisce dal nome dell’app.',catalog_url_differs:'L’URL catalogo dichiarato differisce da quello dell’app.',declared_app_unverified:'L’app dichiarata esiste, ma la provenienza non ne prova il collegamento.'};
 const unsaved=planText!==savedPlanText;
 const closed=!!detail&&['completed','rejected','expired','migrating'].includes(detail.state);
 const visible=practices.filter(p=>(filter==='all'||(filter==='open'?!['completed','rejected','expired'].includes(p.state):p.state===filter))&&[p.tenantName,p.appId,p.sourceId].join(' ').toLowerCase().includes(search.toLowerCase()));
 const roles=[...new Set<string>((detail?.requests||[]).map((r:Row)=>r.role||activationRole))];
 function setRole(role:string,patch:Row){const current=(draft.roles||[]).find((r:Row)=>r.localRole===role)||{localRole:role,roleName:'',permissions:[]};patchPlan({roles:[...(draft.roles||[]).filter((r:Row)=>r.localRole!==role),{...current,...patch}]});}
 return <section className="card onboarding-panel">
  {error&&<div className="error" role="alert">{error}</div>}
  {notice&&<div className="success" role="status" onClick={()=>setNotice('')}>{notice}</div>}
  {secret&&<div className="notice"><strong>Segreto mostrato una sola volta: trasferiscilo al backend.</strong><pre className="code">{secret}</pre><button className="btn" onClick={()=>setSecret('')}>Nascondi segreto</button></div>}
  <header className="migration-toolbar"><div><h2>Pratiche di migrazione <span className="migration-count">{practices.length}</span></h2><p>Seleziona una richiesta, completa il piano e abilita l’accesso.</p></div><div className="row"><button className="btn" disabled={busy} onClick={()=>void load()}>Aggiorna</button><label className="migration-quick"><span className="sr-only">Creazioni rapide</span><select aria-label="Creazioni rapide" value={quick} onChange={e=>setQuick(e.target.value)}><option value="">＋ Creazioni rapide</option><option value="presenter">Credenziale per nuova richiesta</option><option value="source">Sorgenti di deployment</option><option value="links">Collegamenti e accessi locali</option></select></label></div></header>
  {quick==='presenter'&&<div className="migration-quick-panel">
   <button className="text-button migration-close" onClick={()=>setQuick('')}>Chiudi</button><h2>Credenziali tecniche per presentare una pratica</h2>
   <p className="tiny">Non richiedono app, cliente, licenza o client OIDC esistenti. Non autorizzano SSO. Consegnare il segreto soltanto al backend verificato: il primo utilizzo vincola la credenziale a un sourceId, che altri deployment non possono assumere.</p>
   <div className="field-grid">
    <label className="field">Nome credenziale<input value={presenterForm.name} onChange={e=>setPresenterForm({...presenterForm,name:e.target.value})}/></label>
    <label className="field">Deployment verificato<input value={presenterForm.deploymentIdentity} onChange={e=>setPresenterForm({...presenterForm,deploymentIdentity:e.target.value})}/></label>
    <label className="field">Origini verificate (facoltative)<input value={presenterForm.verifiedOrigins} onChange={e=>setPresenterForm({...presenterForm,verifiedOrigins:e.target.value})}/></label>
    <label className="field">App verificata (facoltativa)<select value={presenterForm.verifiedAppId} onChange={e=>setPresenterForm({...presenterForm,verifiedAppId:e.target.value})}><option value="">Nessuna attestazione app</option>{applications.map(a=><option key={a.id} value={a.id}>{a.name} · {a.id}</option>)}</select></label>
    <label className="field">Scadenza<input type="datetime-local" value={presenterForm.expiresAt} onChange={e=>setPresenterForm({...presenterForm,expiresAt:e.target.value})}/></label>
   </div>
   <label className="tiny"><input type="checkbox" checked={verifiedPresenter} onChange={e=>setVerifiedPresenter(e.target.checked)}/> Ho verificato l’identità del deployment e le eventuali attestazioni di app/origini.</label>
   <div className="row mt"><button className="btn primary" disabled={busy||!verifiedPresenter||!presenterForm.name.trim()||!presenterForm.deploymentIdentity.trim()||!presenterForm.expiresAt} onClick={()=>void act(async()=>{const r=await sdk.request<Row>('/v1/onboarding/presenters','POST',{name:presenterForm.name,deploymentIdentity:presenterForm.deploymentIdentity,verifiedOrigins:lines(presenterForm.verifiedOrigins),...(presenterForm.verifiedAppId?{verifiedAppId:presenterForm.verifiedAppId}:{}),expiresAt:new Date(presenterForm.expiresAt).toISOString()});setSecret(JSON.stringify({presenterId:r.id,secret:r.secret,expiresAt:r.expiresAt}));setVerifiedPresenter(false);await load();},'Credenziale tecnica emessa. Nessuna integrazione approvata.')}>Emetti credenziale tecnica</button></div>
   <div className="table-wrap mt"><table><thead><tr><th>Deployment</th><th>App verificata</th><th>Source riservata</th><th>Scadenza</th><th>Stato</th><th></th></tr></thead><tbody>{presenters.map(p=><tr key={p.id}><td>{p.name}<small className="feature-desc">{p.deployment_identity}</small></td><td>{p.verified_app_id||'Da valutare nella pratica'}</td><td>{p.bound_source_id||'Primo utilizzo in attesa'}</td><td>{date(p.expires_at)}</td><td>{p.enabled?'Attiva':'Revocata'}</td><td><button className="btn" disabled={busy||!p.enabled} onClick={()=>void act(async()=>{const r=await sdk.request<Row>('/v1/onboarding/presenters/'+p.id,'PUT',{rotateSecret:true});setSecret(JSON.stringify({presenterId:p.id,secret:r.secret}));},'Credenziale ruotata: aggiorna solo il backend verificato.')}>Ruota segreto</button><button className="btn" disabled={busy||!p.enabled} onClick={()=>void act(async()=>{await sdk.request('/v1/onboarding/presenters/'+p.id,'PUT',{enabled:false});await load();},'Credenziale tecnica revocata.')}>Revoca</button></td></tr>)}</tbody></table></div>
  </div>}

  {quick==='source'&&<div className="migration-quick-panel">
   <button className="text-button migration-close" onClick={()=>setQuick('')}>Chiudi</button><h2>Sorgenti di deployment</h2>
   <p className="tiny">La sorgente è registrata da EULAB prima che esistano app, cliente o installazione. Il segreto bootstrap è mostrato una sola volta e non viene mai salvato in chiaro.</p>
   <div className="table-wrap"><table>
    <thead><tr><th>Identificativo</th><th>App</th><th>Ambiente</th><th>Origini</th><th>Catalogo</th><th>Stato</th><th></th></tr></thead>
    <tbody>{sources.map(s=><tr key={s.id}>
     <td className="title-cell">{s.id}<small>{s.deployment_identity}</small></td>
     <td>{s.app_id}</td>
     <td>{s.environment}</td>
     <td className="feature-code">{(s.origins||[]).join(', ')}</td>
     <td className="feature-code">{s.catalog_url||'—'}</td>
     <td><span className={`badge ${!s.enabled?'red':s.integration_approved===false?'amber':'green'}`}><span className="dot"/>{!s.enabled?'Sospesa':s.integration_approved===false?'Solo presentazione':'Registrata'}</span></td>
     <td><button className="btn" disabled={busy||!!s.presenter_id} onClick={()=>void act(async()=>{const r=await sdk.request<Row>('/v1/connect-sources/'+s.id,'PUT',{rotateSecret:true});setSecret(JSON.stringify({sourceId:s.id,secret:r.secret}));},'Segreto ruotato: aggiorna il backend della sorgente.')}>Ruota segreto</button></td>
    </tr>)}</tbody>
   </table></div>
   <div className="row"><h3>Registra sorgente</h3></div>
   <div className="field-grid">
    <label className="field">ID sorgente<input value={sourceForm.id} onChange={e=>setSourceForm({...sourceForm,id:e.target.value})}/></label>
    <label className="field">App ID<input value={sourceForm.appId} onChange={e=>setSourceForm({...sourceForm,appId:e.target.value})}/></label>
    <label className="field">Nome<input value={sourceForm.name} onChange={e=>setSourceForm({...sourceForm,name:e.target.value})}/></label>
    <label className="field">Ambiente<select value={sourceForm.environment} onChange={e=>setSourceForm({...sourceForm,environment:e.target.value})}><option value="development">Development</option><option value="staging">Staging</option><option value="production">Production</option></select></label>
    <label className="field">Origini (separate da virgola)<input value={sourceForm.origins} onChange={e=>setSourceForm({...sourceForm,origins:e.target.value})} placeholder="https://app.example"/></label>
    <label className="field">URL catalogo<input value={sourceForm.catalogUrl} onChange={e=>setSourceForm({...sourceForm,catalogUrl:e.target.value})} placeholder="https://app.example/.well-known/eulab-connect.json"/></label>
    <label className="field">Callback OIDC<input value={sourceForm.oidcCallbacks} onChange={e=>setSourceForm({...sourceForm,oidcCallbacks:e.target.value})} placeholder="https://app.example/oauth/callback"/></label>
    <label className="field">Identità deployment<input value={sourceForm.deploymentIdentity} onChange={e=>setSourceForm({...sourceForm,deploymentIdentity:e.target.value})} placeholder="alora-produzione"/></label>
   </div>
   <button className="btn primary" disabled={busy||!sourceForm.id.trim()||!sourceForm.appId.trim()||!sourceForm.name.trim()||!lines(sourceForm.origins).length||!sourceForm.deploymentIdentity.trim()} onClick={()=>void act(async()=>{
    const body={id:sourceForm.id,appId:sourceForm.appId,name:sourceForm.name,environment:sourceForm.environment,origins:lines(sourceForm.origins),...(sourceForm.catalogUrl?{catalogUrl:sourceForm.catalogUrl}:{}),oidcCallbacks:lines(sourceForm.oidcCallbacks),deploymentIdentity:sourceForm.deploymentIdentity};
    const r=await sdk.request<Row>('/v1/connect-sources','POST',body);setSecret(JSON.stringify({sourceId:r.id,secret:r.secret}));await load();
   },'Sorgente registrata: conserva il segreto bootstrap una sola volta.')}>Registra sorgente</button>
  </div>}

  {quick==='links'&&<div className="migration-quick-panel">
   <button className="text-button migration-close" onClick={()=>setQuick('')}>Chiudi</button><h2>Collegamenti espliciti</h2>
   <div className="field-grid">
    <label className="field">Sorgente<select value={binding.sourceId} onChange={e=>setBinding({...binding,sourceId:e.target.value})}><option value="">Seleziona</option>{sources.map(s=><option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
    <label className="field">Installazione<input value={binding.installationId} onChange={e=>setBinding({...binding,installationId:e.target.value})} placeholder="uuid installazione"/></label>
   </div>
   <button className="btn" disabled={busy||!binding.sourceId||!binding.installationId} onClick={()=>void act(async()=>{await sdk.request('/v1/connect-sources/'+binding.sourceId+'/installations','POST',{installationId:binding.installationId});await load();},'Installazione collegata alla sorgente.')}>Collega installazione</button>
   <div className="row mt"><h3>Preassegna accesso locale</h3></div>
   <div className="field-grid">
    <label className="field">Sorgente<select value={localUser.sourceId} onChange={e=>setLocalUser({...localUser,sourceId:e.target.value})}><option value="">Seleziona</option>{sources.map(s=><option key={s.id} value={s.id}>{s.id}</option>)}</select></label>
    <label className="field">Installazione<input value={localUser.installationId} onChange={e=>setLocalUser({...localUser,installationId:e.target.value})}/></label>
    <label className="field">Azienda locale<input value={localUser.localTenantId} onChange={e=>setLocalUser({...localUser,localTenantId:e.target.value})}/></label>
    <label className="field">Utente locale<input value={localUser.localUserId} onChange={e=>setLocalUser({...localUser,localUserId:e.target.value})}/></label>
    <label className="field">Subject Connect<input value={localUser.subject} onChange={e=>setLocalUser({...localUser,subject:e.target.value})}/></label>
    <label className="field">Email<input type="email" value={localUser.email} onChange={e=>setLocalUser({...localUser,email:e.target.value})}/></label>
    <label className="field">Nome<input value={localUser.firstName} onChange={e=>setLocalUser({...localUser,firstName:e.target.value})}/></label>
    <label className="field">Cognome<input value={localUser.lastName} onChange={e=>setLocalUser({...localUser,lastName:e.target.value})}/></label>
    <label className="field">Ruolo locale<select value={localUser.role} onChange={e=>setLocalUser({...localUser,role:e.target.value})}>{['owner','manager','reception','collaborator'].map(r=><option key={r} value={r}>{r}</option>)}</select></label>
    <label className="field">Permessi (separati da virgola)<input value={localUser.permissions} onChange={e=>setLocalUser({...localUser,permissions:e.target.value})}/></label>
   </div>
   <button className="btn primary" disabled={busy||!localUser.sourceId} onClick={()=>void act(async()=>{
    await sdk.request('/v1/connect-sources/'+localUser.sourceId+'/local-users','POST',{installationId:localUser.installationId,localTenantId:localUser.localTenantId,localUserId:localUser.localUserId,subject:localUser.subject,email:localUser.email,firstName:localUser.firstName,lastName:localUser.lastName,role:localUser.role,permissions:lines(localUser.permissions),enabled:localUser.enabled});
    await load();
   },'Accesso locale preassegnato: nessun ruolo viene concesso automaticamente.')}>Preassegna accesso</button>
  </div>}
  <div className="migration-list">
   <div className="migration-filters"><input aria-label="Cerca pratica" placeholder="Cerca azienda, app o deployment…" value={search} onChange={e=>setSearch(e.target.value)}/><select aria-label="Filtra pratiche" value={filter} onChange={e=>setFilter(e.target.value)}><option value="open">Da completare</option><option value="all">Tutte le pratiche</option><option value="completed">Completate</option><option value="rejected">Rifiutate</option><option value="expired">Scadute</option></select></div>
   {!visible.length?<div className="empty">Nessuna pratica di attivazione o migrazione.</div>:<div className="table-wrap"><table>
    <thead><tr><th>Deployment</th><th>Azienda locale</th><th>Tipo</th><th>Stato</th><th>Richieste</th><th>Credenziali</th><th>Aggiornata</th><th></th></tr></thead>
    <tbody>{visible.map(p=><tr key={p.id} className={detail?.id===p.id?'migration-selected':''}>
     <td className="title-cell">{p.appId}</td>
     <td>{p.tenantName}<small className="feature-desc">{p.kind==='migration'?'Migrazione account locali':'Nuova attivazione'}</small></td>
     <td>{p.kind==='migration'?'Migrazione':'Attivazione'}</td>
     <td><Status value={p.state}/></td>
     <td>{p.completedCount}/{p.requestCount} completate</td>
     <td>{p.credentialCount?`${p.credentialCount} · scad. ${date(p.credentialExpiresAt)}`:'Nessuna'}</td>
     <td>{date(p.updatedAt)}</td>
     <td><button className="btn" disabled={busy} onClick={()=>void open(p.id)}>Apri pratica</button></td>
    </tr>)}</tbody>
   </table></div>}
  </div>

  {detail&&<div className="migration-detail" key={detail.id}>
   <div className="migration-block">
    <div className="migration-detail-heading"><div><span className="migration-eyebrow">PRATICA SELEZIONATA</span><h2>{detail.tenant?.name||detail.id}</h2></div><div className="row"><Status value={detail.state}/><button className="btn" onClick={()=>setDetail(null)}>Chiudi</button></div></div><details className="migration-disclosure"><summary>Provenienza e dettagli tecnici · {detail.source?.app_id}</summary>
    <div className="field-grid">
     <div><strong>Applicazione dichiarata</strong><div>{detail.source?.app_id||'—'}</div></div>
     <div><strong>Ambiente</strong><div>{detail.source?.environment||'—'}</div></div>
     <div><strong>URL dichiarati dal deployment</strong><div className="feature-code">{(detail.source?.origins||[]).join(', ')||'Non dichiarata'}</div></div>
     <div><strong>Origini attestate dall’amministrazione</strong><div>{(detail.source?.verified_origins||[]).join(', ')||'Nessuna attestazione tecnica'}</div></div>
     <div><strong>Identità deployment</strong><div>{detail.source?.deployment_identity||'—'}</div></div>
     <div><strong>Catalogo</strong><div>{catalogState(detail)}</div></div>
     <div><strong>Cliente Connect</strong><div className="feature-code">{detail.customerId||'Da preparare'}</div></div>
     <div><strong>Installazione</strong><div className="feature-code">{detail.installation?.id||'Da preparare'}</div></div>
     <div><strong>Dominio installazione</strong><div>{detail.installation?.domain||'—'}</div></div>
     <div><strong>Segreto server</strong><div>{detail.installation?.secretAvailable?'Disponibile':'Da ruotare'}</div></div>
    </div>
    <p className="tiny">Provenienza: {detail.source?.presenter_id?'credenziale tecnica autenticata; autorizzazione integrazione separata':'sorgente registrata da EULAB'}. Il solo appId o URL dichiarato non prova la proprietà.</p>
    </details>
    {!!detail.review?.differences?.length&&<div className="notice mt"><strong>Differenze da verificare</strong><ul>{detail.review.differences.map((key:string)=><li key={key}>{differences[key]||key}</li>)}</ul></div>}
    {detail.safeError&&(detail.plan||detail.safeError!=='Dati della pratica non validi')&&<div className="error mt" role="alert">Ultimo tentativo: {detail.safeError}</div>}
    {!!detail.plan&&!!detail.missing?.length&&<div className="notice mt"><strong>Da completare prima dell’esecuzione</strong><ul>{detail.missing.map((m:Row)=><li key={m.code}>{m.label}</li>)}</ul></div>}
   </div>

   <div className="migration-block">
    <details className="migration-disclosure"><summary>Persone e stato delle richieste</summary>
    <div className="row"><h3>Persone da abilitare</h3><button className="btn" disabled={busy||closed} onClick={()=>void act(async()=>{setIdentities(await sdk.request<Row[]>('/v1/sso-identities'));},'Utenti Connect caricati. Seleziona solo un’identità verificata.')}>Seleziona utenti Connect esistenti</button></div><p className="tiny">Le persone nuove saranno create dalla migrazione. Per una persona già presente su Connect indica il subject verificato: la sua password resta invariata.</p>
    <div className="table-wrap"><table>
     <thead><tr><th>Richiedente</th><th>Ruolo locale</th><th>Stato</th><th>Credenziale</th><th>Collegamento esplicito</th><th>Date</th><th>Errore sicuro</th></tr></thead>
     <tbody>{(detail.requests||[]).map((r:Row)=><tr key={r.id}>
      <td className="title-cell">{r.email}<small>{r.firstName} {r.lastName}</small><small className="feature-desc">Azienda locale: {r.localTenantId||detail.tenant?.localId||'Da assegnare'} · Persona locale: {r.localUserId||'Da assegnare'}</small></td>
      <td>{r.role||detail.plan?.activation?.localRole||'—'}<small className="feature-desc">{(r.permissions||[]).length+' permessi locali dichiarati'}</small></td>
      <td><Status value={r.state}/></td>
      <td>{r.credentialPresent?`Cifrata · scade ${date(r.credentialExpiresAt)}`:'Assente'}{r.credentialDestroyedAt&&<small className="feature-desc">Cancellata {date(r.credentialDestroyedAt)}</small>}</td>
      <td><select aria-label={'Identità Connect per '+r.email} disabled={busy||closed} value={identityLinks[r.id]||''} onChange={e=>setIdentityLinks({...identityLinks,[r.id]:e.target.value})}><option value="">Crea persona con la migrazione</option>{identityLinks[r.id]&&!identities.some(i=>i.subject===identityLinks[r.id])&&<option value={identityLinks[r.id]}>Identità collegata · {identityLinks[r.id]}</option>}{identities.map(i=><option key={i.subject} value={i.subject} disabled={!i.enabled}>{i.display_name||i.username} · {i.email}{!i.enabled?' · sospesa':''}</option>)}</select><small className="feature-desc">Collegamento scelto dall’amministratore</small></td>
      <td><small>Creata {date(r.createdAt)}<br/>Aggiornata {date(r.updatedAt)}</small></td>
      <td>{r.actionRequired&&<span className="badge amber"><span className="dot"/>{r.actionRequired}</span>}{r.safeError&&<small className="feature-desc">{r.safeError}</small>}{!r.actionRequired&&!r.safeError&&'—'}</td>
     </tr>)}</tbody>
    </table></div>
    </details>
   </div>

   <div className="migration-block">
    <h3>Piano integrazione</h3>
    <p>Risolvi pratica recupera il catalogo e prepara le operazioni. Scegli cosa creare e cosa collegare, poi conferma per applicare la migrazione.</p>
    <button className="btn primary" disabled={busy||closed} onClick={()=>void resolve()}>{busy?'Operazione in corso…':'Risolvi pratica'}</button>
    {resolution&&<div className="notice mt"><h3>Conferma le operazioni</h3><div className="field-grid">
     <label className="field">Applicazione da usare<select aria-label="Applicazione da usare" value={draft.application?.mode==='existing'?'existing:'+draft.application.id:'create'} onChange={e=>patchPlan({application:e.target.value==='create'?{mode:'create',id:detail.source.app_id,name:detail.source.name}:{mode:'existing',id:e.target.value.slice(9)}})}><option value="create">Crea {detail.source.app_id}</option>{(detail.review?.applications||[]).map((a:Row)=><option key={a.id} value={'existing:'+a.id}>Collega {a.name} · {a.id}</option>)}</select></label>
     <label className="field">Azienda cliente<select aria-label="Azienda cliente" value={draft.customer?.mode==='existing'?'existing:'+draft.customer.id:'create'} onChange={e=>patchPlan({customer:e.target.value==='create'?{mode:'create',name:detail.tenant.name}:{mode:'existing',id:e.target.value.slice(9)},installation:{mode:'create',domain:new URL(detail.source.catalogUrl).origin,basePath:''}})}><option value="create">Crea {detail.tenant.name}</option>{(detail.review?.customers||[]).map((c:Row)=><option key={c.id} value={'existing:'+c.id}>Collega {c.name}</option>)}</select></label>
     <label className="field">Installazione da usare<select aria-label="Installazione da usare" value={draft.installation?.mode==='existing'?'existing:'+draft.installation.id:'create'} onChange={e=>patchPlan({installation:e.target.value==='create'?{mode:'create',domain:new URL(detail.source.catalogUrl).origin,basePath:''}:{mode:'existing',id:e.target.value.slice(9)}})}><option value="create">Crea installazione per il deployment</option>{(detail.review?.installations||[]).filter((i:Row)=>i.app_id===draft.application?.id&&i.customer_id===draft.customer?.id).map((i:Row)=><option key={i.id} value={'existing:'+i.id}>Collega {i.domain}{i.base_path}</option>)}</select></label>
    </div>
    {(detail.requests||[]).filter((r:Row)=>!['completed','rejected','expired'].includes(r.state)).map((r:Row)=><label className="field mt" key={r.id}>Persona: {r.firstName} {r.lastName} · {r.email}<select aria-label={'Scelta utente '+r.email} value={identityLinks[r.id]||''} onChange={e=>setIdentityLinks({...identityLinks,[r.id]:e.target.value})}><option value="">Crea un nuovo utente Connect</option>{identities.filter(i=>i.user_type!=='admin').map(i=><option key={i.subject} value={i.subject} disabled={!i.enabled}>Collega {i.display_name||i.username} · {i.email}</option>)}</select></label>)}
    <p>{resolutionFunctions.length} {resolutionFunctions.length===1?'permesso recuperato':'permessi recuperati'} dal catalogo. Tutti selezionati per i nuovi ruoli; le restrizioni già salvate sono conservate.</p>
    <details><summary>Permessi recuperati</summary><ul>{resolutionFunctions.map((f:Row)=><li key={f.key}>{f.name} · {f.key}</li>)}</ul></details>
    <ol><li>Salva le scelte e configura SSO.</li><li>Crea o collega app, azienda e installazione.</li><li>Sincronizza catalogo e applica licenza e permessi.</li><li>Crea o collega gli utenti e completa la migrazione.</li></ol>
    <div className="row mt"><button className="btn primary" disabled={busy||closed} onClick={()=>void applyResolution()}>Conferma e applica migrazione</button><button className="btn" disabled={busy} onClick={()=>setResolution(false)}>Annulla</button></div></div>}
    <details className="migration-disclosure mt"><summary>Opzioni avanzate e piano manuale</summary>
    <p className="tiny">Le scelte salvate qui sono conservate dalla risoluzione automatica. Le modifiche manuali vanno salvate prima di risolvere.</p>
    {detail.review?.verifiedApplicationId&&<div className="notice">Corrispondenza verificata: {detail.review.verifiedApplicationId}. L’autoselezione prepara il piano, senza approvare l’accesso.</div>}
    <div className="migration-targets mt"><div className="migration-target"><h4>1. Applicazione</h4>
     <label className="field">Applicazione<select aria-label="Modalità applicazione" value={draft.application?.mode||''} disabled={closed||busy} onChange={e=>patchPlan({application:e.target.value?{mode:e.target.value,id:e.target.value==='create'?detail.source?.app_id||'':'',...(e.target.value==='create'?{name:detail.source?.name||detail.source?.app_id||''}:{})}:undefined})}><option value="">Seleziona azione</option><option value="existing">Collega app esistente</option><option value="create">Crea nuova app</option></select></label>
     {draft.application?.mode==='existing'&&<label className="field">App esistente<select aria-label="App esistente" value={draft.application.id} disabled={closed||busy} onChange={e=>patchPlan({application:{mode:'existing',id:e.target.value}})}><option value="">Seleziona</option>{(detail.review?.applications||[]).map((a:Row)=><option key={a.id} value={a.id}>{a.name} · {a.id}{a.id===detail.review?.verifiedApplicationId?' · verificata':''}</option>)}</select></label>}
     {draft.application?.mode==='create'&&<><label className="field">ID nuova app<input aria-label="ID nuova app" value={draft.application.id||''} disabled={closed||busy} onChange={e=>patchPlan({application:{...draft.application,id:e.target.value}})}/></label><label className="field">Nome nuova app<input aria-label="Nome nuova app" value={draft.application.name||''} disabled={closed||busy} onChange={e=>patchPlan({application:{...draft.application,name:e.target.value}})}/></label></>}
     </div><div className="migration-target"><h4>2. Cliente</h4><label className="field">Cliente<select aria-label="Modalità cliente" value={draft.customer?.mode||''} disabled={closed||busy} onChange={e=>patchPlan({customer:e.target.value?{mode:e.target.value,...(e.target.value==='existing'?{id:''}:{name:detail.tenant?.name||''})}:undefined})}><option value="">Seleziona azione</option><option value="existing">Collega cliente esistente</option><option value="create">Crea nuovo cliente</option></select></label>
     {draft.customer?.mode==='existing'&&<label className="field">Cliente esistente<select aria-label="Cliente esistente" value={draft.customer.id||''} disabled={closed||busy} onChange={e=>patchPlan({customer:{mode:'existing',id:e.target.value}})}><option value="">Seleziona</option>{(detail.review?.customers||[]).map((c:Row)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
     {draft.customer?.mode==='create'&&<label className="field">Nome nuovo cliente<input aria-label="Nome nuovo cliente" value={draft.customer.name||''} disabled={closed||busy} onChange={e=>patchPlan({customer:{...draft.customer,name:e.target.value}})}/></label>}
     </div><div className="migration-target"><h4>3. Installazione</h4><label className="field">Installazione<select aria-label="Modalità installazione" value={draft.installation?.mode||''} disabled={closed||busy} onChange={e=>patchPlan({installation:e.target.value?{mode:e.target.value,...(e.target.value==='existing'?{id:''}:{domain:detail.source?.origins?.[0]||'',basePath:''})}:undefined})}><option value="">Seleziona azione</option><option value="existing">Collega installazione esistente</option><option value="create">Crea nuova installazione</option></select></label>
     {draft.installation?.mode==='existing'&&<label className="field">Installazione esistente<select aria-label="Installazione esistente" value={draft.installation.id||''} disabled={closed||busy} onChange={e=>patchPlan({installation:{mode:'existing',id:e.target.value}})}><option value="">Seleziona</option>{(detail.review?.installations||[]).filter((i:Row)=>i.app_id===draft.application?.id&&i.customer_id===draft.customer?.id).map((i:Row)=><option key={i.id} value={i.id}>{i.domain}{i.base_path}{i.enabled?'':' · sospesa'}</option>)}</select></label>}
     {draft.installation?.mode==='create'&&<><label className="field">Origine installazione approvata<input aria-label="Origine installazione approvata" value={draft.installation.domain||''} disabled={closed||busy} onChange={e=>patchPlan({installation:{...draft.installation,domain:e.target.value}})}/></label><label className="field">Percorso installazione<input value={draft.installation.basePath||''} disabled={closed||busy} onChange={e=>patchPlan({installation:{...draft.installation,basePath:e.target.value}})}/></label></>}
    </div></div>
    <details className="mt"><summary>Configurazione SSO da consegnare al backend dopo il completamento</summary><p className="tiny">Questi dati non sono credenziali locali: provengono dal client registrato nel provider Connect. Se non sono ancora disponibili, lascia i campi vuoti. La richiesta non contiene issuer o segreti OIDC. I segreti sono cifrati e non vengono restituiti nel piano.</p><div className="field-grid">
     <label className="field">Issuer<input aria-label="Issuer SSO" value={draft.sso?.issuer||''} disabled={closed||busy} onChange={e=>patchPlan({sso:{...draft.sso,issuer:e.target.value}})}/></label>
     <label className="field">Client ID<input aria-label="Client ID SSO" value={draft.sso?.clientId||''} disabled={closed||busy} onChange={e=>patchPlan({sso:{...draft.sso,clientId:e.target.value}})}/></label>
     <label className="field">Callback<input aria-label="Callback SSO" value={draft.sso?.redirectUri||''} disabled={closed||busy} onChange={e=>patchPlan({sso:{...draft.sso,redirectUri:e.target.value}})}/></label>
     <label className="field">Nuovo segreto client (se confidential)<input type="password" autoComplete="new-password" value={draft.sso?.clientSecret||''} disabled={closed||busy} onChange={e=>patchPlan({sso:{...draft.sso,clientSecret:e.target.value||undefined}})}/></label>
    </div></details>
    <h3 className="mt">Licenza e permessi</h3>
    {!draft.license?.features?.length&&<p className="tiny">Le funzioni di licenza si ricavano dal catalogo dell’app, non dai nomi dei permessi. Se il catalogo non è ancora disponibile, vanno completate dopo la sua verifica.</p>}
    <p className="tiny">Concedi esplicitamente le funzioni previste dal catalogo. I permessi locali ricevuti sono indicazioni, non autorizzazioni.</p>
    <div className="field-grid">
     <label className="field">Stato licenza<select aria-label="Stato licenza" disabled={closed||busy} value={draft.license?.state||''} onChange={e=>patchPlan({license:e.target.value?{state:e.target.value,expiresAt:draft.license?.expiresAt||null,features:draft.license?.features||[]}:undefined})}><option value="">Configura licenza</option><option value="active">Attiva</option><option value="suspended">Sospesa</option><option value="expired">Scaduta</option></select></label>
     <label className="field">Scadenza licenza (facoltativa)<input type="date" disabled={closed||busy||!draft.license} value={draft.license?.expiresAt?.slice(0,10)||''} onChange={e=>patchPlan({license:{...draft.license,expiresAt:e.target.value?e.target.value+'T23:59:59.000Z':null}})}/></label>
     <label className="field">Funzioni acquistate e abilitate<input aria-label="Funzioni abilitate" placeholder="agenda.read, clienti.read" disabled={closed||busy||!draft.license} key={'features-'+detail.updatedAt} defaultValue={(draft.license?.features||[]).filter((f:Row)=>f.purchased&&f.enabled).map((f:Row)=>f.key).join(', ')} onBlur={e=>patchPlan({license:{...draft.license,features:lines(e.target.value).map(key=>({...(draft.license?.features||[]).find((f:Row)=>f.key===key),key,purchased:true,enabled:true}))}})}/></label>
    </div>
    {roles.map(role=>{const mapping=(draft.roles||[]).find((r:Row)=>r.localRole===role);return <div className="migration-role" key={role}><strong>Ruolo locale: {role}</strong><div className="field-grid"><label className="field">Nome ruolo Connect<input aria-label={'Nome ruolo '+role} disabled={closed||busy} value={mapping?.roleName||''} placeholder="Es. Titolare" onChange={e=>setRole(role,{roleName:e.target.value})}/></label><label className="field">Permessi concessi<input aria-label={'Permessi ruolo '+role} disabled={closed||busy} key={role+'-'+detail.updatedAt} defaultValue={(mapping?.permissions||[]).join(', ')} placeholder="agenda.read, clienti.read" onBlur={e=>setRole(role,{permissions:lines(e.target.value)})}/></label></div><small className="tiny">Dichiarati dalla sorgente: {[...new Set((detail.requests||[]).filter((r:Row)=>(r.role||activationRole)===role).flatMap((r:Row)=>r.permissions||[]))].join(', ')||'Nessuno'}</small></div>;})}
    {detail.kind==='activation'&&<div className="field-grid">
     <label className="field">Azienda locale<input value={activationTenant} onChange={e=>setActivationTenant(e.target.value)} placeholder="tenant-id"/></label>
     <label className="field">Utente locale<input value={activationUser} onChange={e=>setActivationUser(e.target.value)} placeholder="local-user-id"/></label>
     <label className="field">Ruolo locale<select value={activationRole} onChange={e=>setActivationRole(e.target.value)}>{['owner','manager','reception','collaborator'].map(r=><option key={r} value={r}>{r}</option>)}</select></label>
    </div>}
    <details className="migration-disclosure"><summary>Modifica avanzata del piano</summary><label className="field">Piano JSON<textarea aria-label="Piano JSON" rows={14} value={planText} onChange={e=>setPlanText(e.target.value)} spellCheck={false}/></label></details>
    <div className="row migration-actions">
     <button className="btn primary" disabled={busy||closed} onClick={savePlan}>Salva piano</button>
     <button className="btn" disabled={busy||closed||unsaved} onClick={()=>void prepare()}>Verifica prerequisiti</button>
     <button className="btn primary" disabled={busy||closed||unsaved||!detail.canExecute} onClick={()=>void execute()}>Esegui migrazione</button>
    </div>
    {unsaved&&<p className="tiny">Proposta non salvata: conferma con «Salva piano» prima della verifica o dell’esecuzione.</p>}
    {!detail.canExecute&&<p className="tiny">Completa piano, licenza, mappatura dei ruoli e credenziali prima di eseguire. I collegamenti per email non vengono mai dedotti.</p>}
    </details>
   </div>

   <div className="migration-block">
    <details className="migration-disclosure"><summary>Rifiuta e chiudi la pratica</summary>
    <label className="field">Motivo<textarea aria-label="Motivo del rifiuto" rows={2} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <button className="btn" disabled={busy||closed} onClick={()=>detail&&void reject(detail.id)}>Rifiuta pratica e cancella credenziali</button></details>
   </div>
  </div>}


 </section>;
}
