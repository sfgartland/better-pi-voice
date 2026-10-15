import type { Clock, TimerHandle } from "../clock.ts";

type Scheduled = { handle: TimerHandle; at: number; callback: () => void };

/** A clock that only moves when told to. */
export class FakeClock implements Clock {
	private current = 0;
	private nextId = 1;
	private scheduled = new Map<number, Scheduled>();

	now(): number {
		return this.current;
	}

	setTimeout(callback: () => void, ms: number): TimerHandle {
		const handle: TimerHandle = { id: this.nextId++ };
		this.scheduled.set(handle.id, { handle, at: this.current + Math.max(0, ms), callback });
		return handle;
	}

	clearTimeout(handle: TimerHandle): void {
		this.scheduled.delete(handle.id);
	}

	/** Number of timers currently armed. */
	get pending(): number {
		return this.scheduled.size;
	}

	/** Advance time, firing everything due in chronological order. */
	advance(ms: number): void {
		const target = this.current + ms;
		for (;;) {
			const due = [...this.scheduled.values()]
				.filter((entry) => entry.at <= target)
				.sort((a, b) => a.at - b.at || a.handle.id - b.handle.id);
			const next = due[0];
			if (!next) break;
			this.current = next.at;
			this.scheduled.delete(next.handle.id);
			next.callback();
		}
		this.current = target;
	}

	/** Run every timer regardless of its deadline. */
	runAll(): void {
		for (;;) {
			const next = [...this.scheduled.values()].sort((a, b) => a.at - b.at || a.handle.id - b.handle.id)[0];
			if (!next) break;
			this.current = Math.max(this.current, next.at);
			this.scheduled.delete(next.handle.id);
			next.callback();
		}
	}
}
