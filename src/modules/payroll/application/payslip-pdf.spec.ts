import { describe, expect, it } from 'vitest';
import { buildPayslipPdf, textoNominaElectronica } from './payslip-pdf';

const ceros = { total: 0 };
const breakdown = {
  diasTrabajados: 30,
  devengados: { salario: 0, auxilioTransporte: 0, recargoDetalle: [], total: 0 },
  deducciones: { salud: 0, pension: 0, total: 0 },
  aportesEmpleador: { salud: 0, pension: 0, arl: 0, ccf: 0, ...ceros },
  provisiones: { cesantias: 0, interesesCesantias: 0, prima: 0, vacaciones: 0, ...ceros },
  netoPagar: 0,
  costoEmpleador: 0,
  ibc: 0,
  horaOrdinaria: 0,
  baseRetencionUvt: 0,
} as never;

describe('desprendible · texto de nómina electrónica', () => {
  it('con documento aceptado cita el número y el CUNE completo', () => {
    const cune = 'a'.repeat(96);
    expect(textoNominaElectronica({ numero: 'NE15', cune })).toBe(
      `Documento soporte de pago de nómina electrónica N.º NE15 — CUNE ${cune}`,
    );
  });

  it('sin documento usa el texto neutro, sin afirmar que no existe', () => {
    const t = textoNominaElectronica(undefined);
    expect(t).toBe('Este desprendible no reemplaza el documento soporte de pago de nómina electrónica.');
    expect(t).not.toMatch(/no emite|no constituye/i);
  });

  it('el PDF se genera en ambos casos', async () => {
    const base = {
      employer: { name: 'Panadería SAS' },
      employee: { name: 'Ana Ruiz', salarioBase: 2_000_000 },
      period: '2026-09',
      breakdown,
    };
    for (const nominaElectronica of [undefined, { numero: 'NE15', cune: 'b'.repeat(96) }]) {
      const pdf = await buildPayslipPdf({ ...base, nominaElectronica });
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    }
  });
});
