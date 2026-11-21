import { z } from 'zod';
import { CursorPaginationQuerySchema } from '../http/index.js';

export const LocationStatusSchema = z.enum(['ACTIVE', 'ARCHIVED']);
export type LocationStatus = z.infer<typeof LocationStatusSchema>;

export const LocationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  address: z.string().nullable(),
  description: z.string().nullable(),
  status: LocationStatusSchema,
  parentLocationId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Location = z.infer<typeof LocationSchema>;

export const CreateLocationInputSchema = z.object({
  name: z.string().trim().min(1, 'Location name is required').max(200),
  address: z.string().trim().max(500).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  parentLocationId: z.string().uuid().nullable().optional(),
});

export type CreateLocationInput = z.infer<typeof CreateLocationInputSchema>;

export const UpdateLocationInputSchema = z.object({
  name: z.string().trim().min(1, 'Location name is required').max(200).optional(),
  address: z.string().trim().max(500).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  parentLocationId: z.string().uuid().nullable().optional(),
});

export type UpdateLocationInput = z.infer<typeof UpdateLocationInputSchema>;

export const ListLocationsQuerySchema = CursorPaginationQuerySchema.extend({
  status: LocationStatusSchema.optional(),
});

export type ListLocationsQuery = z.infer<typeof ListLocationsQuerySchema>;
