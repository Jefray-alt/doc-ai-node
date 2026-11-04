import baseConfig from './vitest.config.js';

export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/jobs-postgres.integration-spec.ts'],
  },
};
