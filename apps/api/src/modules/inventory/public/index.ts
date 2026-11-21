export const INVENTORY_MODULE = 'inventory' as const;

export {
  type LocationReferenceChecker,
  getLocationById,
  getLocationsByIds,
  hasLocationReferences,
  listLocations,
  registerLocationReferenceChecker,
} from '../domain/index.js';
export {
  type RegisterInventoryRoutesOptions,
  registerInventoryRoutes,
} from '../routes/index.js';
