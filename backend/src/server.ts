import { app } from './app.ts';
import { readStorageConfig } from './storage/config.ts';

readStorageConfig();

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
