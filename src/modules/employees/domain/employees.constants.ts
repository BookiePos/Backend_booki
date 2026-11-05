/**
 * Constantes del módulo de Empleados (RRHH). Enums de contratación y seguridad
 * social conforme a la normativa laboral colombiana. Todo texto libre (EPS,
 * ARL, fondos) queda como string para no acoplar el sistema a un catálogo fijo
 * de entidades.
 */

/** Tipos de documento de identidad. */
export const EMP_DOC_TYPES = ['CC', 'CE', 'TI', 'PA', 'PEP', 'NIT'] as const;
export type EmpDocType = (typeof EMP_DOC_TYPES)[number];

/** Tipos de contrato laboral. */
export const CONTRACT_TYPES = [
  'indefinido',
  'fijo',
  'obra_labor',
  'aprendizaje',
  'prestacion_servicios',
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

/** Tipo de salario. */
export const SALARY_TYPES = ['ordinario', 'integral'] as const;
export type SalaryType = (typeof SALARY_TYPES)[number];

/** Nivel de riesgo ARL (I–V). */
export const ARL_RISK_LEVELS = ['I', 'II', 'III', 'IV', 'V'] as const;
export type ArlRiskLevel = (typeof ARL_RISK_LEVELS)[number];

/** Tipo de cuenta bancaria (para pago de nómina). */
export const ACCOUNT_TYPES = ['ahorros', 'corriente'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Estado del empleado. */
export const EMPLOYEE_STATUS = ['activo', 'inactivo', 'retirado'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[number];

/** Género. */
export const GENDERS = ['M', 'F', 'O'] as const;
export type Gender = (typeof GENDERS)[number];

/** Estado de un documento/certificado del expediente. */
export const DOC_STATUS = ['pendiente', 'entregado', 'vencido'] as const;
export type DocStatus = (typeof DOC_STATUS)[number];

/** Fecha en formato YYYY-MM-DD. */
export const YYYYMMDD = /^\d{4}-\d{2}-\d{2}$/;

// ── Nómina electrónica DIAN (XSD 1.0.6): todos opcionales y en código DIAN ────

/** Tipo de documento DIAN del trabajador (tabla de tipos de documento): 11 RC, 12 TI, 13 CC, 21 tarjeta de extranjería, 22 CE, 31 NIT, 41 pasaporte, 42 documento extranjero, 47 PEP, 50 NIT de otro país, 91 NUIP. */
export const DIAN_DOC_TYPES = ['11', '12', '13', '21', '22', '31', '41', '42', '47', '50', '91'] as const;
export type DianDocType = (typeof DIAN_DOC_TYPES)[number];

/** Tipo de trabajador (códigos de la PILA que admite la nómina electrónica); 01 es dependiente. */
export const DIAN_TIPOS_TRABAJADOR = [
  '01', '02', '04', '12', '18', '19', '21', '22', '23', '30', '31', '47', '51', '54', '56', '58',
] as const;
export type DianTipoTrabajador = (typeof DIAN_TIPOS_TRABAJADOR)[number];

/** Subtipo de trabajador: 00 ninguno, 01 dependiente pensionado por vejez activo. */
export const DIAN_SUBTIPOS_TRABAJADOR = ['00', '01'] as const;
export type DianSubtipoTrabajador = (typeof DIAN_SUBTIPOS_TRABAJADOR)[number];

/** Tipo de contrato DIAN: 1 término fijo, 2 indefinido, 3 obra o labor, 4 aprendizaje, 5 prácticas. */
export const DIAN_TIPOS_CONTRATO = ['1', '2', '3', '4', '5'] as const;
export type DianTipoContrato = (typeof DIAN_TIPOS_CONTRATO)[number];

/** Medio de pago DIAN: 1 no definido, 10 efectivo, 20 cheque, 42 consignación, 47 transferencia, 48 tarjeta crédito, 49 tarjeta débito. */
export const DIAN_MEDIOS_PAGO = ['1', '10', '20', '42', '47', '48', '49'] as const;
export type DianMedioPago = (typeof DIAN_MEDIOS_PAGO)[number];

/** Código DANE de municipio: 5 dígitos. */
export const DANE_MUNICIPIO = /^\d{5}$/;
