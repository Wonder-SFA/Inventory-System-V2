import { z } from 'zod';
import { zMoney } from '../decimal/index.js';
import { CursorPaginationQuerySchema } from '../http/index.js';

export const CatalogStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);
export type CatalogStatus = z.infer<typeof CatalogStatusSchema>;

export const UnitOfMeasureSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
  status: CatalogStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UnitOfMeasure = z.infer<typeof UnitOfMeasureSchema>;

export const CreateUnitOfMeasureSchema = z.object({
  code: z.string().trim().min(1, 'Code is required').max(32),
  name: z.string().trim().min(1, 'Name is required').max(120),
});
export type CreateUnitOfMeasureInput = z.infer<typeof CreateUnitOfMeasureSchema>;

export const UpdateUnitOfMeasureSchema = z.object({
  code: z.string().trim().min(1, 'Code cannot be empty').max(32).optional(),
  name: z.string().trim().min(1, 'Name cannot be empty').max(120).optional(),
});
export type UpdateUnitOfMeasureInput = z.infer<typeof UpdateUnitOfMeasureSchema>;

export const ListUnitsOfMeasureQuerySchema = CursorPaginationQuerySchema.extend({
  status: CatalogStatusSchema.optional(),
});
export type ListUnitsOfMeasureQuery = z.infer<typeof ListUnitsOfMeasureQuerySchema>;

export const ProductSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: CatalogStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Product = z.infer<typeof ProductSchema>;

export const CreateProductSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  description: z.string().trim().max(2000).nullable().optional(),
});
export type CreateProductInput = z.infer<typeof CreateProductSchema>;

export const UpdateProductSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty').max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

export const ListProductsQuerySchema = CursorPaginationQuerySchema.extend({
  status: CatalogStatusSchema.optional(),
});
export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;

export const SkuSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  unitOfMeasureId: z.string().uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
  defaultSellingPrice: zMoney.nullable(),
  trackLots: z.boolean(),
  trackExpiry: z.boolean(),
  status: CatalogStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Sku = z.infer<typeof SkuSchema>;

export const CreateSkuSchema = z
  .object({
    productId: z.string().uuid(),
    unitOfMeasureId: z.string().uuid(),
    code: z.string().trim().min(1, 'SKU code is required').max(64),
    name: z.string().trim().min(1, 'SKU name is required').max(200),
    defaultSellingPrice: zMoney.nullable().optional(),
    trackLots: z.boolean().default(false),
    trackExpiry: z.boolean().default(false),
  })
  .refine((data) => !data.trackExpiry || data.trackLots, {
    message: 'trackExpiry cannot be enabled when trackLots is false',
    path: ['trackExpiry'],
  });
export type CreateSkuInput = z.infer<typeof CreateSkuSchema>;

export const UpdateSkuSchema = z.object({
  productId: z.string().uuid().optional(),
  unitOfMeasureId: z.string().uuid().optional(),
  code: z.string().trim().min(1, 'SKU code cannot be empty').max(64).optional(),
  name: z.string().trim().min(1, 'SKU name cannot be empty').max(200).optional(),
  defaultSellingPrice: zMoney.nullable().optional(),
  trackLots: z.boolean().optional(),
  trackExpiry: z.boolean().optional(),
});
export type UpdateSkuInput = z.infer<typeof UpdateSkuSchema>;

export const ListSkusQuerySchema = CursorPaginationQuerySchema.extend({
  status: CatalogStatusSchema.optional(),
  productId: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(100).optional(),
});
export type ListSkusQuery = z.infer<typeof ListSkusQuerySchema>;

export const SkuLookupQuerySchema = z.object({
  code: z.string().trim().min(1, 'Code is required').max(64),
});
export type SkuLookupQuery = z.infer<typeof SkuLookupQuerySchema>;

export const UuidParamSchema = z.object({
  id: z.string().uuid(),
});
export type UuidParam = z.infer<typeof UuidParamSchema>;
