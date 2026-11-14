import { mergeConfig } from 'vitest/config';
import config from './vitest.config.ts';

export default mergeConfig(config, {
  test: {
    include: ['test/uploads-floci.integration-spec.ts'],
    exclude: ['src/**', 'test/**/*.e2e-spec.ts'],
  },
});
