import assert from 'node:assert/strict';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { chromium } from 'playwright';

const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const motoEndpoint = process.env.MOTO_ENDPOINT ?? 'http://localhost:5000';
const stagingBucket = process.env.S3_STAGING_BUCKET ?? 'pdf-staging';
const readyBucket = process.env.S3_READY_BUCKET ?? 'pdf-ready';
const fixture = Buffer.from('%PDF-1.4\nBrowser-to-Moto integration fixture\n');
const s3 = new S3Client({
  endpoint: motoEndpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: 'moto-local',
    secretAccessKey: 'moto-local-secret',
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

let browser;
const issuedKeys = new Set();
const cleanupErrors = [];

function keyFromStorageUrl(storageUrl) {
  const parsed = new URL(storageUrl);
  const [, bucket, ...keyParts] = parsed.pathname.split('/');
  assert.equal(bucket, stagingBucket, 'browser authorization targets the staging bucket');
  const key = decodeURIComponent(keyParts.join('/'));
  assert.ok(key.startsWith('uploads/'), 'server generated an opaque uploads key');
  issuedKeys.add(key);

  const signedHeaders = parsed.searchParams.get('X-Amz-SignedHeaders') ?? '';
  const query = parsed.searchParams.toString().toLowerCase();
  assert.ok(!query.includes('x-amz-checksum-'), 'signed URL does not pin an empty-body checksum');
  assert.ok(!signedHeaders.toLowerCase().includes('x-amz-checksum'), 'signed headers do not require a checksum');
  return key;
}

async function expectObject(bucket, key, exists) {
  try {
    const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    assert.equal(exists, true, `${bucket} object presence`);
    return response;
  } catch (error) {
    if (!exists && ['NotFound', 'NoSuchKey', '404'].includes(error?.name ?? error?.$metadata?.httpStatusCode)) {
      return null;
    }
    throw new Error(`Unexpected ${bucket} object check result.`);
  }
}

async function attachPdf(page) {
  await page.getByRole('button', { name: 'Add PDF' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'integration.pdf',
    mimeType: 'application/pdf',
    buffer: fixture,
  });
}

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const apiAuthorizations = [];
  const storageResponses = [];

  page.on('request', (request) => {
    if (request.url().endsWith('/api/uploads/presign')) apiAuthorizations.push(request);
  });
  page.on('response', (response) => {
    const requestUrl = new URL(response.url());
    if (requestUrl.hostname === 'localhost' && requestUrl.port === '5000' && response.request().method() === 'PUT') {
      storageResponses.push(response);
    }
  });

  await page.goto(frontendUrl);
  await attachPdf(page);

  let storagePuts = 0;
  const storageKeys = [];
  await page.route(`${motoEndpoint}/**`, async (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.continue();
    storagePuts += 1;
    storageKeys.push(keyFromStorageUrl(request.url()));
    if (storagePuts === 1) {
      return route.fulfill({
        status: 503,
        headers: {
          'Access-Control-Allow-Origin': new URL(frontendUrl).origin,
          'Access-Control-Expose-Headers': 'ETag',
        },
        body: 'controlled first-attempt failure',
      });
    }
    return route.continue();
  });

  await page.getByRole('button', { name: 'Upload PDF' }).click();
  await page.getByRole('alert').getByText('Could not upload the PDF to storage. Check your connection and try again.').waitFor();
  await page.getByRole('button', { name: 'Retry upload' }).click();
  await page.getByRole('dialog').getByRole('status').filter({ hasText: 'Uploaded; not ready for questions.' }).waitFor();

  assert.equal(storagePuts, 2, 'failure and retry each attempted a storage PUT');
  assert.notEqual(storageKeys[0], storageKeys[1], 'retry received a fresh object key');
  assert.equal(apiAuthorizations.length, 2, 'retry requested fresh API authorization');
  assert.equal(storageResponses.at(-1)?.status(), 200, 'browser CORS allowed the real storage response');
  assert.equal(
    storageResponses.at(-1)?.headers()['access-control-allow-origin'],
    new URL(frontendUrl).origin,
    'storage response allows the frontend origin',
  );

  const successfulKey = storageKeys[1];
  const staged = await s3.send(new GetObjectCommand({ Bucket: stagingBucket, Key: successfulKey }));
  assert.deepEqual(Buffer.from(await staged.Body.transformToByteArray()), fixture, 'staged bytes equal selected browser bytes');
  await expectObject(readyBucket, successfulKey, false);

  await context.close();
  const cancelPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await cancelPage.goto(frontendUrl);
  await attachPdf(cancelPage);
  let cancelledKey;
  await cancelPage.route(`${motoEndpoint}/**`, async (route) => {
    if (route.request().method() === 'PUT') {
      cancelledKey = keyFromStorageUrl(route.request().url());
      cancelPage.context().setDefaultTimeout(10000);
      setTimeout(() => route.fulfill({
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': new URL(frontendUrl).origin,
          ETag: '"cancelled"',
        },
      }).catch(() => {}), 1500);
      return;
    }
    return route.continue();
  });
  await cancelPage.getByRole('button', { name: 'Upload PDF' }).click();
  await cancelPage.getByRole('button', { name: 'Cancel upload' }).waitFor();
  await cancelPage.getByRole('button', { name: 'Cancel upload' }).click();
  await cancelPage.getByRole('dialog').getByRole('status').filter({ hasText: 'Upload cancelled. You can retry or choose another PDF.' }).waitFor();
  await cancelPage.waitForTimeout(1700);
  assert.equal(await cancelPage.getByRole('dialog').getByRole('status').innerText(), 'Upload cancelled. You can retry or choose another PDF.');
  await expectObject(stagingBucket, cancelledKey, false);
  await expectObject(readyBucket, cancelledKey, false);
  await cancelPage.close();

  console.log('Browser-to-API-to-Moto integration passed: browser CORS, controlled failure/fresh retry, browser byte equality in staging, no ready object, and cancellation state.');
} catch {
  console.error('Browser-to-Moto integration failed; inspect the assertion without logging request or authorization data.');
  process.exitCode = 1;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {
      cleanupErrors.push('browser session');
    }
  }
  for (const key of issuedKeys) {
    for (const bucket of [stagingBucket, readyBucket]) {
      try {
        const found = await expectObject(bucket, key, false);
        if (found) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          await expectObject(bucket, key, false);
        } catch {
          cleanupErrors.push(`${bucket}/${key}`);
        }
      }
    }
  }
  s3.destroy();
  if (cleanupErrors.length > 0) {
    console.error(`Integration fixture cleanup failed for ${cleanupErrors.join(', ')}`);
    process.exitCode = 1;
  }
}
