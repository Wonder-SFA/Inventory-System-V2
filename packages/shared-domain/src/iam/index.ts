import { z } from 'zod';

export const ActorRoleSchema = z.enum([
  'OWNER',
  'SUPER_ADMIN',
  'ADMIN',
  'MANAGER',
  'STAFF',
  'VIEWER',
]);
export type ActorRole = z.infer<typeof ActorRoleSchema>;

export const LotPickingModeSchema = z.enum([
  'AUTO_FEFO',
  'MANUAL_REQUIRED',
  'MANUAL_OPTIONAL',
]);
export type LotPickingMode = z.infer<typeof LotPickingModeSchema>;

export const LotNegativeStockPolicySchema = z.enum([
  'FLEXIBLE_UNASSIGNED',
  'STRICT_BLOCK',
]);
export type LotNegativeStockPolicy = z.infer<typeof LotNegativeStockPolicySchema>;

export const LotPolicyScopeTypeSchema = z.enum([
  'COMPANY',
  'LOCATION',
  'ROLE',
  'USER',
]);
export type LotPolicyScopeType = z.infer<typeof LotPolicyScopeTypeSchema>;

export const LotPolicySchema = z.object({
  id: z.string().uuid(),
  scopeType: LotPolicyScopeTypeSchema,
  scopeId: z.string(),
  pickingMode: LotPickingModeSchema.nullable(),
  allowExpiredLotOverride: z.boolean().nullable(),
  negativeStockPolicy: LotNegativeStockPolicySchema.nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LotPolicy = z.infer<typeof LotPolicySchema>;

export const EffectiveLotPolicySchema = z.object({
  pickingMode: LotPickingModeSchema,
  allowExpiredLotOverride: z.boolean(),
  negativeStockPolicy: LotNegativeStockPolicySchema,
});
export type EffectiveLotPolicy = z.infer<typeof EffectiveLotPolicySchema>;

export const UpsertLotPolicyInputSchema = z
  .object({
    scopeType: LotPolicyScopeTypeSchema,
    scopeId: z.string().trim().default(''),
    pickingMode: LotPickingModeSchema.nullable().optional(),
    allowExpiredLotOverride: z.boolean().nullable().optional(),
    negativeStockPolicy: LotNegativeStockPolicySchema.nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scopeType === 'COMPANY' && data.scopeId !== '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'scopeId must be empty for COMPANY scope',
      });
    } else if (data.scopeType !== 'COMPANY' && data.scopeId.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: `scopeId is required for ${data.scopeType} scope`,
      });
    }

    if (data.scopeType === 'ROLE' && !ActorRoleSchema.safeParse(data.scopeId).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeId'],
        message: 'scopeId must be a valid role for ROLE scope',
      });
    }
  });
export type UpsertLotPolicyInput = z.infer<typeof UpsertLotPolicyInputSchema>;

export const EffectiveLotPolicyQuerySchema = z.object({
  locationId: z.string().uuid().optional(),
});
export type EffectiveLotPolicyQuery = z.infer<typeof EffectiveLotPolicyQuerySchema>;

export const IamAuditLogSchema = z.object({
  id: z.string().uuid(),
  actorId: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  beforeState: z.unknown().nullable(),
  afterState: z.unknown().nullable(),
  createdAt: z.string(),
});
export type IamAuditLog = z.infer<typeof IamAuditLogSchema>;
