import test from 'node:test';
import assert from 'node:assert/strict';
import {configureIdentityProofProfile,identityProofAttributes} from '../scripts/identity-proof-profile.mjs';
test('Identity proof bootstrap protects reserved metadata, preserves profile rules and is repeatable',async()=>{
 const unrelated={name:'business-field',permissions:{view:['user','admin'],edit:['user','admin']},validations:{length:{max:100}}};
 let profile={attributes:[unrelated,{name:'eulab_mirror_proof',permissions:{view:['user'],edit:['user']},validations:{length:{max:64}}}],unmanagedAttributePolicy:'ADMIN_VIEW'},writes=0;
 const admin=async(path,method='GET',body)=>{assert.equal(path,'/users/profile');if(method==='GET')return structuredClone(profile);writes++;profile=structuredClone(body);};
 await configureIdentityProofProfile(admin);await configureIdentityProofProfile(admin);
 assert.equal(writes,1);assert.deepEqual(profile.attributes[0],unrelated);assert.equal(profile.unmanagedAttributePolicy,'ADMIN_VIEW');
 for(const name of identityProofAttributes){const a=profile.attributes.find(a=>a.name===name);assert.deepEqual(a.permissions,{view:['admin'],edit:['admin']});assert.equal(a.multivalued,true);}
 assert.deepEqual(profile.attributes.find(a=>a.name==='eulab_mirror_proof').validations,{length:{max:64}});
});
