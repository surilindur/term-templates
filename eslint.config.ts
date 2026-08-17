import { defineConfig, globalIgnores } from 'eslint/config';
import { configs as jsConfigs } from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { configs as tsConfigs } from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/.yarn/',
    '**/coverage/',
    '**/*.d.ts',
    '**/*.js'
  ]),
  jsConfigs.recommended,
  tsConfigs.eslintRecommended,
  tsConfigs.recommended,
  tsConfigs.strict,
  stylistic.configs.customize({
    commaDangle: 'never',
    indent: 2,
    jsx: false,
    quotes: 'single',
    semi: true,
    quoteProps: 'as-needed'
  }),
  {
    plugins: {
      '@stylistic': stylistic
    },
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@stylistic/brace-style': 'off'
    }
  }
);
