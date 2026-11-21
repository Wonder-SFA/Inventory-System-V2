export const CATALOG_MODULE = 'catalog' as const;

export {
  type CatalogDbExecutor,
  type SkuReferenceChecker,
  findSkuByIdOrCode,
  getSkusByIds,
  hasSkuReferences,
  registerSkuReferenceChecker,
} from '../domain/index.js';
export { type RegisterCatalogRoutesOptions, registerCatalogRoutes } from '../routes/index.js';
