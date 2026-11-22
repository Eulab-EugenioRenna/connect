// Reserved provider metadata used for recovery; no person can edit their own proof.
export const identityProofAttributes=['eulab_mirror_proof','eulab_app_mirror_profile','eulab_onboarding_request','eulab_onboarding_source'];
export async function configureIdentityProofProfile(admin){
 const current=await admin('/users/profile'),attributes=[...(current.attributes||[])];
 for(const name of identityProofAttributes){
  const index=attributes.findIndex(a=>a.name===name);
  const attribute={...(index>=0?attributes[index]:{name,validations:{length:{max:200}}}),permissions:{view:['admin'],edit:['admin']},multivalued:true};
  if(index>=0)attributes[index]=attribute;else attributes.push(attribute);
 }
 if(JSON.stringify(attributes)!==JSON.stringify(current.attributes))await admin('/users/profile','PUT',{...current,attributes});
}
