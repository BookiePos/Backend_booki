import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEmployeeDto } from './create-employee.dto';
import { UpdateEmployeeDto } from './update-employee.dto';

const base = { docNumber: '123', firstName: 'Ana', lastName: 'Pérez' };

async function campos(clase: new () => object, o: object): Promise<string[]> {
  return (await validate(plainToInstance(clase, o))).map((e) => e.property);
}

describe('DTO de empleado: datos de nómina electrónica DIAN', () => {
  const validos = {
    secondLastName: 'Gómez',
    otherNames: 'María',
    docTypeDian: '13',
    tipoTrabajador: '01',
    subTipoTrabajador: '00',
    altoRiesgoPension: false,
    tipoContratoDian: '2',
    municipioDaneTrabajo: '05001',
    direccionTrabajo: 'Calle 1 # 2-3',
    medioPago: '47',
  };

  it('son opcionales: un empleado sin ellos sigue siendo válido', async () => {
    expect(await campos(CreateEmployeeDto, base)).toEqual([]);
    expect(await campos(UpdateEmployeeDto, {})).toEqual([]);
  });

  it('acepta códigos DIAN válidos', async () => {
    expect(await campos(CreateEmployeeDto, { ...base, ...validos })).toEqual([]);
    expect(await campos(UpdateEmployeeDto, validos)).toEqual([]);
  });

  it.each([
    ['docTypeDian', '99'],
    ['docTypeDian', 'CC'],
    ['tipoTrabajador', '03'],
    ['subTipoTrabajador', '02'],
    ['tipoContratoDian', '6'],
    ['tipoContratoDian', 'indefinido'],
    ['municipioDaneTrabajo', '5001'],
    ['municipioDaneTrabajo', 'Medellín'],
    ['medioPago', '99'],
    ['altoRiesgoPension', 'si'],
  ])('rechaza %s = %s', async (campo, valor) => {
    expect(await campos(CreateEmployeeDto, { ...base, [campo]: valor })).toContain(campo);
    expect(await campos(UpdateEmployeeDto, { [campo]: valor })).toContain(campo);
  });
});
