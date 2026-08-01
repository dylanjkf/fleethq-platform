import { buildMatchConditions, decodeScan, SearchableFieldKey } from './barcode-matching';

describe('decodeScan', () => {
  it('always exposes the whole raw payload under `scan`', () => {
    expect(decodeScan('PLAINBARCODE')).toEqual({ scan: 'PLAINBARCODE' });
  });

  it('spreads a JSON object payload into named fields (plus `scan`)', () => {
    const raw = '{"trackingNumber":"T1","parcelCount":3}';
    expect(decodeScan(raw)).toEqual({ scan: raw, trackingNumber: 'T1', parcelCount: '3' });
  });

  it('parses key:value;key2:value2 pairs', () => {
    const raw = 'trackingNumber:T1;consignmentNumber:C1';
    expect(decodeScan(raw)).toEqual({ scan: raw, trackingNumber: 'T1', consignmentNumber: 'C1' });
  });

  it('treats a JSON array as opaque (not an object) — only `scan` is set', () => {
    expect(decodeScan('[1,2,3]')).toEqual({ scan: '[1,2,3]' });
  });
});

describe('buildMatchConditions', () => {
  const fields: SearchableFieldKey[] = [
    { key: 'reference', isCustom: false },
    { key: 'trackingNumber', isCustom: false },
    { key: 'palletId', isCustom: true },
  ];

  it('rawOr matches every field against the whole raw value; a custom field keys into customFields', () => {
    const { rawOr } = buildMatchConditions(fields, { scan: 'RAW-1' }, 'RAW-1');
    expect(rawOr).toEqual([
      { reference: 'RAW-1' },
      { trackingNumber: 'RAW-1' },
      { customFields: { path: ['palletId'], equals: 'RAW-1' } },
    ]);
  });

  it('targetedOr only includes fields the decode step actually produced, matched to their own value', () => {
    const decoded = { scan: 'x', trackingNumber: 'T9', palletId: 'P7' };
    const { targetedOr } = buildMatchConditions(fields, decoded, 'x');
    expect(targetedOr).toEqual([
      { trackingNumber: 'T9' },
      { customFields: { path: ['palletId'], equals: 'P7' } },
    ]);
  });

  it('drops a non-custom field whose key is not a known StopParcel column', () => {
    const { rawOr } = buildMatchConditions([{ key: 'notAColumn', isCustom: false }], { scan: 'v' }, 'v');
    expect(rawOr).toEqual([]);
  });

  it('returns empty condition sets when there are no searchable fields', () => {
    expect(buildMatchConditions([], { scan: 'v' }, 'v')).toEqual({ targetedOr: [], rawOr: [] });
  });
});
