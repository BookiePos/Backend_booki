import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';

vi.mock('@nestjs/mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nestjs/mongoose')>();
  return {
    ...actual,
    Prop: () => () => undefined,
    Schema: () => () => undefined,
    SchemaFactory: {
      createForClass: () => ({ index: () => undefined, pre: () => undefined }),
    },
  };
});

import { InvoiceScanService } from './invoice-scan.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import type { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';

/**
 * Subir una factura electrónica con su XML.
 *
 * El XML trae los datos exactos, así que la factura tiene que quedar leída en
 * la misma subida —sin llamar a la IA— y lista para revisar. Y un XML que no
 * sirve se rechaza ANTES de cobrar el escaneo y de subir la imagen.
 */
describe('InvoiceScanService.upload · con XML de la DIAN', () => {
  const user = { userId: 'u1', email: 'due@negocio.com' } as unknown as JwtUser;
  const ctx = { businessId: 'b1', dbName: 'biz_b1', plan: 'pro' } as never;
  const file = {
    buffer: Buffer.from('soporte'),
    mimetype: 'image/jpeg',
    size: 1024,
    originalname: 'factura.jpg',
  };

  const XML = `<?xml version="1.0"?>
<Invoice xmlns:cac="urn:cac" xmlns:cbc="urn:cbc">
  <cbc:ID>FE-120</cbc:ID>
  <cbc:IssueDate>2026-09-01</cbc:IssueDate>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme>
    <cbc:RegistrationName>MANTENIMIENTOS ANDINOS SAS</cbc:RegistrationName>
    <cbc:CompanyID schemeName="31">901234567</cbc:CompanyID>
  </cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
  <cac:LegalMonetaryTotal><cbc:PayableAmount>119000.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:InvoicedQuantity unitCode="94">1.000000</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount>100000.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Description>Mantenimiento nevera</cbc:Description></cac:Item>
    <cac:Price><cbc:PriceAmount>100000.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

  function makeService() {
    const created = {
      _id: 's1',
      pages: [{ imageUrl: 'https://blob/f.jpg', imagePathname: 'f.jpg' }] as {
        imageUrl: string;
        imagePathname: string;
        model?: string;
        extractedAt?: Date;
      }[],
      history: [] as { action: string; detail?: string }[],
      lineDecisions: [],
      status: 'uploaded',
      draft: undefined as unknown,
      save: vi.fn().mockResolvedValue(undefined),
    };
    const scans = { create: vi.fn().mockResolvedValue(created) };
    const extractor = { extract: vi.fn(), extractText: vi.fn() };
    const matching = {
      matchSupplier: vi.fn().mockResolvedValue({ mode: 'new', supplierName: 'MANTENIMIENTOS ANDINOS SAS' }),
      matchLines: vi.fn().mockResolvedValue([]),
    };
    const storage = {
      assertAvailable: vi.fn(),
      upload: vi.fn().mockResolvedValue({ url: 'https://blob/f.jpg', pathname: 'f.jpg' }),
    };
    const businesses = { consumeScan: vi.fn().mockResolvedValue(undefined) };
    const service = new InvoiceScanService(
      scans as never,
      extractor as never,
      matching as never,
      storage as never,
      businesses as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, created, extractor, storage, businesses, matching };
  }

  it('deja la factura leída en la misma subida, con los datos del XML y sin IA', async () => {
    const { service, created, extractor, matching } = makeService();

    const scan = await TenantContext.run(ctx, () =>
      service.upload(file, user, undefined, XML),
    );

    expect(scan.status).toBe('extracted');
    expect(created.draft).toMatchObject({
      supplier: { name: 'MANTENIMIENTOS ANDINOS SAS', docNumber: '901234567' },
      invoice: { number: 'FE-120', issueDate: '2026-09-01' },
      totals: { total: 119000 },
    });
    expect((created.draft as { lines: unknown[] }).lines).toHaveLength(1);
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(extractor.extractText).not.toHaveBeenCalled();
    // Proveedor y renglones se emparejan igual que en una lectura con IA.
    expect(matching.matchSupplier).toHaveBeenCalledOnce();
    expect(created.history.some((h) => h.detail?.includes('XML'))).toBe(true);
  });

  it('un XML que no es factura se rechaza sin cobrar el escaneo ni subir nada', async () => {
    const { service, storage, businesses } = makeService();

    await expect(
      TenantContext.run(ctx, () =>
        service.upload(file, user, undefined, '<?xml version="1.0"?><Pedido/>'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(businesses.consumeScan).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
