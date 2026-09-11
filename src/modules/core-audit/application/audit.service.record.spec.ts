import { describe, it, expect, vi, beforeEach } from 'vitest';

// SWC emite `Object` como metadata para los @Prop() con uniones de literales y
// @nestjs/mongoose revienta al importar los esquemas. Mismo patrón que el resto
// de las pruebas.
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

import { AuditService } from './audit.service';

/**
 * Registro de auditoría: quién hizo qué y cuándo.
 *
 * Tiene una regla que va en contra del instinto: NUNCA puede lanzar. Si la
 * escritura del log falla, la venta o el gasto que se estaba haciendo tienen
 * que completarse igual. Auditar es importante, pero no más que operar.
 *
 * La otra pieza es el módulo, que se deduce del primer tramo de la ruta y es lo
 * que después permite filtrar el historial. Si se dedujera mal, los registros
 * existirían pero nadie los encontraría.
 *
 * El servicio se instancia DIRECTAMENTE con el modelo mockeado.
 */
describe('AuditService', () => {
  let logs: any;
  let service: AuditService;

  function build() {
    const query: any = {
      sort: vi.fn(() => query),
      limit: vi.fn(() => query),
      exec: vi.fn().mockResolvedValue([]),
    };
    logs = {
      create: vi.fn().mockResolvedValue({}),
      find: vi.fn(() => query),
      distinct: vi.fn(() => ({ exec: () => Promise.resolve([]) })),
      _query: query,
    };
    service = new AuditService(logs as never);
  }

  const evento = {
    userEmail: 'duena@negocio.com',
    method: 'POST',
    path: '/finance/expenses',
    statusCode: 201,
    success: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    build();
  });

  describe('registro', () => {
    it('guarda el evento con el módulo deducido de la ruta', async () => {
      await service.record(evento);

      expect(logs.create.mock.calls[0][0]).toMatchObject({
        module: 'finance',
        path: '/finance/expenses',
        userEmail: 'duena@negocio.com',
      });
    });

    it('una ruta de un solo tramo también tiene módulo', async () => {
      await service.record({ ...evento, path: '/sales' });

      expect(logs.create.mock.calls[0][0].module).toBe('sales');
    });

    it('la raíz no deja el módulo vacío', async () => {
      await service.record({ ...evento, path: '/' });

      expect(logs.create.mock.calls[0][0].module).toBe('/');
    });

    it('los parámetros de consulta no se cuelan en el módulo', async () => {
      await service.record({ ...evento, path: '/reports?from=2026-01-01' });

      expect(logs.create.mock.calls[0][0].module).toBe('reports');
    });

    it('un fallo al auditar NO tumba la operación de negocio', async () => {
      logs.create.mockRejectedValue(new Error('colección de solo lectura'));

      await expect(service.record(evento)).resolves.toBeUndefined();
    });

    it('registra también las operaciones fallidas, con su error', async () => {
      await service.record({
        ...evento,
        success: false,
        statusCode: 403,
        error: 'No tiene permisos para esta acción',
      });

      expect(logs.create.mock.calls[0][0]).toMatchObject({
        success: false,
        statusCode: 403,
        error: 'No tiene permisos para esta acción',
      });
    });
  });

  describe('consulta', () => {
    it('filtra por usuario y módulo', async () => {
      await service.list({ userEmail: 'a@b.c', module: 'finance' });

      expect(logs.find.mock.calls[0][0]).toMatchObject({
        userEmail: 'a@b.c',
        module: 'finance',
      });
    });

    it('el método se normaliza a mayúsculas', async () => {
      await service.list({ method: 'post' });

      expect(logs.find.mock.calls[0][0].method).toBe('POST');
    });

    it('el rango de fechas cubre el día completo del extremo final', async () => {
      // Si el "hasta" se tomara a medianoche, se perdería todo lo del último
      // día, que es justo lo que se suele estar buscando.
      await service.list({ from: '2026-09-01', to: '2026-09-10' });

      const rango = logs.find.mock.calls[0][0].at;
      expect(rango.$gte.getHours()).toBe(0);
      expect(rango.$lte.getHours()).toBe(23);
      expect(rango.$lte.getMinutes()).toBe(59);
    });

    it('sin fechas no filtra por rango', async () => {
      await service.list({});

      expect(logs.find.mock.calls[0][0].at).toBeUndefined();
    });

    it('acota el tamaño de la respuesta', async () => {
      await service.list({ limit: 100_000 });

      expect(logs._query.limit).toHaveBeenCalledWith(1_000);
    });

    it('un límite absurdo por abajo tampoco pasa', async () => {
      await service.list({ limit: 0 });

      expect(logs._query.limit).toHaveBeenCalledWith(1);
    });

    it('devuelve lo más reciente primero', async () => {
      await service.list({});

      expect(logs._query.sort).toHaveBeenCalledWith({ at: -1 });
    });
  });
});
