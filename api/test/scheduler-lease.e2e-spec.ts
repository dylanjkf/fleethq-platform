/**
 * Leader election for the background scheduler. Proves the DB lease only lets
 * one instance win a given tick, and that the lease is reclaimable once it
 * expires — the mechanism that makes SCHEDULER_ENABLED safe on every replica.
 */
import { INestApplication } from '@nestjs/common';
import { buildTestApp } from './utils/build-test-app';
import { disconnectFixtures } from './utils/fixtures';
import { SchedulerService } from '../src/scheduler/scheduler.service';

describe('Scheduler leader election', () => {
  let app: INestApplication;
  let scheduler: SchedulerService;

  beforeAll(async () => {
    app = await buildTestApp();
    scheduler = app.get(SchedulerService);
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
  });

  it('lets exactly one holder win the lease, and reclaims it after expiry', async () => {
    const task = `test_task_${Date.now()}`;

    // First claim of a free task wins.
    expect(await scheduler.tryAcquireLease(task, 60)).toBe(true);
    // A second claim while the lease is still held loses.
    expect(await scheduler.tryAcquireLease(task, 60)).toBe(false);

    // A claim with a 0-second lease writes an already-expired lease, so the
    // very next claim can immediately re-take it — proving expiry reclaim.
    const shortTask = `test_task_short_${Date.now()}`;
    expect(await scheduler.tryAcquireLease(shortTask, 0)).toBe(true);
    expect(await scheduler.tryAcquireLease(shortTask, 60)).toBe(true);
  });
});
