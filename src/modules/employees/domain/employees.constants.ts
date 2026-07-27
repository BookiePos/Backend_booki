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
