import {describe, expect, it} from 'vitest';
import {normalizeProductCode} from './avLookup';

describe('tablet AV product-code normalizer', () => {
  it.each([
    [' SSIS-123 ', 'SSIS-123'],
    ['ssis123', 'SSIS-123'],
    ['SSIS 123', 'SSIS-123'],
    ['FC2PPV 1234567', 'FC2-PPV-1234567'],
    ['FC2-PPV-1234567', 'FC2-PPV-1234567'],
    ['300MIUM 12A', '300MIUM-12A'],
    ['  ssis   123  ', 'SSIS-123'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeProductCode(input)).toBe(expected);
  });

  it.each(['', 'Actress Name', 'x'.repeat(61), 'A123', 'SSIS-1', 'SSIS-12345678'])('rejects %s', input => {
    expect(normalizeProductCode(input)).toBe('');
  });
});
