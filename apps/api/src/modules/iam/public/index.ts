import type { AccessSwitchState } from '../db/index.js';
import type { AccessPolicy } from '../domain/index.js';

export const IAM_MODULE = 'iam' as const;

export type { AccessSwitchState } from '../db/index.js';
export {
  type AccessContext,
  type AccessPolicy,
  type Actor,
  type AuthInstance,
  type CreateAuthOptions,
  type LocationScope,
  type LotPolicyRule,
  type ResolvePolicyOverrides,
  createAuth,
  getAccessSwitch,
  resolvePolicy,
  setAccessSwitch,
} from '../domain/index.js';
export { type RegisterIamRoutesOptions, registerIamRoutes } from '../routes/iamRoutes.js';

declare module 'fastify' {
  interface FastifyRequest {
    accessPolicy?: AccessPolicy;
    accessSwitch?: AccessSwitchState;
  }
}
