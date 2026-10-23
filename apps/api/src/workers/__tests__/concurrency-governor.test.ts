import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ConcurrencyGovernor } from '../concurrency-governor';

describe('ConcurrencyGovernor (#736)', () => {
  let governor: ConcurrencyGovernor;

  beforeEach(() => {
    governor = new ConcurrencyGovernor({
      minConcurrency: 5,
      maxConcurrency: 50,
      scaleUpThreshold: 20,
      scaleDownThreshold: 5,
      scaleDownStep: 15,
    });
  });

  afterEach(() => {
    governor.stop();
  });

  it('initializes with default bounds and minConcurrency', () => {
    expect(governor.getConcurrency()).toBe(5);
    expect(governor.getMinConcurrency()).toBe(5);
    expect(governor.getMaxConcurrency()).toBe(50);
  });

  it('calculates queue growth velocity in jobs/sec correctly', () => {
    // 0 -> 25 jobs over 5000ms = 5 jobs/sec
    const velocity = governor.calculateVelocity(25, 5000);
    expect(velocity).toBe(5);

    // Negative delta when queue clears
    const negativeVelocity = governor.calculateVelocity(0, 5000);
    expect(negativeVelocity).toBe(0);
  });

  it('scales up dynamically when backlog exceeds threshold or queue spikes', async () => {
    expect(governor.getConcurrency()).toBe(5);

    // Simulate backlog burst of 35 waiting jobs
    const metrics = await governor.tick(35);

    expect(metrics.waitingJobs).toBe(35);
    expect(governor.getConcurrency()).toBeGreaterThan(5);
    expect(governor.getConcurrency()).toBeLessThanOrEqual(50);
  });

  it('scales down during idle periods to release server CPU and RAM', async () => {
    // Force governor to a higher concurrency first
    await governor.tick(40);
    const elevated = governor.getConcurrency();
    expect(elevated).toBeGreaterThan(5);

    // Next tick with 0 waiting jobs and 0 velocity -> scale down
    await governor.tick(0);
    expect(governor.getConcurrency()).toBeLessThan(elevated);

    // Repeated idle ticks scale down until reaching minConcurrency
    await governor.tick(0);
    await governor.tick(0);
    await governor.tick(0);
    expect(governor.getConcurrency()).toBe(5);
  });

  it('strictly respects safety bounds (never below min: 5, never above max: 50)', async () => {
    // Simulate extreme 100x traffic spike with 10,000 waiting jobs
    for (let i = 0; i < 15; i++) {
      await governor.tick(10000);
    }
    expect(governor.getConcurrency()).toBe(50);
    expect(governor.getConcurrency()).toBeLessThanOrEqual(50);

    // Simulate complete drain with negative values
    for (let i = 0; i < 15; i++) {
      await governor.tick(0);
    }
    expect(governor.getConcurrency()).toBe(5);
    expect(governor.getConcurrency()).toBeGreaterThanOrEqual(5);
  });

  it('updates attached BullMQ worker concurrency property directly', async () => {
    const mockWorker = { concurrency: 5 } as any;
    governor.setWorker(mockWorker);

    // Trigger scale up
    await governor.tick(30);

    expect(mockWorker.concurrency).toBe(governor.getConcurrency());
    expect(mockWorker.concurrency).toBeGreaterThan(5);
  });

  it('activates resource backpressure throttling when memory threshold is exceeded', async () => {
    let mockMemoryRatio = 0.5;
    const backpressureGovernor = new ConcurrencyGovernor({
      minConcurrency: 5,
      maxConcurrency: 50,
      scaleUpThreshold: 10,
      maxMemoryRatio: 0.8,
      getResourceUsage: () => ({ memoryRatio: mockMemoryRatio }),
    });

    // Scale up under normal memory
    await backpressureGovernor.tick(40);
    const normalHigh = backpressureGovernor.getConcurrency();
    expect(normalHigh).toBe(50);

    // Trigger high memory consumption (92% heap usage)
    mockMemoryRatio = 0.92;
    await backpressureGovernor.tick(40);

    // Concurrency must throttle down despite high waiting jobs
    const throttled = backpressureGovernor.getConcurrency();
    expect(throttled).toBeLessThan(normalHigh);
    expect(throttled).toBe(Math.max(5, Math.floor(50 * 0.7)));

    backpressureGovernor.stop();
  });
});
