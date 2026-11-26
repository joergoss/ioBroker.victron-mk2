/**
 * The adapter's poll loop with a clean stop: `stop()` waits for the iteration
 * that is currently running (bounded by a timeout), so a shutdown never closes
 * the serial port in the middle of a write (review T12).
 */
export class PollLoop {
	private task: Promise<void> | null = null;
	private running = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private wakeUp: (() => void) | null = null;

	constructor(
		private readonly fn: () => Promise<void>,
		private readonly intervalMs: number,
	) {}

	start(delayMs = 0): void {
		if (this.task) return;
		this.running = true;
		const task = (async () => {
			if (delayMs > 0) {
				await this.delay(delayMs);
			}
			while (this.running) {
				await this.fn();
				if (!this.running) {
					break;
				}
				await this.delay(this.intervalMs);
			}
		})();
		this.task = task;
		void task.then(() => {
			if (this.task === task) this.task = null;
		}, () => {
			if (this.task === task) this.task = null;
		});
	}

	/** Stop scheduling and wait for the in-flight iteration (bounded). */
	async stop(timeoutMs = 3000): Promise<void> {
		this.running = false;
		// Wake a pending delay immediately so shutdown does not wait for the
		// whole poll interval (which can be hours).
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.wakeUp) {
			this.wakeUp();
			this.wakeUp = null;
		}
		if (this.task) {
			const task = this.task;
			let settled = false;
			void task.then(() => { settled = true; }, () => { settled = true; });
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<void>((resolve) => {
				timeoutTimer = setTimeout(resolve, timeoutMs);
			});
			await Promise.race([task, timeout]);
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			// A timeout is not task completion. Keep the reference so start()
			// cannot create a second loop beside the still-finishing task (#122).
			if (settled) this.task = null;
		}
	}

	get isRunning(): boolean {
		return this.running;
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.wakeUp = resolve;
			this.timer = setTimeout(() => {
				this.timer = null;
				this.wakeUp = null;
				resolve();
			}, ms);
		});
	}
}
