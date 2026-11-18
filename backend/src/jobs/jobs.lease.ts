export const JOB_RENEWAL_INTERVAL_MS = 30_000;

/** One local attempt owns its heartbeat and cancellation independently of the worker. */
export class JobLease {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  abandoned = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly onAbort = () => this.stop();

  constructor(
    shutdownSignal: AbortSignal,
    private readonly renew: () => Promise<boolean>,
    private readonly onError: (error: unknown) => void,
  ) {
    this.signal = AbortSignal.any([shutdownSignal, this.controller.signal]);
    this.signal.addEventListener('abort', this.onAbort, { once: true });
    if (this.signal.aborted) this.stop();
    else this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.renewOnce();
    }, JOB_RENEWAL_INTERVAL_MS);
  }

  private async renewOnce(): Promise<void> {
    try {
      if (!await this.renew()) this.abandon();
    } catch (error) {
      this.abandon();
      this.onError(error);
    } finally {
      this.inFlight = undefined;
      // Schedule after completion: slow requests cannot overlap.
      this.schedule();
    }
  }

  private abandon(): void {
    this.abandoned = true;
    this.controller.abort(new Error('Job claim ownership is uncertain'));
  }

  private stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  async stopAndJoin(): Promise<void> {
    this.stop();
    await this.inFlight;
    this.signal.removeEventListener('abort', this.onAbort);
  }
}
