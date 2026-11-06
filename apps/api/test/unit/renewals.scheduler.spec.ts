import { AppConfig } from '../../src/config/env';
import { RenewalsScheduler } from '../../src/renewals/renewals.scheduler';
import { RenewalSummary, RenewalsService } from '../../src/renewals/renewals.service';

const summary = (examined: number): RenewalSummary => ({
  examined,
  charged: examined,
  failed: 0,
  paused: 0,
  canceled: 0,
  skipped: 0,
  unknownOutcome: 0,
  errors: 0,
});

function build(enabled: boolean, runDue: jest.Mock) {
  return new RenewalsScheduler(
    { runDue } as unknown as RenewalsService,
    { renewalJobEnabled: enabled } as AppConfig,
  );
}

describe('RenewalsScheduler', () => {
  it('runs the job on each tick when enabled', async () => {
    const runDue = jest.fn().mockResolvedValue(summary(2));
    const scheduler = build(true, runDue);
    await scheduler.tick();
    await scheduler.tick();
    expect(runDue).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the job is switched off', async () => {
    const runDue = jest.fn();
    await build(false, runDue).tick();
    expect(runDue).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous run is still going', async () => {
    let finish: (value: RenewalSummary) => void = () => undefined;
    const runDue = jest
      .fn()
      .mockReturnValue(new Promise<RenewalSummary>((resolve) => (finish = resolve)));
    const scheduler = build(true, runDue);

    const first = scheduler.tick();
    await scheduler.tick(); // returns at once: a run is in progress
    expect(runDue).toHaveBeenCalledTimes(1);

    finish(summary(0));
    await first;
    runDue.mockResolvedValue(summary(0));
    await scheduler.tick();
    expect(runDue).toHaveBeenCalledTimes(2);
  });

  it('survives a failed run and tries again on the next tick', async () => {
    const runDue = jest
      .fn()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(summary(1));
    const scheduler = build(true, runDue);
    await expect(scheduler.tick()).resolves.toBeUndefined();
    await scheduler.tick();
    expect(runDue).toHaveBeenCalledTimes(2);
  });
});
