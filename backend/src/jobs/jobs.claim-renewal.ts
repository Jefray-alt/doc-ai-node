import type { Pool, PoolClient } from 'pg';

export const CLAIM_RENEWAL_BUDGET_MS = 5_000;
export const CLAIM_RENEWAL_STATEMENT_TIMEOUT_MS = 2_000;

/** A renewal must not survive its caller's deadline and renew ownership later. */
export async function runClaimRenewal(pool: Pool, sql: string, values: unknown[]): Promise<boolean> {
  let client: PoolClient | undefined;
  let failure: Error | undefined;
  let rejectDisconnected!: (error: Error) => void;
  const disconnected = new Promise<never>((_resolve, reject) => { rejectDisconnected = reject; });
  const onClientError = (error: Error) => {
    failure ??= error;
    dispose();
    rejectDisconnected(error);
  };
  const timeoutError = new Error('Job claim renewal timed out');
  const dispose = () => {
    if (!client) return;
    const discarded = client;
    client = undefined;
    // Destroy the socket even when a client-side query timeout has already removed
    // the active query. Disposal rolls back the transaction without a cleanup query.
    try {
      discarded.connection.stream.destroy();
      discarded.release(true);
    } finally {
      // release installs the pool's idle listener before ours is removed.
      discarded.removeListener('error', onClientError);
    }
  };
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      failure = timeoutError;
      dispose();
      reject(timeoutError);
    }, CLAIM_RENEWAL_BUDGET_MS);
  });
  const request = async () => {
    const acquired = await new Promise<PoolClient>((resolve, reject) => {
      // Install the listener inside checkout: the pool removes its idle listener
      // before invoking this callback, so a promise handoff would leave a gap.
      pool.connect((error, checkedOut) => {
        if (error || !checkedOut) {
          reject(error ?? new Error('Job claim renewal checkout returned no client'));
        } else if (failure) {
          // Pool.connect has no cancellation API. Never run SQL on a late checkout.
          checkedOut.release();
          reject(failure);
        } else {
          client = checkedOut;
          checkedOut.on('error', onClientError);
          resolve(checkedOut);
        }
      });
    });
    try {
      if (failure) throw failure;
      await acquired.query(`BEGIN; SET LOCAL statement_timeout = '${CLAIM_RENEWAL_STATEMENT_TIMEOUT_MS}ms'`);
      if (failure) throw failure;
      const result = await acquired.query(sql, values);
      if (failure) throw failure;
      await acquired.query('COMMIT');
      if (failure) throw failure;
      client = undefined;
      try {
        acquired.release();
      } finally {
        acquired.removeListener('error', onClientError);
      }
      if (failure) throw failure;
      return result.rowCount === 1;
    } catch (error) {
      dispose();
      throw error;
    }
  };

  try {
    return await Promise.race([request(), deadline, disconnected]);
  } finally {
    clearTimeout(timer!);
  }
}
