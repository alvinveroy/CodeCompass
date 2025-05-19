// @ts-check

const globals = require("globals");
const tseslint = require("typescript-eslint");
const js = require("@eslint/js");

module.exports = [
  // 1. Global ignores from .eslintignore and .eslintrc.js's ignorePatterns
  {
    ignores: [
      "node_modules/",
      "dist/",
      "coverage/",
      "**/*.js", // Includes this file, but ESLint loads it by name. Other JS files are ignored.
      "**/*.d.ts",
      "*.config.js", // Ignores other .config.js files (e.g., vitest.config.js)
      "*.config.ts", // Ignores .config.ts files
      "scripts/",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
    ],
  },

  // 2. ESLint recommended rules (applies to files not otherwise ignored, if any JS linting were enabled)
  js.configs.recommended,

  // 3. TypeScript specific configurations
  // This uses tseslint.config to correctly layer recommended and type-checked rules.
  ...tseslint.config({
    files: ["**/*.ts"], // Apply to all .ts files
    extends: [
      ...tseslint.configs.recommended,         // Base TS recommendations
      ...tseslint.configs.recommendedTypeChecked, // Type-aware recommendations
    ],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname, // __dirname is available in CommonJS
        sourceType: "module",       // From old parserOptions
      },
      globals: { // Define global variables available
        ...globals.node,
        ...globals.es2020, // From old env settings (es6:true, ecmaVersion:2020)
      },
    },
    rules: {
      // Your specific rule overrides and additions from .eslintrc.js
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-unused-vars': 'off', // Must be off for @typescript-eslint/no-unused-vars to work
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      'no-console': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/no-inferrable-types': 'warn',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-empty-interface': 'warn',
    },
  }),
];
