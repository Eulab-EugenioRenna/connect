import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeOnboardingPlan} from '../apps/web/src/onboarding-plan.ts';
const fixture=()=>({state:'pending',source:{app_id:'workshop',name:'Workshop',origins:['https://workshop.test']},tenant:{name:'Example company'},review:{applications:[],customers:[],installations:[]},plan:{roles:[]},requests:[{role:'owner',email:'test@example.test',permissions:['projects.read','projects.edit']}]});
test('Practice proposal reuses declared data without mutating or approving the practice',()=>{
 const detail=fixture(),before=structuredClone(detail),plan=proposeOnboardingPlan(detail);
 assert.deepEqual(detail,before);assert.deepEqual(plan.application,{mode:'create',id:'workshop',name:'Workshop'});assert.equal(plan.customer.name,'Example company');assert.equal(plan.installation.domain,'https://workshop.test');assert.equal(plan.roles[0].roleName,'Titolare');assert.deepEqual(plan.roles[0].permissions,['projects.read','projects.edit']);assert.deepEqual(plan.license.features,[]);assert.equal(plan.identities,undefined);assert.equal(plan.sso,undefined);
});
test('Proposal preserves administrative selections, removed permissions and license restrictions',()=>{
 const detail:any=fixture();detail.plan={application:{mode:'existing',id:'approved'},customer:{mode:'existing',id:'customer'},installation:{mode:'existing',id:'installation'},roles:[{localRole:'owner',roleName:'Limited owner',permissions:[]}],license:{state:'suspended',expiresAt:null,features:[]},identities:{request:'explicit-subject'}};
 assert.deepEqual(proposeOnboardingPlan(detail),detail.plan);
});
test('Matching app or customer name never authorizes an automatic existing-object link',()=>{
 const detail:any=fixture();detail.review={applications:[{id:'workshop'}],customers:[{name:'Example company'}],installations:[]};const plan=proposeOnboardingPlan(detail);assert.equal(plan.application,undefined);assert.equal(plan.customer,undefined);
 detail.review.verifiedApplicationId='approved';assert.deepEqual(proposeOnboardingPlan(detail).application,{mode:'existing',id:'approved'});
});
test('Feature proposal maps permission keys through the catalog instead of treating permissions as features',()=>{
 const plan=proposeOnboardingPlan(fixture(),{features:[{key:'projects'},{key:'billing'}],permissions:[{key:'projects.read',feature:'projects'},{key:'projects.edit',feature:'projects'}]});assert.deepEqual(plan.license.features,[{key:'projects',purchased:true,enabled:true}]);
});
test('Terminal or executing practice never acquires a new proposal',()=>{
 for(const state of ['completed','rejected','expired','migrating']){const detail=fixture();detail.state=state;assert.deepEqual(proposeOnboardingPlan(detail),detail.plan);}
});
