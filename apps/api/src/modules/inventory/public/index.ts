export const INVENTORY_MODULE = 'inventory' as const;

export {
  type CloseTransferDiscrepancyLine,
  type DispatchTransferLine,
  type DispatchedTransferLineResult,
  type EmitEventFn,
  type InventoryIntentOptions,
  type LocationReferenceChecker,
  type LockedBalanceState,
  type PostMovementLine,
  type ReceiveTransferLine,
  type ReserveStockLine,
  type StockPair,
  closeTransferDiscrepancy,
  dispatchTransfer,
  getLocationById,
  getLocationsByIds,
  hasLocationReferences,
  listLocations,
  listStockBalances,
  listStockMovements,
  postMovements,
  receiveTransfer,
  registerInventoryReferenceCheckers,
  registerLocationReferenceChecker,
  releaseReservation,
  reserveStock,
} from '../domain/index.js';
export {
  type RegisterInventoryRoutesOptions,
  registerInventoryRoutes,
} from '../routes/index.js';
