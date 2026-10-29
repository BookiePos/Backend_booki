import { describe, expect, it } from 'vitest';
import { proponerTipoDian } from './datos-fiscales';

describe('proponerTipoDian', () => {
  it('NIT con guion y DV válido', () => {
    expect(
      proponerTipoDian({ docType: 'NIT', docNumber: '860.002.964-4' }),
    ).toEqual({ dianDocType: '31', nitDv: '4' });
  });
  it('lo ambiguo no se toca', () => {
    expect(
      proponerTipoDian({ docType: 'NIT', docNumber: '8600029644' }),
    ).toBeUndefined();
    expect(
      proponerTipoDian({ docType: 'NIT', docNumber: '860002964-9' }),
    ).toBeUndefined();
    expect(
      proponerTipoDian({ docType: 'CC', docNumber: '860002964-4' }),
    ).toBeUndefined();
  });
});
