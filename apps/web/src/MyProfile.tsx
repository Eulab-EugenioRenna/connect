import React,{useEffect,useState} from 'react';
import type {ConnectBrowser} from '../../../packages/sdk/src/browser';

type PortalApp={installationId:string;appId:string;appName:string;description:string;customerName:string;url:string;state:'ready'|'first_access'};
type Me={subject:string;admin:boolean;displayName:string;firstName:string;lastName:string;email:string;emailVerified:boolean;applications:PortalApp[]};
type Security={totp:boolean;emailVerified:boolean;preferredMethod:'auto'|'totp'|'email';requiredActions:string[];authenticators:{id:string;name:string;createdAt?:number}[]};

const initials=(name:string)=>name.split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0]!.toUpperCase()).join('')||'EU';

/**
 * Personal area of EULab Connect: for contacts without admin rights (and for
 * admins from the menu). Profile, protection and the applications they can open.
 */
export function MyProfile({sdk,embedded=false}:{sdk:ConnectBrowser;embedded?:boolean}){
 const [me,setMe]=useState<Me|null>(null),[security,setSecurity]=useState<Security|null>(null);
 const [form,setForm]=useState({firstName:'',lastName:''}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 async function load(){
  setError('');
  const [profile,protection]=await Promise.allSettled([sdk.request<Me>('/v1/me'),sdk.request<Security>('/v1/security/me')]);
  if(profile.status==='fulfilled'){setMe(profile.value);setForm({firstName:profile.value.firstName,lastName:profile.value.lastName});}
  else setError((profile.reason as Error).message);
  setSecurity(protection.status==='fulfilled'?protection.value:null);
 }
 useEffect(()=>{void load();},[]);
 async function run(fn:()=>Promise<unknown>,message:string){setBusy(true);setError('');setNotice('');try{await fn();if(message)setNotice(message);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 const changed=!!me&&!!form.firstName.trim()&&!!form.lastName.trim()&&(form.firstName.trim()!==me.firstName||form.lastName.trim()!==me.lastName);
 const ready=me?.applications.filter(a=>a.url)||[];
 const body=<>
  {error&&<p className="error" role="alert">{error}</p>}
  {notice&&<p className="success" role="status">{notice}</p>}
  {!me&&!error&&<div className="loading">Caricamento del tuo profilo…</div>}
  {me&&<>
   <section className="card">
    <div className="row between">
     <div className="row"><div className="avatar" aria-hidden="true">{initials(me.displayName||me.email)}</div><div><h2>{me.displayName||me.email}</h2><p className="muted">{me.email}</p></div></div>
     {!me.admin&&<span className="badge blue"><span className="dot"/>Contatto applicazioni</span>}
    </div>
   </section>
   <section className="card mt" aria-labelledby="my-apps">
    <h2 id="my-apps">Le tue applicazioni</h2>
    <p className="muted mt">Le app a cui la tua azienda ti ha dato accesso. Entri con lo stesso account EULab.</p>
    {!ready.length&&<p className="empty mt">Nessuna applicazione abilitata per il tuo account. Chiedi all’amministratore della tua azienda di assegnarti un ruolo.</p>}
    <div className="grid3 mt">{ready.map(app=><article className="product" key={app.installationId}>
     <div className="product-head"><div className="product-icon" aria-hidden="true">{initials(app.appName)}</div><div><strong>{app.appName}</strong><div className="small muted">{app.customerName}</div></div></div>
     {app.description&&<p className="small muted mt">{app.description}</p>}
     <div className="product-footer mt"><span className={`badge ${app.state==='ready'?'green':'amber'}`}><span className="dot"/>{app.state==='ready'?'Pronta':'Primo accesso'}</span>
      <a className="btn primary" href={app.url} target="_blank" rel="noopener noreferrer">Apri {app.appName} ↗</a></div>
    </article>)}</div>
   </section>
   <div className="grid2 mt">
    <section className="card" aria-labelledby="my-profile">
     <h2 id="my-profile">Profilo</h2>
     <form className="mt" onSubmit={e=>{e.preventDefault();void run(async()=>{await sdk.request('/v1/security/me/profile','PUT',{firstName:form.firstName.trim(),lastName:form.lastName.trim()});await load();},'Profilo aggiornato in tutte le app EULab.');}}>
      <div className="field-grid">
       <div className="field"><label htmlFor="me-first">Nome</label><input id="me-first" required maxLength={100} value={form.firstName} onChange={e=>setForm({...form,firstName:e.target.value})}/></div>
       <div className="field"><label htmlFor="me-last">Cognome</label><input id="me-last" required maxLength={100} value={form.lastName} onChange={e=>setForm({...form,lastName:e.target.value})}/></div>
      </div>
      <p className="small muted">L’email {me.email} è la tua identità di accesso e resta fissa.</p>
      <button className="btn primary mt" disabled={busy||!changed}>Salva profilo</button>
     </form>
    </section>
    <section className="card" aria-labelledby="my-security">
     <h2 id="my-security">Password e verifica</h2>
     <div className="stack mt">
      <div className="row between"><div><strong>Password</strong><div className="small muted">Si apre la schermata sicura EULab, poi torni qui.</div></div><button className="btn" disabled={busy} onClick={()=>void run(()=>sdk.login({action:'UPDATE_PASSWORD',returnTo:location.href}),'')}>Cambia password</button></div>
      {security&&<>
       <div className="row between mt"><div><strong>App di autenticazione</strong><div className="small muted">{security.totp?`Attiva${security.authenticators.length?': '+security.authenticators.map(a=>a.name).join(', '):''}`:'Non configurata'}</div></div><button className="btn" disabled={busy} onClick={()=>void run(()=>sdk.configureMfa(location.href),'')}>{security.totp?'Aggiungi app':'Configura'}</button></div>
       {security.authenticators.map(a=><div className="row between" key={a.id}><span className="small">{a.name}</span><button className="text-button" disabled={busy} onClick={()=>{if(confirm('Rimuovere questa app? Per sicurezza verranno chiuse tutte le tue sessioni.'))void run(async()=>{await sdk.request('/v1/security/me/authenticators/'+encodeURIComponent(a.id),'DELETE');await sdk.logout();},'');}}>Rimuovi</button></div>)}
       <div className="row between mt"><div><strong>Email</strong><div className="small muted">{security.emailVerified?'Verificata':'Da verificare'}</div></div>{!security.emailVerified&&<button className="btn" disabled={busy} onClick={()=>void run(()=>sdk.verifyEmail(location.href),'')}>Verifica email</button>}</div>
       <div className="field mt"><label htmlFor="me-method">Metodo di verifica preferito</label><select id="me-method" disabled={busy} value={security.preferredMethod} onChange={e=>void run(async()=>{setSecurity(await sdk.request<Security>('/v1/security/me/preferences','PUT',{preferredMethod:e.target.value}));},'Metodo di verifica aggiornato.')}><option value="auto">Automatico</option><option value="totp" disabled={!security.totp}>App di autenticazione</option><option value="email">Codice via email</option></select></div>
      </>}
      {!security&&<p className="small muted">Lo stato della protezione non è disponibile in questo momento.</p>}
     </div>
    </section>
   </div>
  </>}
 </>;
 if(embedded)return body;
 return <main className="workspace" style={{maxWidth:'72rem',margin:'0 auto',padding:'2rem 1.25rem'}}>
  <header className="topbar"><div className="logo"><img className="brand-logo" src={`${window.EULAB_CONFIG.adminBasePath||'/'}brand/logo.svg`} alt="EULab Connect"/></div><div className="topright"><button className="text-button" disabled={busy} onClick={()=>void run(load,'')}>Aggiorna</button><button className="btn" onClick={()=>sdk.logout()}>Esci</button></div></header>
  <div className="page-heading"><div><h1>Il tuo account EULab</h1><p>Profilo, sicurezza e accesso alle applicazioni abilitate. La console di amministrazione è riservata agli amministratori EULab.</p></div></div>
  {body}
 </main>;
}
