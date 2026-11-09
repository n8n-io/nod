import type { Schedule } from '../../shared/contracts';
import { api, ApiError, requestAccountVersion } from './api';

export const schedulesPath = '/api/schedules';

export function uncertainScheduleMutation(cause: unknown) {
  return !(
    cause instanceof ApiError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    cause.status !== 408
  );
}

export function scheduleMatchesPatch(
  schedule: Schedule | undefined,
  body: Record<string, unknown>,
) {
  if (!schedule) return false;
  const expectedRevision = body.expectedRevision;
  if (typeof expectedRevision === 'number' && schedule.revision <= expectedRevision) return false;
  return Object.entries(body).every(
    ([key, value]) =>
      key === 'expectedRevision' || Object.is(schedule[key as keyof Schedule], value),
  );
}

export async function reconcileSchedule(
  id: string,
  matches: (schedule: Schedule | undefined) => boolean,
  accountVersion: number,
  signal?: AbortSignal,
) {
  let schedules: Schedule[] | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 400));
    if (signal?.aborted || requestAccountVersion() !== accountVersion)
      return { status: 'aborted' as const };
    try {
      const current = await api<Schedule[]>(schedulesPath, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5_000)])
          : AbortSignal.timeout(5_000),
      });
      if (signal?.aborted || requestAccountVersion() !== accountVersion)
        return { status: 'aborted' as const };
      schedules = current;
      if (matches(current.find((schedule) => schedule.id === id)))
        return { status: 'confirmed' as const, schedules: current };
    } catch {
      if (signal?.aborted || requestAccountVersion() !== accountVersion)
        return { status: 'aborted' as const };
    }
  }
  return { status: 'unknown' as const, schedules };
}
