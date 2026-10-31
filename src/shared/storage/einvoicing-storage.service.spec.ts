import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';

// Cliente de Supabase falso: guarda lo subido en memoria y registra las firmas.
const subidos = new Map<string, { body: Buffer; opts: unknown }>();
const firmas: { paths: string[]; segundos: number }[] = [];
const estado = { sinFirmar: false };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      getBucket: async () => ({ data: { public: false } }),
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload: async (path: string, body: Buffer, opts: unknown) => {
          subidos.set(path, { body, opts });
          return { error: null };
        },
        download: async (path: string) => {
          const f = subidos.get(path);
          if (!f) return { data: null, error: { message: 'no existe' } };
          return {
            data: { type: '', arrayBuffer: async () => f.body },
            error: null,
          };
        },
        createSignedUrls: async (paths: string[], segundos: number) => {
          firmas.push({ paths, segundos });
          if (estado.sinFirmar) return { data: [], error: null };
          return {
            data: paths.map((p) => ({ path: p, signedUrl: `https://x/${p}?t=1` })),
            error: null,
          };
        },
        remove: async () => ({ error: null }),
      }),
    },
  }),
}));

import { EinvoicingStorageService } from './einvoicing-storage.service';
import { StorageService } from './storage.service';
import { TenantContext } from '../tenancy/tenant-context';

const config = (valores: Record<string, string>) =>
  ({ get: (k: string) => valores[k] }) as never;

function crear(conLlaves = true) {
  const storage = new StorageService(
    config(
      conLlaves
        ? { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }
        : {},
    ),
  );
  return new EinvoicingStorageService(storage);
}

const enEmpresa = <T>(fn: () => T, businessId = 'emp1') =>
  TenantContext.run({ businessId, dbName: `biz_${businessId}` }, fn);

