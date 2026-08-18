import { compilerOptions } from './tsconfig.build.json' with { type: 'json' };
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const browsers: ('chromium' | 'firefox' | 'webkit')[] = [
  'chromium',
  'firefox',
  'webkit'
];

export default defineConfig({
  build: {
    target: compilerOptions.target
  },
  test: {
    coverage: {
      provider: 'istanbul',
      thresholds: {
        autoUpdate: true,
        branches: 100,
        functions: 100,
        lines: 100,
        perFile: true,
        statements: 100
      }
    },
    projects: [
      ...browsers.map(browser => ({
        test: {
          browser: {
            enabled: true,
            headless: true,
            instances: [
              { browser }
            ],
            provider: playwright({ actionTimeout: 1_000 }),
            screenshotFailures: false
          },
          name: browser
        }
      })),
      {
        test: {
          environment: 'node',
          name: 'node'
        }
      }
    ]
  },
  plugins: [
    nodePolyfills({
      include: ['events']
    })
  ]
});
