import { describe, expect, it } from 'vitest';
import { validate as uuidValidate, version as uuidVersion } from 'uuid';
import { uuidv5, uuidv7 } from './index.js';

describe('ids', () => {
  it('generates valid UUIDv7 strings', () => {
    const id1 = uuidv7();
    const id2 = uuidv7();
    expect(uuidValidate(id1)).toBe(true);
    expect(uuidVersion(id1)).toBe(7);
    expect(id1).not.toBe(id2);
  });

  it('generates deterministic UUIDv5 strings for a namespace and name', () => {
    const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const a = uuidv5('line-1', namespace);
    const b = uuidv5('line-1', namespace);
    const c = uuidv5('line-2', namespace);

    expect(uuidValidate(a)).toBe(true);
    expect(uuidVersion(a)).toBe(5);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
