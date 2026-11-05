import { describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';

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

import { EmployeesController } from './employees.controller';
import { EmployeesService } from '../application/employees.service';

const CUENTA = '10012345601';

/** Las 4 rutas que devuelven un empleado deben pasar por `aVista`. */
describe('EmployeesController · número de cuenta', () => {
  function build() {
    const emp: any = {
      _id: new Types.ObjectId(),
      docNumber: '1',
      firstName: 'Ana',
      lastName: 'Pérez',
      accountNumber: CUENTA,
      save: vi.fn().mockResolvedValue(undefined),
      toObject() {
        return { _id: this._id, docNumber: this.docNumber, firstName: this.firstName, lastName: this.lastName, accountNumber: this.accountNumber };
      },
    };
    const model: any = Object.assign(function () { return emp; }, {
      find: vi.fn(() => ({ sort: () => ({ exec: () => Promise.resolve([emp]) }) })),
      findById: vi.fn(() => ({ exec: () => Promise.resolve(emp) })),
    });
    const service = new EmployeesService(model, {} as never);
    return { ctl: new EmployeesController(service), emp };
  }

  const sinNumero = (r: unknown) => {
    const t = JSON.stringify(r);
    expect(t).not.toContain(CUENTA);
    expect(t).toContain('••••5601');
  };

  it('listado', async () => {
    const { ctl } = build();
    sinNumero(await ctl.list(undefined as never));
  });

  it('detalle', async () => {
    const { ctl, emp } = build();
    sinNumero(await ctl.get(emp._id.toString(), undefined as never));
  });

  it('POST', async () => {
    const { ctl } = build();
    sinNumero(await ctl.create({ docNumber: '1', firstName: 'A', lastName: 'B' } as never, undefined as never));
  });

  it('PATCH', async () => {
    const { ctl, emp } = build();
    sinNumero(await ctl.update(emp._id.toString(), { phone: '1' } as never, undefined as never));
  });
});
