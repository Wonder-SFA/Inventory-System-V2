import { describe, expect, it } from 'vitest';
import {
  DECIMAL_OVERFLOW_CODE,
  DECIMAL_PRECISION_EXCEEDED_CODE,
  MAX_DECIMAL4,
  MIN_DECIMAL4,
  ZERO_DECIMAL4,
  abs,
  add,
  calculateWeightedAverageCost,
  div,
  eq,
  formatDecimal4,
  gt,
  gte,
  isNegative,
  isPositive,
  isZero,
  isZeroOrNegative,
  lt,
  lte,
  mul,
  negate,
  round4,
  sub,
  toMoney,
  toQuantity,
  toUnitCost,
  zDecimal4,
  zMoney,
  zQuantity,
  zUnitCost,
} from './index.js';

describe('Decimal4', () => {
  describe('zDecimal4 & precision validation', () => {
    it('accepts valid integer and up-to-4-decimal strings and formats to 4 decimals', () => {
      expect(zDecimal4.parse('0')).toBe('0.0000');
      expect(zDecimal4.parse('10')).toBe('10.0000');
      expect(zDecimal4.parse('10.5')).toBe('10.5000');
      expect(zDecimal4.parse('10.1234')).toBe('10.1234');
      expect(zDecimal4.parse('-42.01')).toBe('-42.0100');
      expect(zDecimal4.parse('-0.0000')).toBe('0.0000');
    });

    it('rejects inputs with more than 4 decimal places with DECIMAL_PRECISION_EXCEEDED', () => {
      const result = zDecimal4.safeParse('4.12345');
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0];
        expect(issue?.params?.code).toBe(DECIMAL_PRECISION_EXCEEDED_CODE);
      }

      const negResult = zDecimal4.safeParse('-0.00001');
      expect(negResult.success).toBe(false);
      if (!negResult.success) {
        expect(negResult.error.issues[0]?.params?.code).toBe(DECIMAL_PRECISION_EXCEEDED_CODE);
      }
    });

    it('rejects non-numeric, empty, scientific notation, or whitespace strings', () => {
      expect(zDecimal4.safeParse('').success).toBe(false);
      expect(zDecimal4.safeParse('abc').success).toBe(false);
      expect(zDecimal4.safeParse('1e5').success).toBe(false);
      expect(zDecimal4.safeParse(' 10.00').success).toBe(false);
      expect(zDecimal4.safeParse('10.').success).toBe(false);
      expect(zDecimal4.safeParse('.5').success).toBe(false);
      expect(zDecimal4.safeParse(10 as unknown).success).toBe(false);
    });

    it('enforces NUMERIC(18, 4) overflow bounds (14 integer digits + 4 decimal digits)', () => {
      expect(zDecimal4.parse(MAX_DECIMAL4)).toBe('99999999999999.9999');
      expect(zDecimal4.parse(MIN_DECIMAL4)).toBe('-99999999999999.9999');

      const overMax = zDecimal4.safeParse('100000000000000.0000');
      expect(overMax.success).toBe(false);
      if (!overMax.success) {
        expect(overMax.error.issues[0]?.params?.code).toBe(DECIMAL_OVERFLOW_CODE);
      }

      const underMin = zDecimal4.safeParse('-100000000000000.0000');
      expect(underMin.success).toBe(false);
      if (!underMin.success) {
        expect(underMin.error.issues[0]?.params?.code).toBe(DECIMAL_OVERFLOW_CODE);
      }
    });

    it('provides branded Zod schemas for Quantity, UnitCost, and Money', () => {
      expect(zQuantity.parse('5.25')).toBe('5.2500');
      expect(zUnitCost.parse('12.3456')).toBe('12.3456');
      expect(zMoney.parse('100')).toBe('100.0000');
    });
  });

  describe('comparisons (preventing lexicographical string bugs)', () => {
    it('compares "9.0000" < "10.0000" numerically, not lexicographically', () => {
      const nine = formatDecimal4('9');
      const ten = formatDecimal4('10');

      expect(lt(nine, ten)).toBe(true);
      expect(lte(nine, ten)).toBe(true);
      expect(gt(nine, ten)).toBe(false);
      expect(gte(nine, ten)).toBe(false);
      expect(gt(ten, nine)).toBe(true);
      expect(eq(nine, formatDecimal4('9.0000'))).toBe(true);
    });

    it('handles negative comparisons and zero predicates accurately', () => {
      const negTen = formatDecimal4('-10');
      const negTwo = formatDecimal4('-2');

      expect(lt(negTen, negTwo)).toBe(true);
      expect(gt(negTwo, negTen)).toBe(true);

      expect(isZero(ZERO_DECIMAL4)).toBe(true);
      expect(isPositive(ZERO_DECIMAL4)).toBe(false);
      expect(isNegative(ZERO_DECIMAL4)).toBe(false);
      expect(isZeroOrNegative(ZERO_DECIMAL4)).toBe(true);

      expect(isPositive(formatDecimal4('0.0001'))).toBe(true);
      expect(isNegative(formatDecimal4('-0.0001'))).toBe(true);
      expect(isZeroOrNegative(formatDecimal4('-0.0001'))).toBe(true);
    });
  });

  describe('arithmetic & rounding', () => {
    it('performs exact 4-decimal arithmetic without floating point drift', () => {
      const a = toMoney('0.1');
      const b = toMoney('0.2');
      expect(add(a, b)).toBe('0.3000');
      expect(sub(toMoney('1.0000'), toMoney('0.3333'))).toBe('0.6667');
      expect(mul(toQuantity('3.0000'), toUnitCost('2.3333'))).toBe('6.9999');
      expect(div(toMoney('10.0000'), toQuantity('3.0000'))).toBe('3.3333');
      expect(div(toMoney('2.0000'), toQuantity('3.0000'))).toBe('0.6667');
      expect(negate(toQuantity('5.5'))).toBe('-5.5000');
      expect(negate(ZERO_DECIMAL4)).toBe('0.0000');
      expect(abs(toQuantity('-5.5'))).toBe('5.5000');
    });

    it('rounds half-up to 4 decimal places via round4', () => {
      expect(round4('1.23454')).toBe('1.2345');
      expect(round4('1.23455')).toBe('1.2346');
      expect(round4('-1.23455')).toBe('-1.2346');
    });

    it('throws on division by zero and overflow', () => {
      expect(() => div(toMoney('10'), ZERO_DECIMAL4)).toThrow(/zero/i);
      expect(() => add(formatDecimal4(MAX_DECIMAL4), formatDecimal4('0.0001'))).toThrow(
        /overflow/i,
      );
      expect(() => sub(formatDecimal4(MIN_DECIMAL4), formatDecimal4('0.0001'))).toThrow(
        /overflow/i,
      );
    });
  });

  describe('calculateWeightedAverageCost (ADR-0005)', () => {
    it('computes standard weighted average cost when oldQty > 0 and newQty > 0', () => {
      // (10 * 5.0000 + 5 * 8.0000) / 15 = 90 / 15 = 6.0000
      const res1 = calculateWeightedAverageCost(
        toQuantity('10'),
        toUnitCost('5'),
        toQuantity('5'),
        toUnitCost('8'),
      );
      expect(res1).toEqual({
        weightedAverageCost: '6.0000',
        estimatedNegativeStock: false,
      });

      // Rounding check: (1 * 10 + 2 * 11) / 3 = 32 / 3 = 10.6667
      const res2 = calculateWeightedAverageCost(
        toQuantity('1'),
        toUnitCost('10'),
        toQuantity('2'),
        toUnitCost('11'),
      );
      expect(res2).toEqual({
        weightedAverageCost: '10.6667',
        estimatedNegativeStock: false,
      });
    });

    it('resets WAC to incoming unitCost when recovering from zero or negative stock (oldQty <= 0 && newQty > 0)', () => {
      // From 0 to positive
      expect(
        calculateWeightedAverageCost(
          toQuantity('0'),
          toUnitCost('5'),
          toQuantity('10'),
          toUnitCost('12.50'),
        ),
      ).toEqual({
        weightedAverageCost: '12.5000',
        estimatedNegativeStock: false,
      });

      // From negative (-3) + 10 = +7 -> resets to incoming unitCost
      expect(
        calculateWeightedAverageCost(
          toQuantity('-3'),
          toUnitCost('5'),
          toQuantity('10'),
          toUnitCost('12.50'),
        ),
      ).toEqual({
        weightedAverageCost: '12.5000',
        estimatedNegativeStock: false,
      });
    });

    it('preserves oldWac and flags estimatedNegativeStock when newQty <= 0 (including recovery to exactly 0)', () => {
      // -10 + 10 = 0 (must not divide by zero!)
      expect(
        calculateWeightedAverageCost(
          toQuantity('-10'),
          toUnitCost('7.25'),
          toQuantity('10'),
          toUnitCost('9.00'),
        ),
      ).toEqual({
        weightedAverageCost: '7.2500',
        estimatedNegativeStock: true,
      });

      // -10 + 4 = -6 (still negative)
      expect(
        calculateWeightedAverageCost(
          toQuantity('-10'),
          toUnitCost('7.25'),
          toQuantity('4'),
          toUnitCost('9.00'),
        ),
      ).toEqual({
        weightedAverageCost: '7.2500',
        estimatedNegativeStock: true,
      });

      // 5 + (-5) = 0 (issue/adjustment bringing stock to 0)
      expect(
        calculateWeightedAverageCost(
          toQuantity('5'),
          toUnitCost('7.25'),
          toQuantity('-5'),
          toUnitCost('9.00'),
        ),
      ).toEqual({
        weightedAverageCost: '7.2500',
        estimatedNegativeStock: true,
      });
    });
  });
});
