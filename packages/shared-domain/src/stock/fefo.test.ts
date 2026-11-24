import { describe, expect, it } from 'vitest';
import { toQuantity, toUnitCost } from '../decimal/index.js';
import { ERROR_CODES, ValidationError } from '../http/index.js';
import { type FefoCandidateLot, planFefoAllocation } from './fefo.js';

function makeLot(
  overrides: Partial<FefoCandidateLot> & { lotId: string; lotCode: string },
): FefoCandidateLot {
  return {
    expDate: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    onHand: toQuantity('10'),
    unitCost: toUnitCost('5'),
    ...overrides,
  };
}

describe('planFefoAllocation', () => {
  it('drains positive unlotted stock first before touching tracked lots', () => {
    const result = planFefoAllocation({
      requestedQty: toQuantity('7'),
      positiveUnlottedQty: toQuantity('4'),
      lots: [
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000001',
          lotCode: 'LOT-A',
          expDate: '2026-06-01',
          onHand: toQuantity('5'),
          unitCost: toUnitCost('12'),
        }),
      ],
      today: '2026-05-01',
      negativeStockPolicy: 'STRICT_BLOCK',
    });

    expect(result.hasNegativeStockWarning).toBe(false);
    expect(result.shortfallQty).toBe('0.0000');
    expect(result.totalAllocatedQty).toBe('7.0000');
    expect(result.slices).toEqual([
      {
        lotId: null,
        lotCode: null,
        expDate: null,
        quantity: '4.0000',
        unitCost: null,
        isUnlotted: true,
        negativeStockWarning: false,
      },
      {
        lotId: '00000000-0000-7000-8000-000000000001',
        lotCode: 'LOT-A',
        expDate: '2026-06-01',
        quantity: '3.0000',
        unitCost: '12.0000',
        isUnlotted: false,
        negativeStockWarning: false,
      },
    ]);
  });

  it('allocates earliest expDate first, then null expDate last, breaking ties by FIFO createdAt then lotId', () => {
    const result = planFefoAllocation({
      requestedQty: toQuantity('11'),
      positiveUnlottedQty: toQuantity('0'),
      lots: [
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000004',
          lotCode: 'LOT-NOEXP-NEW',
          expDate: null,
          createdAt: '2026-03-02T00:00:00.000Z',
          onHand: toQuantity('5'),
          unitCost: toUnitCost('4'),
        }),
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000003',
          lotCode: 'LOT-NOEXP-OLD',
          expDate: null,
          createdAt: '2026-03-01T00:00:00.000Z',
          onHand: toQuantity('3'),
          unitCost: toUnitCost('3'),
        }),
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000002',
          lotCode: 'LOT-TIE-LATER',
          expDate: '2026-06-15',
          createdAt: '2026-02-05T00:00:00.000Z',
          onHand: toQuantity('4'),
          unitCost: toUnitCost('11'),
        }),
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000001',
          lotCode: 'LOT-TIE-EARLIER',
          expDate: '2026-06-15',
          createdAt: '2026-02-01T00:00:00.000Z',
          onHand: toQuantity('3'),
          unitCost: toUnitCost('10'),
        }),
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000000',
          lotCode: 'LOT-EARLIEST',
          expDate: '2026-05-20',
          createdAt: '2026-04-01T00:00:00.000Z',
          onHand: toQuantity('2'),
          unitCost: toUnitCost('9'),
        }),
      ],
      today: '2026-05-01',
      negativeStockPolicy: 'STRICT_BLOCK',
    });

    expect(result.slices.map((s) => [s.lotCode, s.quantity])).toEqual([
      ['LOT-EARLIEST', '2.0000'],
      ['LOT-TIE-EARLIER', '3.0000'],
      ['LOT-TIE-LATER', '4.0000'],
      ['LOT-NOEXP-OLD', '2.0000'],
    ]);
  });

  it('skips expired lots (expDate < today) while keeping lots expiring today (expDate === today)', () => {
    const result = planFefoAllocation({
      requestedQty: toQuantity('5'),
      positiveUnlottedQty: toQuantity('0'),
      lots: [
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000001',
          lotCode: 'LOT-EXPIRED',
          expDate: '2026-04-30',
          onHand: toQuantity('100'),
        }),
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000002',
          lotCode: 'LOT-TODAY',
          expDate: '2026-05-01',
          onHand: toQuantity('3'),
        }),
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000003',
          lotCode: 'LOT-FUTURE',
          expDate: '2026-05-10',
          onHand: toQuantity('10'),
        }),
      ],
      today: '2026-05-01',
      negativeStockPolicy: 'STRICT_BLOCK',
    });

    expect(result.slices.map((s) => [s.lotCode, s.quantity])).toEqual([
      ['LOT-TODAY', '3.0000'],
      ['LOT-FUTURE', '2.0000'],
    ]);
  });

  it('emits an unassigned shortfall slice with negativeStockWarning under FLEXIBLE_UNASSIGNED', () => {
    const result = planFefoAllocation({
      requestedQty: toQuantity('8'),
      positiveUnlottedQty: toQuantity('1'),
      lots: [
        makeLot({
          lotId: '00000000-0000-7000-8000-000000000001',
          lotCode: 'LOT-A',
          expDate: '2026-06-01',
          onHand: toQuantity('3'),
          unitCost: toUnitCost('7.5'),
        }),
      ],
      today: '2026-05-01',
      negativeStockPolicy: 'FLEXIBLE_UNASSIGNED',
    });

    expect(result.hasNegativeStockWarning).toBe(true);
    expect(result.shortfallQty).toBe('4.0000');
    expect(result.slices).toEqual([
      {
        lotId: null,
        lotCode: null,
        expDate: null,
        quantity: '1.0000',
        unitCost: null,
        isUnlotted: true,
        negativeStockWarning: false,
      },
      {
        lotId: '00000000-0000-7000-8000-000000000001',
        lotCode: 'LOT-A',
        expDate: '2026-06-01',
        quantity: '3.0000',
        unitCost: '7.5000',
        isUnlotted: false,
        negativeStockWarning: false,
      },
      {
        lotId: null,
        lotCode: null,
        expDate: null,
        quantity: '4.0000',
        unitCost: null,
        isUnlotted: true,
        negativeStockWarning: true,
      },
    ]);
  });

  it('throws ValidationError(INSUFFICIENT_LOT_STOCK) when stock is insufficient under STRICT_BLOCK', () => {
    try {
      planFefoAllocation({
        requestedQty: toQuantity('10'),
        positiveUnlottedQty: toQuantity('2'),
        lots: [
          makeLot({
            lotId: '00000000-0000-7000-8000-000000000001',
            lotCode: 'LOT-EXPIRED',
            expDate: '2026-04-01',
            onHand: toQuantity('50'),
          }),
          makeLot({
            lotId: '00000000-0000-7000-8000-000000000002',
            lotCode: 'LOT-OK',
            expDate: '2026-06-01',
            onHand: toQuantity('5'),
          }),
        ],
        today: '2026-05-01',
        negativeStockPolicy: 'STRICT_BLOCK',
      });
      expect.unreachable('Expected planFefoAllocation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).statusCode).toBe(422);
      expect((err as ValidationError).code).toBe(ERROR_CODES.INSUFFICIENT_LOT_STOCK);
    }
  });
});
