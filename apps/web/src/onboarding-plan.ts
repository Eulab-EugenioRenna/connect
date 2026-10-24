type Row=Record<string,any>;
const roleNames:Record<string,string>={owner:'Titolare',manager:'Responsabile',reception:'Reception',collaborator:'Collaboratore'};
/** Local proposal only: never persists, links by email/name, or grants access. */
export function proposeOnboardingPlan(detail:Row,catalog?:Row){
 const plan:Row=structuredClone(detail.plan||{});
 if(['completed','rejected','expired','migrating'].includes(detail.state))return plan;
 const review=detail.review||{},source=detail.source||{};
 if(!plan.application){
  if(review.verifiedApplicationId)plan.application={mode:'existing',id:review.verifiedApplicationId};
  else if(source.app_id&&!(review.applications||[]).some((a:Row)=>a.id===source.app_id))plan.application={mode:'create',id:source.app_id,name:source.name||source.app_id};
 }
 if(!plan.customer&&detail.tenant?.name&&!(review.customers||[]).some((c:Row)=>c.name.toLowerCase()===detail.tenant.name.toLowerCase()))plan.customer={mode:'create',name:detail.tenant.name};
 if(!plan.installation&&source.origins?.length===1&&!(review.installations||[]).some((i:Row)=>i.app_id===plan.application?.id&&i.domain===source.origins[0]))plan.installation={mode:'create',domain:source.origins[0],basePath:''};
 const roles=[...new Set<string>((detail.requests||[]).map((r:Row)=>r.role||plan.activation?.localRole||'owner'))];
 plan.roles=plan.roles||[];
 for(const localRole of roles)if(!plan.roles.some((r:Row)=>r.localRole===localRole))plan.roles.push({localRole,roleName:roleNames[localRole]||localRole,permissions:[...new Set((detail.requests||[]).filter((r:Row)=>(r.role||plan.activation?.localRole||'owner')===localRole).flatMap((r:Row)=>r.permissions||[]))]});
 if(!plan.license){
  const permissions=new Set(plan.roles.flatMap((r:Row)=>r.permissions||[]));
  const featureKeys=new Set((catalog?.permissions||[]).filter((p:Row)=>permissions.has(p.key)).map((p:Row)=>p.feature));
  plan.license={state:'active',expiresAt:null,features:(catalog?.features||[]).filter((f:Row)=>featureKeys.has(f.key)).map((f:Row)=>({key:f.key,purchased:true,enabled:true}))};
 }
 return plan;
}
