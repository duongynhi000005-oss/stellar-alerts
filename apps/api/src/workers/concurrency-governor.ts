import { Worker, Queue } from 'bullmq';
import { createLogger } from '../lib/logger';

const log = createLogger({ module: 'ConcurrencyGovernor' });

export interface ConcurrencyGovernorOptions {
  minConcurrency?: number;
  maxConcurrency?: number;
  sampleIntervalMs?: number;
  scaleUpThreshold?: number;
  scaleDownThreshold?: number;
  scaleDownStep?: number;
  velocityScaleFactor?: number;
  maxMemoryRatio?: number;
  getResourceUsage?: () => { memoryRatio: number; cpuLoad?: number };
}

export interface ConcurrencyMetrics {
  currentConcurrency: number;
  waitingJobs: number;
  velocityJobsPerSec: number;
  lastSampleTime: number;
}

export class ConcurrencyGovernor {
  private minConcurrency: number;
  private maxConcurrency: number;
  private sampleIntervalMs: number;
  private scaleUpThreshold: number;
  private scaleDownThreshold: number;
  private scaleDownStep: number;
  private velocityScaleFactor: number;
  private maxMemoryRatio: number;
  private getResourceUsage?: () => { memoryRatio: number; cpuLoad?: number };

  private currentConcurrency: number;
  private lastWaitingCount: number;
  private lastSampleTimestamp: number;
  private timer: NodeJS.Timeout | null = null;
  private worker: Worker | null = null;
  private queue: Queue | null = null;

  constructor(options: ConcurrencyGovernorOptions = {}) {
    this.minConcurrency = options.minConcurrency ?? 5;
    this.maxConcurrency = options.maxConcurrency ?? 50;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 5000;
    this.scaleUpThreshold = options.scaleUpThreshold ?? 20;
    this.scaleDownThreshold = options.scaleDownThreshold ?? 5;
    this.scaleDownStep = options.scaleDownStep ?? 15;
    this.velocityScaleFactor = options.velocityScaleFactor ?? 1.5;
    this.maxMemoryRatio = options.maxMemoryRatio ?? 0.85;
    this.getResourceUsage = options.getResourceUsage ?? (() => {
      const mem = process.memoryUsage();
      const memoryRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
      return { memoryRatio };
    });

    this.currentConcurrency = this.minConcurrency;
    this.lastWaitingCount = 0;
    this.lastSampleTimestamp = Date.now();
  }

  public getMinConcurrency(): number {
    return this.minConcurrency;
  }

  public getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  public getConcurrency(): number {
    return this.currentConcurrency;
  }

  public setWorker(worker: Worker): void {
    this.worker = worker;
    this.currentConcurrency = worker.concurrency ?? this.minConcurrency;
  }

  public setQueue(queue: Queue): void {
    this.queue = queue;
  }

  /**
   * Calculates queue growth velocity in jobs/sec based on waiting count difference and elapsed time.
   */
  public calculateVelocity(currentWaiting: number, deltaTimeMs: number): number {
    if (deltaTimeMs <= 0) return 0;
    const deltaJobs = currentWaiting - this.lastWaitingCount;
    return Number(((deltaJobs / (deltaTimeMs / 1000))).toFixed(2));
  }

  /**
   * Computes the target concurrency bounded strictly between minConcurrency and maxConcurrency.
   * Incorporates resource backpressure to throttle down if memory thresholds are exceeded.
   */
  public computeTargetConcurrency(waitingJobs: number, velocityJobsPerSec: number): number {
    // 1. Resource backpressure check (RAM/CPU overload)
    if (this.getResourceUsage) {
      const usage = this.getResourceUsage();
      if (usage.memoryRatio >= this.maxMemoryRatio) {
        log.warn(
          { memoryRatio: usage.memoryRatio, maxMemoryRatio: this.maxMemoryRatio },
          '[ConcurrencyGovernor] Resource backpressure: Throttling concurrency due to high memory usage'
        );
        const throttled = Math.max(this.minConcurrency, Math.floor(this.currentConcurrency * 0.7));
        return Math.max(this.minConcurrency, Math.min(this.maxConcurrency, throttled));
      }
    }

    let target = this.currentConcurrency;

    // 2. High backlog or rapid queue surge: scale up dynamically
    if (waitingJobs >= this.scaleUpThreshold || velocityJobsPerSec > 2) {
      const backlogDemand = Math.ceil(waitingJobs / 5);
      const velocityDemand = Math.max(0, Math.ceil(velocityJobsPerSec * this.velocityScaleFactor));
      const stepIncrease = Math.max(5, Math.max(backlogDemand, velocityDemand));
      target = Math.min(this.maxConcurrency, this.currentConcurrency + stepIncrease);
    }
    // 3. Idle or low backlog: scale down gradually to release CPU & RAM
    else if (waitingJobs <= this.scaleDownThreshold && velocityJobsPerSec <= 0) {
      target = Math.max(this.minConcurrency, this.currentConcurrency - this.scaleDownStep);
    }

    // Strict safety clamp ensuring bounds are never violated
    return Math.max(this.minConcurrency, Math.min(this.maxConcurrency, target));
  }

  /**
   * Executes a single monitoring and governance sample tick.
   */
  public async tick(overrideWaitingCount?: number): Promise<ConcurrencyMetrics> {
    const now = Date.now();
    const deltaTimeMs = Math.max(1000, now - this.lastSampleTimestamp);

    let waitingCount = overrideWaitingCount;
    if (waitingCount === undefined) {
      if (this.queue) {
        waitingCount = await this.queue.getWaitingCount();
      } else {
        waitingCount = 0;
      }
    }

    const velocity = this.calculateVelocity(waitingCount, deltaTimeMs);
    const targetConcurrency = this.computeTargetConcurrency(waitingCount, velocity);

    if (targetConcurrency !== this.currentConcurrency) {
      log.info(
        { from: this.currentConcurrency, to: targetConcurrency, waitingCount, velocity },
        `[ConcurrencyGovernor] Adjusting worker concurrency: ${this.currentConcurrency} -> ${targetConcurrency}`
      );
      this.currentConcurrency = targetConcurrency;
      if (this.worker) {
        this.worker.concurrency = targetConcurrency;
      }
    }

    this.lastWaitingCount = waitingCount;
    this.lastSampleTimestamp = now;

    return {
      currentConcurrency: this.currentConcurrency,
      waitingJobs: waitingCount,
      velocityJobsPerSec: velocity,
      lastSampleTime: now,
    };
  }

  public start(): void {
    if (this.timer) return;
    this.lastSampleTimestamp = Date.now();
    this.timer = setInterval(async () => {
      try {
        await this.tick();
      } catch (err: any) {
        log.error({ err: err.message }, '[ConcurrencyGovernor] Error during tick');
      }
    }, this.sampleIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const concurrencyGovernor = new ConcurrencyGovernor();
