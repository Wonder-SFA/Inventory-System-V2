export const ORDERS_MODULE = 'orders' as const;

export {
  type OrderEmitEventFn,
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  deleteSupplier,
  getPurchaseOrderById,
  getSupplierById,
  hasOrderLocationReferences,
  hasOrderSkuReferences,
  hasSupplierReferences,
  listPurchaseOrders,
  listSuppliers,
  receivePurchaseOrder,
  registerOrdersReferenceCheckers,
  setSupplierStatus,
  updatePurchaseOrder,
  updateSupplier,
} from '../domain/index.js';
export { type RegisterOrdersRoutesOptions, registerOrdersRoutes } from '../routes/index.js';
