export const CATALOG_MODULE = 'catalog' as const;

export {
  type CatalogDbExecutor,
  type SkuPositiveStockChecker,
  type SkuReferenceChecker,
  findSkuByIdOrCode,
  getSkusByIds,
  hasPositiveOnHandStock,
  hasSkuReferences,
  registerSkuPositiveStockChecker,
  registerSkuReferenceChecker,
} from '../domain/index.js';
export { type RegisterCatalogRoutesOptions, registerCatalogRoutes } from '../routes/index.js';
