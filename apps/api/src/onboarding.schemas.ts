import {z} from 'zod';
import {key,name,origin,uuid} from './validation.js';

export const ONBOARDING_CONSENT_VERSION='2026-10-21-mandatory-v1';
export const ONBOARDING_STATES=['pending','approved','migrating','completed','rejected','expired','failed'] as const;
export type OnboardingState=typeof ONBOARDING_STATES[number];

export const sourceId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/,'Identificativo sorgente non valido');
export const localId=z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/,'Identificativo locale non valido');
export const localRole=z.enum(['owner','manager','reception','collaborator']);
const email=z.string().trim().email().max(254).transform(v=>v.toLowerCase());
const personName=z.string().trim().min(1).max(80);
const permission=key;
export const deploymentMetadataSchema=z.object({name:z.string().trim().min(1).max(200),environment:z.enum(['development','staging','production']),
 origins:z.array(origin).min(1).max(20),catalogUrl:z.string().url().max(2000).optional(),oidcCallbacks:z.array(z.string().url().max(2000)).max(20).default([])}).strict();
export const presenterSchema=z.object({name:z.string().trim().min(1).max(200),deploymentIdentity:z.string().trim().min(1).max(300),verifiedOrigins:z.array(origin).max(20).default([]),verifiedAppId:key.optional(),expiresAt:z.string().datetime()}).strict();
export const presenterUpdateSchema=z.object({enabled:z.boolean().optional(),expiresAt:z.string().datetime().optional(),rotateSecret:z.boolean().default(false)}).strict();
export const ssoConfigurationSchema=z.object({issuer:z.string().url().max(2000),clientId:z.string().min(1).max(200),redirectUri:z.string().url().max(2000),clientSecret:z.string().min(1).max(2000).optional()}).strict();
const common={schemaVersion:z.literal(1),appId:key,sourceId,deployment:deploymentMetadataSchema.optional()};
export const sourceConfigurationSchema=z.object(common).strict();

export const loginContextSchema=z.object({...common,email}).strict();

const localTenant=z.object({id:localId,name:z.string().trim().min(1).max(200),slug:z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120)}).strict();
const localUser=z.object({id:localId,email,firstName:personName,lastName:personName,role:localRole,permissions:z.array(permission).max(500)}).strict();

export const migrationRequestSchema=z.object({
 ...common,
 kind:z.literal('migration'),
 consentVersion:z.literal(ONBOARDING_CONSENT_VERSION),
 localTenant,
 localUser,
 initialPassword:z.string().min(1).max(512)
}).strict();

export const activationRequestSchema=z.object({
 ...common,
 kind:z.literal('activation'),
 companyName:z.string().trim().min(1).max(200),
 applicant:z.object({email,firstName:personName,lastName:personName}).strict(),
 initialPassword:z.string().min(1).max(512)
}).strict();

export const onboardingRequestSchema=z.discriminatedUnion('kind',[migrationRequestSchema,activationRequestSchema]);

export const connectSourceSchema=z.object({
 id:sourceId,
 name:z.string().trim().min(1).max(200),
 appId:key,
 environment:z.enum(['development','staging','production']),
 origins:z.array(origin).min(1).max(20),
 catalogUrl:z.string().url().max(2000).optional(),
 oidcCallbacks:z.array(z.string().url().max(2000)).max(20).default([]),
 deploymentIdentity:z.string().trim().min(1).max(300)
}).strict();

export const updateConnectSourceSchema=z.object({
 name:z.string().trim().min(1).max(200).optional(),
 environment:z.enum(['development','staging','production']).optional(),
 origins:z.array(origin).min(1).max(20).optional(),
 catalogUrl:z.string().url().max(2000).nullable().optional(),
 oidcCallbacks:z.array(z.string().url().max(2000)).max(20).optional(),
 deploymentIdentity:z.string().trim().min(1).max(300).optional(),
 enabled:z.boolean().optional(),
 sso:ssoConfigurationSchema.optional(),
 rotateSecret:z.boolean().default(false)
}).strict();

export const bindSourceInstallationSchema=z.object({installationId:uuid}).strict();

export const sourceLocalUserSchema=z.object({
 installationId:uuid,
 localTenantId:localId,
 localUserId:localId,
 subject:name,
 email,
 firstName:personName,
 lastName:personName,
 role:localRole,
 permissions:z.array(permission).max(500).default([]),
 enabled:z.boolean().default(true)
}).strict();

const planFeature=z.object({key,purchased:z.boolean(),enabled:z.boolean()}).strict();
export const onboardingPlanSchema=z.object({
 application:z.discriminatedUnion('mode',[
  z.object({mode:z.literal('existing'),id:key}).strict(),
  z.object({mode:z.literal('create'),id:key,name:z.string().trim().min(1).max(200),description:z.string().max(2000).default('')}).strict()
 ]).optional(),
 customer:z.discriminatedUnion('mode',[
  z.object({mode:z.literal('existing'),id:uuid}).strict(),
  z.object({mode:z.literal('create'),name:z.string().trim().min(1).max(200)}).strict()
 ]).optional(),
 installation:z.discriminatedUnion('mode',[
  z.object({mode:z.literal('existing'),id:uuid}).strict(),
  z.object({mode:z.literal('create'),domain:origin,basePath:z.string().regex(/^(?:\/[A-Za-z0-9_-]+)*$/).default('')}).strict()
 ]).optional(),
 sso:ssoConfigurationSchema.optional(),
 license:z.object({state:z.enum(['active','suspended','expired']),expiresAt:z.string().datetime().nullable(),features:z.array(planFeature).max(200)}).strict().optional(),
 roles:z.array(z.object({localRole,roleName:z.string().trim().min(1).max(200),permissions:z.array(permission).max(1000)}).strict()).max(20).default([]),
 activation:z.object({localTenantId:localId,localUserId:localId,localRole}).strict().optional(),
 identities:z.record(uuid,name).optional()
}).strict();

export const rejectOnboardingSchema=z.object({reason:z.string().trim().min(1).max(300)}).strict();

/** The authenticated source attests a fresh legacy proof and consent, never a browser. */
export const passwordRecoverySchema=z.object({...common,requestId:uuid,localTenantId:localId,localUserId:localId,email,
 consentVersion:z.literal(ONBOARDING_CONSENT_VERSION),newPassword:z.string().min(1).max(512)}).strict();
