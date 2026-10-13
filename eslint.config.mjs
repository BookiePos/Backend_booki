import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Lint real del backend. Antes `pnpm lint` era `echo "TODO: eslint" && exit 0`:
// un gate que siempre salía verde sin haber mirado nada.
//
// Reglas recomendadas SIN información de tipos, a propósito: el modo "type-aware"
// multiplica el tiempo de la corrida y los tipos ya los revisa `tsc`. Aquí se
// caza lo que tsc no ve (variables muertas, `any` explícito, ramas imposibles).
//
// La deuda que ya existía no se arregla de golpe ni se esconde bajando reglas a
// "warn": se congela con un techo en `scripts/techos.json` que solo puede bajar
// (ver `scripts/gates.mjs`).
export default tseslint.config(
  // `.claude/` es herramienta de los agentes (validadores .cjs de las skills), no código del API.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'facturas-eval/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Un parámetro o variable con guion bajo delante es "sé que no lo uso".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // En los specs se mockea con `as any` todo el tiempo: es el patrón del repo
    // (servicios instanciados a mano con dependencias falsas).
    files: ['src/**/*.spec.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        performance: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
);
