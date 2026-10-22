import { createApp } from './app.ts';
import { logger } from './logger.ts';

const app = createApp();
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  logger.info({ port }, 'API listening');
});