describe('EinvoicingStorageService', () => {
  beforeEach(() => {
    subidos.clear();
    firmas.length = 0;
    estado.sinFirmar = false;
  });

  it('guarda y lee el certificado bajo la carpeta cert de la empresa del contexto', async () => {
    const svc = crear();
    const p12 = Buffer.from([1, 2, 3]);
    const { pathname } = await enEmpresa(() =>
      svc.guardarCertificado('em1', 'firma.p12', p12),
    );
    expect(pathname).toBe('einvoicing/emp1/em1/cert/firma.p12');
    expect(subidos.get(pathname)?.opts).toMatchObject({
      contentType: 'application/x-pkcs12',
    });
    const leido = await enEmpresa(() => svc.leerCertificado('em1', 'firma.p12'));
    expect(leido.equals(p12)).toBe(true);
  });

  it('la empresa sale del TenantContext: otra empresa escribe en otra carpeta', async () => {
    const svc = crear();
    await enEmpresa(() => svc.guardarCertificado('em1', 'a.p12', Buffer.from('a')), 'empA');
    await enEmpresa(() => svc.guardarCertificado('em1', 'a.p12', Buffer.from('b')), 'empB');
    expect([...subidos.keys()].sort()).toEqual([
      'einvoicing/empA/em1/cert/a.p12',
      'einvoicing/empB/em1/cert/a.p12',
    ]);
  });

  it('sin TenantContext no hace nada', async () => {
    await expect(
      crear().guardarCertificado('em1', 'a.p12', Buffer.from('a')),
    ).rejects.toThrow(/contexto de empresa/);
    expect(subidos.size).toBe(0);
  });

  it('guarda xml, pdf y zip con su tipo de contenido', async () => {
    const svc = crear();
    for (const tipo of ['xml', 'pdf', 'zip'] as const) {
      await enEmpresa(() => svc.guardarArtefacto('em1', 'doc1', tipo, Buffer.from(tipo)));
    }
    expect([...subidos.keys()].sort()).toEqual([
      'einvoicing/emp1/em1/docs/doc1/documento.pdf',
      'einvoicing/emp1/em1/docs/doc1/documento.xml',
      'einvoicing/emp1/em1/docs/doc1/documento.zip',
    ]);
    expect(subidos.get('einvoicing/emp1/em1/docs/doc1/documento.xml')?.opts).toMatchObject({
      contentType: 'application/xml',
    });
    const xml = await enEmpresa(() => svc.leerArtefacto('em1', 'doc1', 'xml'));
    expect(xml.toString()).toBe('xml');
  });

  it('firma la URL de un artefacto con vida corta y la limita', async () => {
    const svc = crear();
    const url = await enEmpresa(() => svc.urlFirmadaArtefacto('em1', 'doc1', 'pdf'));
    expect(url).toContain('einvoicing/emp1/em1/docs/doc1/documento.pdf');
    expect(firmas[0]?.segundos).toBe(300);
    await enEmpresa(() => svc.urlFirmadaArtefacto('em1', 'doc1', 'pdf', 86_400));
    expect(firmas[1]?.segundos).toBe(900);
  });

  it('el certificado no tiene URL firmada: no hay método y el tipo p12 se rechaza', async () => {
    const svc = crear();
    const metodos = Object.getOwnPropertyNames(EinvoicingStorageService.prototype);
    expect(metodos.filter((m) => /certificado/i.test(m) && /url|firm/i.test(m))).toEqual([]);
    await expect(
      enEmpresa(() => svc.urlFirmadaArtefacto('em1', 'doc1', 'p12' as never)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(firmas).toHaveLength(0);
  });

  it("un docId 'cert' queda en docs/, nunca dentro de cert/", async () => {
    const { pathname } = await enEmpresa(() =>
      crear().guardarArtefacto('em1', 'cert', 'xml', Buffer.from('x')),
    );
    expect(pathname).toBe('einvoicing/emp1/em1/docs/cert/documento.xml');
  });

  it('StorageService.firmarUrls se niega a firmar un .p12 o cualquier cert/', async () => {
    const storage = new StorageService(
      config({ SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
    );
    for (const ruta of [
      'einvoicing/emp1/em1/cert/firma.p12',
      'facturas/emp1/FIRMA.P12',
      'einvoicing/emp1/em1/cert/otro.txt',
    ]) {
      await expect(storage.firmarUrls([ruta])).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(firmas).toHaveLength(0);
  });

  it('si no se pudo firmar, responde 404 en vez de una URL vacía', async () => {
    estado.sinFirmar = true;
    await expect(
      enEmpresa(() => crear().urlFirmadaArtefacto('em1', 'doc1', 'xml')),
    ).rejects.toThrow(/no está disponible/);
  });

  it('sin almacenamiento configurado responde 503', async () => {
    await expect(
      enEmpresa(() => crear(false).urlFirmadaArtefacto('em1', 'doc1', 'xml')),
    ).rejects.toThrow(/no está configurado/);
  });

  describe('path traversal', () => {
    const malos = ['..', '../x', 'a/b', 'a\\b', '', '.', 'a b', '%2e%2e', 'x..y/z', 'a\0b'];

    it.each(malos)('rechaza %j como emisor y como documento', async (valor) => {
      const svc = crear();
      await expect(
        enEmpresa(() => svc.guardarArtefacto(valor, 'doc1', 'xml', Buffer.from('x'))),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        enEmpresa(() => svc.guardarArtefacto('em1', valor, 'xml', Buffer.from('x'))),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(subidos.size).toBe(0);
    });

    it.each([
      '../a.p12', 'a/b.p12', '.p12', 'a.pfx', 'a.p12.exe', 'a.xml', '',
      'a\\b.p12', '/etc/passwd', '..\\a.p12',
    ])('rechaza el nombre de certificado %j', async (nombre) => {
      await expect(
        enEmpresa(() => crear().guardarCertificado('em1', nombre, Buffer.from('x'))),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(subidos.size).toBe(0);
    });

    it('rechaza una empresa del contexto con forma de ruta', async () => {
      await expect(
        enEmpresa(
          () => crear().guardarCertificado('em1', 'a.p12', Buffer.from('x')),
          '../otra',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza un tipo de artefacto fuera de la lista', async () => {
      await expect(
        enEmpresa(() =>
          crear().guardarArtefacto('em1', 'doc1', 'p12' as never, Buffer.from('x')),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('leerArtefactoGuardado (ruta guardada en el documento)', () => {
    const DOC = 'doc1';
    const ruta = 'einvoicing/emp1/em1/docs/doc1/documento.xml';

    function conEspia() {
      const storage = new StorageService(
        config({ SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
      );
      const descargas = vi.spyOn(storage, 'descargarPrivado');
      return { svc: new EinvoicingStorageService(storage), descargas };
    }

    beforeEach(() => {
      // Hay archivos en todas las rutas que se prueban: si se rechaza es por
      // la validación, no porque el archivo no exista.
      for (const p of [
        ruta,
        'einvoicing/emp2/em1/docs/doc1/documento.xml',
        'einvoicing/emp1/em1/docs/doc2/documento.xml',
        'einvoicing/emp1/em1/docs/doc1/documento.pdf',
        'einvoicing/emp1/em1/cert/firma.p12',
      ]) {
        subidos.set(p, { body: Buffer.from(`contenido de ${p}`), opts: {} });
      }
    });

    it('lee la ruta canónica de la empresa del contexto y del documento', async () => {
      const { svc, descargas } = conEspia();
      const b = await enEmpresa(() => svc.leerArtefactoGuardado(ruta, DOC, 'xml'));
      expect(b.toString()).toBe(`contenido de ${ruta}`);
      expect(descargas).toHaveBeenCalledWith(ruta);
      // Otro emisor de la misma empresa también vale (la sede pudo cambiar de emisor).
      subidos.set('einvoicing/emp1/emViejo/docs/doc1/documento.xml', { body: Buffer.from('viejo'), opts: {} });
      const viejo = await enEmpresa(() =>
        svc.leerArtefactoGuardado('einvoicing/emp1/emViejo/docs/doc1/documento.xml', DOC, 'xml'),
      );
      expect(viejo.toString()).toBe('viejo');
    });

    it.each([
      ['otra empresa', 'einvoicing/emp2/em1/docs/doc1/documento.xml'],
      ['otro documento', 'einvoicing/emp1/em1/docs/doc2/documento.xml'],
      ['otro tipo', 'einvoicing/emp1/em1/docs/doc1/documento.pdf'],
      ['el certificado', 'einvoicing/emp1/em1/cert/firma.p12'],
      ['.. como emisor', 'einvoicing/emp1/../docs/doc1/documento.xml'],
      ['.. dentro del documento', 'einvoicing/emp1/em1/docs/../documento.xml'],
      ['segmento de más', 'einvoicing/emp1/em1/x/docs/doc1/documento.xml'],
      ['segmento de más al final', 'einvoicing/emp1/em1/docs/doc1/documento.xml/x'],
      ['segmento de menos', 'einvoicing/emp1/docs/doc1/documento.xml'],
      ['barra inicial', '/einvoicing/emp1/em1/docs/doc1/documento.xml'],
      ['barra invertida', 'einvoicing\\emp1\\em1\\docs\\doc1\\documento.xml'],
      ['otra raíz', 'otra/emp1/em1/docs/doc1/documento.xml'],
      ['emisor con caracteres raros', 'einvoicing/emp1/em 1/docs/doc1/documento.xml'],
      ['vacía', ''],
      ['ausente', undefined],
    ])('rechaza %s sin tocar el bucket', async (_n, pathname) => {
      const { svc, descargas } = conEspia();
      await expect(
        enEmpresa(() => svc.leerArtefactoGuardado(pathname, DOC, 'xml')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(descargas).not.toHaveBeenCalled();
    });

    it('pedir otro tipo con la ruta del XML se rechaza', async () => {
      const { svc, descargas } = conEspia();
      await expect(
        enEmpresa(() => svc.leerArtefactoGuardado(ruta, DOC, 'pdf')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(descargas).not.toHaveBeenCalled();
    });

    it('sin TenantContext no lee nada', async () => {
      const { svc, descargas } = conEspia();
      await expect(svc.leerArtefactoGuardado(ruta, DOC, 'xml')).rejects.toThrow(/contexto de empresa/);
      expect(descargas).not.toHaveBeenCalled();
    });
  });
});
