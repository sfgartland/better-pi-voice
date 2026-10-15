/**
 * A seam for time, so every timeout and recovery rule is testable without
 * sleeping. The reference implementation's recovery logic is largely a set of
 * timers, and timer logic that cannot be tested is timer logic that is wrong.
 */

export type TimerHandle = { readonly id: number };

export type Clock = {
	now(): number;
	setTimeout(callback: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
};

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => ({ id: setTimeout(callback, ms) as unknown as number }),
	clearTimeout: (handle) => clearTimeout(handle.id as unknown as ReturnType<typeof setTimeout>),
};
