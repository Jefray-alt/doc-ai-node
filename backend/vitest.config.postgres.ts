import baseConfig from './vitest.config.ts';

export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['test/jobs-postgres.integration-spec.ts'],
  },
};
