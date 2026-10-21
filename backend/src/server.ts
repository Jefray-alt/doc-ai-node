import { createApp } from './app.ts';
import { readStorageConfig } from './storage/config.ts';
import { createUploadSigner } from './storage/signer.ts';

const storageConfig = readStorageConfig();
const app = createApp(createUploadSigner(storageConfig));

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
