import { describe, it, expect } from 'vitest';
import { DIAN_STATUS, DOC_TYPES } from './einvoicing.constants';
import {
  CODIGOS_SIN_VEREDICTO,
  assertTransicion,
  esVeredictoDian,
  estadoTrasRespuesta,
  quedaEnVuelo,
  transicionPermitida,
} from './estado-dian';
import { resolverTransmisor } from './resolver-transmisor';
import { StubDian } from './stub-dian';
import { assertContratoRespuesta, type RespuestaDian } from './transmisor-dian';
import type { DianStatus } from './einvoicing.constants';

describe('constantes', () => {
  it('amplía tipos y estados, sin pending', () => {
    expect(DOC_TYPES).toEqual([
      'invoice',
      'pos',
      'credit_note',
      'debit_note',
      'payroll',
      'payroll_adjustment',
    ]);
    expect(DIAN_STATUS).toEqual([
      'draft',
      'signed',
      'sent',
      'accepted',
      'rejected',
      'contingency',
    ]);
  });
});

describe('transiciones', () => {
  it('permite el camino feliz', () => {
    expect(transicionPermitida('draft', 'signed')).toBe(true);
    expect(transicionPermitida('signed', 'sent')).toBe(true);
    expect(transicionPermitida('sent', 'accepted')).toBe(true);
    expect(transicionPermitida('sent', 'rejected')).toBe(true);
    expect(transicionPermitida('rejected', 'signed')).toBe(true);
    expect(transicionPermitida('contingency', 'signed')).toBe(true);
  });

  it('contingencia y en vuelo', () => {
    expect(transicionPermitida('contingency', 'accepted')).toBe(false);
    expect(transicionPermitida('contingency', 'sent')).toBe(false);
    expect(transicionPermitida('sent', 'contingency')).toBe(false);
    expect(transicionPermitida('sent', 'draft')).toBe(false);
  });

  const ESPERADAS: Record<DianStatus, DianStatus[]> = {
    draft: ['signed', 'contingency'],
    signed: ['sent', 'contingency'],
    sent: ['sent', 'accepted', 'rejected'],
    accepted: [],
    rejected: ['signed'],
    contingency: ['signed'],
  };
  const PARES = DIAN_STATUS.flatMap((d) =>
    DIAN_STATUS.map((h) => [d, h] as const),
  );
  it.each(PARES)('%s → %s', (desde, hacia) => {
    expect(transicionPermitida(desde, hacia)).toBe(
      ESPERADAS[desde].includes(hacia),
    );
  });

  it('rechaza saltos y salidas de estados terminales', () => {
    expect(transicionPermitida('draft', 'accepted')).toBe(false);
    expect(transicionPermitida('draft', 'rejected')).toBe(false);
    expect(transicionPermitida('signed', 'rejected')).toBe(false);
    expect(transicionPermitida('accepted', 'rejected')).toBe(false);
    expect(transicionPermitida('accepted', 'draft')).toBe(false);
    expect(transicionPermitida('rejected', 'accepted')).toBe(false);
    expect(() => assertTransicion('draft', 'accepted')).toThrow();
    expect(() => assertTransicion('draft', 'signed')).not.toThrow();
  });
});

describe('esVeredictoDian / quedaEnVuelo', () => {
  it('IsValid de la DIAN es veredicto, true o false', () => {
    expect(esVeredictoDian({ origen: 'dian', isValid: true })).toBe(true);
    expect(esVeredictoDian({ origen: 'dian', isValid: false })).toBe(true);
    expect(quedaEnVuelo({ origen: 'dian', isValid: false })).toBe(false);
  });

  it('nada del adaptador es veredicto', () => {
    expect(esVeredictoDian({ origen: 'adapter', isValid: false })).toBe(false);
    expect(esVeredictoDian({ origen: 'adapter' })).toBe(false);
  });

  it('sin IsValid booleano no hay veredicto', () => {
    expect(esVeredictoDian({ origen: 'dian' })).toBe(false);
    expect(esVeredictoDian({ origen: 'dian', codigo: 'X' })).toBe(false);
  });

  it.each(CODIGOS_SIN_VEREDICTO)(
    '%s nunca es veredicto, ni con IsValid=false',
    (codigo) => {
      const r = { origen: 'dian' as const, isValid: false, codigo };
      expect(esVeredictoDian(r)).toBe(false);
      expect(quedaEnVuelo(r)).toBe(true);
    },
  );
});

/** Respuesta completa a partir de lo que importa en cada caso. */
function resp(
  p: Partial<RespuestaDian> & Pick<RespuestaDian, 'origen'>,
): RespuestaDian {
  return { ok: p.isValid === true && p.origen === 'dian', mensajes: [], ...p };
}

