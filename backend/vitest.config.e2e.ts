import { mergeConfig } from 'vitest/config';
import config from './vitest.config.js';

export default mergeConfig(config, {
  test: {
    include: ['test/**/*.e2e-spec.ts'],
  },
});