describe('estadoTrasRespuesta', () => {
  it('veredicto válido acepta, inválido rechaza', () => {
    expect(
      estadoTrasRespuesta('sent', resp({ origen: 'dian', isValid: true })),
    ).toBe('accepted');
    expect(
      estadoTrasRespuesta('sent', resp({ origen: 'dian', isValid: false })),
    ).toBe('rejected');
  });

  it('YA_PROCESADO_DIAN con IsValid=false sigue en vuelo, nunca rejected', () => {
    const r = resp({
      origen: 'dian',
      isValid: false,
      codigo: 'YA_PROCESADO_DIAN',
    });
    expect(quedaEnVuelo(r)).toBe(true);
    expect(estadoTrasRespuesta('sent', r)).toBe('sent');
    expect(estadoTrasRespuesta('signed', r)).toBe('sent');
  });

  it('en vuelo nunca pasa a rejected ni accepted sin veredicto', () => {
    for (const codigo of CODIGOS_SIN_VEREDICTO) {
      expect(
        estadoTrasRespuesta('sent', resp({ origen: 'adapter', codigo })),
      ).toBe('sent');
      expect(
        estadoTrasRespuesta(
          'sent',
          resp({ origen: 'dian', isValid: false, codigo }),
        ),
      ).toBe('sent');
    }
  });

  it('RED sobre firmado da sent: el timeout pudo llegar con la DIAN ya con el documento', () => {
    expect(
      estadoTrasRespuesta('signed', resp({ origen: 'adapter', codigo: 'RED' })),
    ).toBe('sent');
  });

  it('CONFIG_FALTANTE no mueve nada (no salió a la red)', () => {
    const r = resp({ origen: 'adapter', codigo: 'CONFIG_FALTANTE' });
    expect(estadoTrasRespuesta('signed', r)).toBe('signed');
    expect(estadoTrasRespuesta('draft', r)).toBe('draft');
  });

  it('PENDIENTE_DIAN sobre firmado lo deja en vuelo', () => {
    expect(
      estadoTrasRespuesta(
        'signed',
        resp({ origen: 'dian', codigo: 'PENDIENTE_DIAN' }),
      ),
    ).toBe('sent');
  });

  it('un veredicto sobre un borrador, un firmado o un aceptado es un error de flujo', () => {
    for (const e of ['draft', 'signed', 'accepted'] as const) {
      expect(() =>
        estadoTrasRespuesta(e, resp({ origen: 'dian', isValid: true })),
      ).toThrow();
      expect(() =>
        estadoTrasRespuesta(e, resp({ origen: 'dian', isValid: false })),
      ).toThrow();
    }
  });

  it('una respuesta que rompe el contrato lanza', () => {
    expect(() =>
      estadoTrasRespuesta('sent', {
        ok: true,
        origen: 'dian',
        isValid: false,
        mensajes: [],
      }),
    ).toThrow();
  });
});

describe('assertContratoRespuesta', () => {
  it('ok:true solo con isValid=true y origen dian', () => {
    expect(() =>
      assertContratoRespuesta({
        ok: true,
        isValid: true,
        origen: 'dian',
        mensajes: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertContratoRespuesta({
        ok: true,
        isValid: true,
        origen: 'adapter',
        mensajes: [],
      }),
    ).toThrow();
    expect(() =>
      assertContratoRespuesta({ ok: true, origen: 'dian', mensajes: [] }),
    ).toThrow();
    expect(() =>
      assertContratoRespuesta({
        ok: true,
        isValid: false,
        origen: 'dian',
        mensajes: [],
      }),
    ).toThrow();
    expect(() =>
      assertContratoRespuesta({ ok: false, origen: 'adapter', mensajes: [] }),
    ).not.toThrow();
    expect(() =>
      assertContratoRespuesta({
        ok: false,
        isValid: true,
        origen: 'dian',
        mensajes: [],
      }),
    ).toThrow();
    expect(() =>
      estadoTrasRespuesta('sent', {
        ok: false,
        isValid: true,
        origen: 'dian',
        mensajes: [],
      }),
    ).toThrow();
  });
});

describe('StubDian', () => {
  it('nunca acepta, nunca da veredicto y responde CONFIG_FALTANTE', async () => {
    const stub = new StubDian();
    const rs = [
      await stub.enviar({ tipo: 'invoice', fullNumber: 'FE1' }),
      await stub.enviarSetPruebas({ tipo: 'invoice', fullNumber: 'FE1' }),
      await stub.consultar({ trackId: 't' }),
      await stub.rangos('900123456'),
    ];
    for (const r of rs) {
      expect(r.ok).toBe(false);
      expect(r.codigo).toBe('CONFIG_FALTANTE');
      expect(r.origen).toBe('adapter');
      expect(r.isValid).toBeUndefined();
      expect(esVeredictoDian(r)).toBe(false);
    }
  });
});

describe('resolverTransmisor', () => {
  const completo = {
    certificadoVigente: true,
    softwareId: 'sw-1',
    tienePin: true,
  };

  it.each([
    [
      'sin certificado vigente',
      { ...completo, certificadoVigente: false },
      'certificado',
    ],
    ['sin SoftwareID', { ...completo, softwareId: undefined }, 'SoftwareID'],
    [
      'con SoftwareID en blanco',
      { ...completo, softwareId: '  ' },
      'SoftwareID',
    ],
    ['sin PIN', { ...completo, tienePin: false }, 'PIN'],
  ])('%s devuelve stub con CONFIG_FALTANTE', async (_n, emisor, texto) => {
    const t = resolverTransmisor(emisor);
    expect(t).toBeInstanceOf(StubDian);
    const r = await t.enviar({ tipo: 'invoice', fullNumber: 'FE1' });
    expect(r.codigo).toBe('CONFIG_FALTANTE');
    expect(r.mensajes.join(' ')).toContain(texto);
  });

  it('hasta las Fases 3-4 incluso un emisor completo recibe el stub', async () => {
    const r = await resolverTransmisor(completo).enviar({
      tipo: 'invoice',
      fullNumber: 'FE1',
    });
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe('CONFIG_FALTANTE');
  });
});
