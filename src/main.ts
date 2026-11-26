import * as utils from "@iobroker/adapter-core";
import { Mk2DataEntry } from "./mk2/mk2Model";
import { Mk2Protocol } from "./mk2/mk2Protocol";
import { isStableState, controlAllowedWhileOff } from "./lib/state-gate";
import { CONTROL_STATE_IDS, shouldHandleControlState } from "./lib/control-rules";
import { processControlWritesDetailed, QueueItem, reportControlError } from "./lib/send-queue";
import { settingDisplayValue } from "./mk2/mk2Settings";
import { buildStateObject, objectDefinitionChanged } from "./lib/state-objects";
import { publishModel } from "./lib/publish";
import { PollLoop } from "./lib/poll-loop";

export function splitIdFromAdapter(str: string): string {
	const delimiter = ".";
	const start = 2;
	const tokens = str.split(delimiter).slice(start);
	return tokens.join(delimiter);
}

class VictronMk2 extends utils.Adapter {
	mk2: Mk2Protocol | undefined;
	private pollLoop: PollLoop | undefined;
	toSendQueue: QueueItem[] = [];
	private assistLimitObjectSignature: string | null = null;
	private settingObjectBounds = new Map<string, string>();
	private started = false;
	private unloading = false;
	private staleControlsChecked = false;
	/** True once a full poll has read the control-relevant values from the device. */
	private modelPopulated = false;

	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "victron-mk2",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	private async onReady(): Promise<void> {
		try {
			await this.startAdapter();
		} catch (error) {
			// Never leave an unhandled rejection or a crash/restart loop (N1).
			this.started = false;
			const message = error instanceof Error ? error.message : String(error);
			this.log.error("onReady failed: " + message);
			try {
				await this.setStateAsync("info.connection", { val: false, ack: true });
			} catch {
				// even the state write may fail in this situation
			}
		}
	}

	private async startAdapter(): Promise<void> {
		// A second ready event must not replace a live protocol instance and
		// open a second connection to the same port.
		if (this.started) {
			this.log.debug("adapter already started; ignoring duplicate ready event");
			return;
		}
		this.started = true;
		const interval = Number(this.config.interval);
		this.config.interval = Number.isFinite(interval) && interval >= 1 && interval <= 3600 ? interval : 2;
		this.log.info("config interval: " + this.config.interval);
		this.log.info("config portPath: " + this.config.portPath);

		this.mk2 = new Mk2Protocol(this.config.portPath, this.log);
		const responseTimeout = Number(this.config.responseTimeout);
		if (Number.isFinite(responseTimeout) && responseTimeout >= 250) {
			this.mk2.conn.responseTimeoutMs = responseTimeout;
			this.log.info("config responseTimeout: " + responseTimeout + " ms");
		}
		// Create the objects even without a configured port and report "not
		// connected", instead of leaving no state at all (review N6).
		await this.initObjects();
		// Nothing is connected yet at startup; never keep a persisted true (N2).
		await this.setStateAsync("info.connection", { val: false, ack: true });
		if (!this.config.portPath) {
			this.log.error("config portPath is empty; adapter will not poll until it is configured");
			await this.setStateAsync("info.connection", { val: false, ack: true });
			return;
		}
		this.mainLoop();
		this.subscribeStates("control.*");
	}

	private async onUnload(callback: () => void): Promise<void> {
		this.unloading = true;
		// Cancel new I/O and wake receive loops before waiting for the active
		// iteration. No state from that iteration may leak past the callback (#122).
		this.mk2?.conn.beginShutdown();
		if (this.pollLoop) {
			await this.pollLoop.stop(3000);
		}
		// Even after the poll-loop timeout, wait for an in-flight serial
		// exchange before closing the port.
		try {
			await this.mk2?.conn.waitForIdle();
		} catch {
			// best effort
		}
		this.started = false;
		try {
			await this.mk2?.conn.shutdown();
		} catch {
			// ignore close errors during shutdown
		}
		callback();
	}

	/**
	 * Create the channel/folder structure below the instance so that states are
	 * always the last level. Existing objects are left untouched.
	 */
	private async initChannels(): Promise<void> {
		if (!this.mk2) return;
		const names: Record<string, string> = {
			info: "Information",
			diag: "Diagnostics",
			power: "Power",
			battery: "Battery",
			dc_info: "DC information",
			ac_info: "AC information",
			switch: "Switch states",
			state: "Device state",
			led: "LEDs",
			setting: "Settings",
			"setting.flag": "Flags",
			control: "Controls",
			assist: "Assist limits",
		};
		const prefixes = new Set<string>();
		for (const key of Object.keys(this.mk2.mk2Model)) {
			const parts = key.split(".");
			for (let i = 1; i < parts.length; i++) {
				prefixes.add(parts.slice(0, i).join("."));
			}
		}
		for (const id of prefixes) {
			const type: ioBroker.ObjectType = id.includes(".") ? "folder" : "channel";
			await this.setObjectNotExistsAsync(id, {
				type,
				common: { name: names[id] ?? id },
				native: {},
			});
		}
	}

	private async initObjects(): Promise<void> {
		if (!this.mk2) return;
		await this.initChannels();
		for (const [key, value] of Object.entries(this.mk2.mk2Model)) {
			const object = buildStateObject(key, value as Mk2DataEntry);
			const existing = await this.getObjectAsync(key);
			// control.set_assist gets its device-specific min/max/def after the
			// first poll. Preserve those fields on restart; otherwise the static
			// model definition would look changed on every start and extend the
			// object unnecessarily (or drop its limits with a replacing merge).
			if (existing?.common && (key === "control.set_assist"
				|| key === "control.IMainsLimitAC1"
				|| key === "control.UBatAbsorption"
				|| key === "control.UBatFloat"
				|| key === "control.IBatBulk")) {
				// These bounds are discovered from the device after the first
				// poll. Preserve them on restart; otherwise every start would
				// look like a definition change and could drop the limits.
				object.common.min = existing.common.min;
				object.common.max = existing.common.max;
				object.common.def = existing.common.def;
			}
			if (!existing) {
				await this.setObjectNotExistsAsync(key, object);
			} else if (objectDefinitionChanged(existing, object)) {
				// Upgrade roles/descriptions/units/state maps on existing objects;
				// extendObject keeps user customisation such as InfluxDB history.
				await this.extendObjectAsync(key, object);
			}
		}
	}

	/** Keep control.set_assist's limits in sync with the discovered device. */
	private async updateAssistLimitObject(): Promise<void> {
		if (!this.mk2 || this.unloading) return;
		const max = this.mk2.mk2Model["assist.maxlimit"].value;
		if (typeof max != "number" || max <= 0) return;
		const configured = this.mk2.mk2Model["setting.IMainsLimitAC1"].value;
		const def = typeof configured === "number" && Number.isFinite(configured) && configured >= 0 ? configured : null;
		const signature = `${max}:${String(def)}`;
		if (signature === this.assistLimitObjectSignature) return;
		await this.extendObjectAsync("control.set_assist", {
			// Unknown configuration must never turn "reset to default" into a
			// request for the device maximum (#118).
			common: { min: 0, max, def },
		});
		this.assistLimitObjectSignature = signature;
	}

	private mainLoop(): void {
		// Idempotent: a second ready event must never orphan a running loop (N8).
		if (this.pollLoop) {
			return;
		}
		this.pollLoop = new PollLoop(() => this.updateStates(), this.config.interval * 1000);
		this.pollLoop.start(10 * 1000);
	}

	private async updateStates(): Promise<void> {
		const mk2 = this.mk2;
		if (!mk2) return;
		try {
			// Read-only state poll first. While the MultiPlus is booting, no
			// control command or full poll is sent. Off is handled separately below.
			await mk2.pollStateOnly();
			// Publish the state poll as well: an Off or a boot loop must be visible
			// in ioBroker and to the watchdog, not just the last stable state.
			// info.connection is published from the model, so there is exactly one
			// writer and a failed full poll cannot be masked by a direct setState.
			await this.publishStates(["state.state", "state.substate", "info.address", "info.connection"]);
			const state = mk2.mk2Model["state.state"].value;
			if (!isStableState(state)) {
				this.log.debug("MultiPlus not stable yet (state " + state + "), deferring control writes");
				return;
			}

			if (typeof state === "number" && Math.floor(state / 10) === 2) {
				// Work on an atomic snapshot. New stateChange events must wait for
				// the next Off cycle instead of entering the already-filtered queue.
				const pending = this.toSendQueue.splice(0);
				const offDropped = pending.filter((item) => !controlAllowedWhileOff(item.name));
				const powerOnControls = pending.filter((item) => controlAllowedWhileOff(item.name));
				for (const item of offDropped) {
					const reason = "device is Off: only switch_state/grid_mode writes are allowed";
					this.log.warn(`${item.name}: ${reason}`);
					reportControlError(mk2, item, reason);
					await this.reconcileDroppedControl(item);
				}
				const hadPowerOnRequest = powerOnControls.length > 0;
				const needsPowerAssist = powerOnControls.some((item) =>
					(item.name === "control.grid_mode" && (item.value === 1 || item.value === 2))
					|| (item.name === "control.switch_state" && item.value === 2));
				if (needsPowerAssist) {
					// Grid modes 1/2 and direct switch 2 need AssistEnabled for 0 A validation.
					// Read just Flags0 instead of restoring the full-poll dependency.
					await mk2.get_flags();
				}
				await this.processToSendQueue(powerOnControls);
				if (this.modelPopulated) {
					await this.publishStates();
				} else {
					await this.publishBeforeFirstFullPoll(hadPowerOnRequest, needsPowerAssist);
				}
				await this.reconcileStaleControls();
				return;
			}

			// Outside Off, control writes depend on flags and extended settings
			// loaded by the full poll (e.g. the 0 A guard reads Flags0).
			await mk2.poll();
			if (mk2.mk2Model["info.connection"].value === false) {
				this.log.warn("full poll failed; deferring control writes to the next cycle");
				// A failed poll is a hard boundary for serial I/O. In particular,
				// updateSettingObjects() must not reopen the port for metadata reads.
				if (this.modelPopulated) {
					await this.publishStates();
				} else {
					await this.publishBeforeFirstFullPoll();
				}
				return;
			}
			this.modelPopulated = true;
			await this.processToSendQueue();
			await this.publishStates();
			await this.reconcileStaleControls();
			await this.updateAssistLimitObject();
			await this.updateSettingObjects();
		} catch (Exception) {
			if (this.unloading) {
				this.log.debug("poll/control iteration cancelled during unload");
				return;
			}
			// JSON.stringify(Error) yields "{}", so log the message and stack.
			const message = Exception instanceof Error ? (Exception.stack ?? Exception.message) : JSON.stringify(Exception);
			this.log.error("ERROR updateStates : " + message);
			// Keep the model as the single source of truth so a later successful
			// poll republishes info.connection as true (#77).
			try {
				mk2.mk2Model["info.connection"].value = false;
				await this.publishStates([
					"info.connection",
					"diag.timeouts",
					"diag.checksum_errors",
					"diag.last_error",
					"diag.protocol_errors",
					"diag.sync_errors",
				]);
			} catch {
				// ignore secondary state errors while handling a failure
			}
		}
	}

	private async publishStates(only?: string[]): Promise<void> {
		if (!this.mk2 || this.unloading) return;
		await publishModel(this.mk2.mk2Model, async (key, value) => {
			await this.setStateAsync(key, { val: value, ack: true });
		}, only, () => !this.unloading);
	}

	/** Publish only values actually known before the first successful full poll. */
	private async publishBeforeFirstFullPoll(includeSwitchAndAssist = false, includeFlags = false): Promise<void> {
		if (!this.mk2) return;
		const keys = [
			"state.state",
			"state.substate",
			"info.address",
			"info.connection",
			"diag.timeouts",
			"diag.checksum_errors",
			"diag.last_error",
			"diag.protocol_errors",
			"diag.sync_errors",
			"diag.last_control_error",
		];
		const modelKeys = Object.keys(this.mk2.mk2Model);
		if (includeSwitchAndAssist) {
			keys.push(...modelKeys.filter((key) => key.startsWith("switch.") || key.startsWith("assist.")));
		}
		if (includeFlags) {
			keys.push(...modelKeys.filter((key) => key.startsWith("setting.flag.")));
		}
		await this.publishStates(keys);
	}

	async processToSendQueue(queue: QueueItem[] = this.toSendQueue): Promise<void> {
		if (!this.mk2 || this.unloading) return;
		const result = await processControlWritesDetailed(this.mk2, queue, this.log);
		if (this.unloading) return;
		for (const item of result.completed) {
			if (this.unloading) return;
			// Acknowledge successful writes; ack=true is never forwarded again, so
			// this cannot retrigger the control path (review T7).
			await this.setStateAsync(item.name, { val: item.value, ack: true });
			if (this.unloading) return;
			// grid_mode also writes an input-current setpoint. Mirror it into the
			// control.set_assist command state; otherwise that state keeps an old
			// value (e.g. 0 A) while the device is actually at 16 A.
			if (item.name === "control.grid_mode" && this.mk2) {
				const setpoint = this.mk2.mk2Model["control.set_assist"]?.value;
				if (typeof setpoint === "number" && !this.unloading) {
					await this.setStateAsync("control.set_assist", { val: setpoint, ack: true });
				}
			}
		}
		for (const item of result.dropped) {
			await this.reconcileDroppedControl(item);
		}
	}

	private async reconcileDroppedControl(item: QueueItem): Promise<void> {
		if (this.unloading) return;
		// Restore only a proven actual value. In particular, an F5 minimum in
		// special 0 A mode must not acknowledge the failed positive request (#119).
		const actual = this.actualControlValue(item.name);
		if (actual === undefined) return;
		const current = await this.getStateAsync(item.name);
		if (this.unloading) return;
		if (current && current.ack === false && current.val === item.value) {
			await this.setStateAsync(item.name, { val: actual, ack: true });
		}
	}

	/**
	 * Commands written with ack=false while the adapter was down are not
	 * replayed (too dangerous after an arbitrary delay). Reset them once to the
	 * device's actual value so they do not look like the current setting.
	 */
	private async reconcileStaleControls(): Promise<void> {
		if (this.staleControlsChecked || !this.modelPopulated || this.unloading) return;
		this.staleControlsChecked = true;
		for (const id of CONTROL_STATE_IDS) {
			if (this.unloading) return;
			const state = await this.getStateAsync(id);
			if (this.unloading) return;
			if (!state || state.ack !== false) continue;
			this.log.warn(`control ${id} was written while the adapter was down; not replaying it`);
			const actual = this.actualControlValue(id);
			if (actual !== undefined && !this.unloading) {
				await this.setStateAsync(id, { val: actual, ack: true });
			}
		}
	}

	/** Publish device min/max on the scaled control objects, once per change. */
	private async updateSettingObjects(): Promise<void> {
		if (!this.mk2 || this.unloading) return;
		const targets: Array<[number, string]> = [
			[6, "control.IMainsLimitAC1"],
			[2, "control.UBatAbsorption"],
			[3, "control.UBatFloat"],
			[4, "control.IBatBulk"],
		];
		for (const [id, key] of targets) {
			let info;
			try {
				info = await this.mk2.getSettingInfo(id);
			} catch {
				continue;
			}
			if (this.unloading) return;
			if (!info.supported || info.min === null || info.max === null) continue;
			const min = Math.round(settingDisplayValue(info, info.min) * 1000) / 1000;
			const max = Math.round(settingDisplayValue(info, info.max) * 1000) / 1000;
			const signature = `${min}:${max}`;
			if (this.settingObjectBounds.get(key) === signature) continue;
			await this.extendObjectAsync(key, { common: { min, max } });
			this.settingObjectBounds.set(key, signature);
		}
	}

	/** Device value that corresponds to a control command state, if known. */
	private actualControlValue(name: string): number | boolean | undefined {
		// Before the first full poll the model still holds static defaults, not
		// device values; publishing them as "actual" would fabricate a setting.
		if (!this.modelPopulated) return undefined;
		if (!this.mk2) return undefined;
		const model = this.mk2.mk2Model;
		const num = (key: string): number | undefined => {
			const value = model[key]?.value;
			return typeof value === "number" ? value : undefined;
		};
		const flag = (key: string): number | undefined => {
			const value = model[key]?.value;
			return typeof value === "boolean" ? (value ? 1 : 0) : undefined;
		};
		switch (name) {
			case "control.set_assist": return this.mk2.getReconciledAssistSetpoint();
			case "control.switch_state": return this.mk2.hasUnambiguousSwitchState() ? num("switch.state") : undefined;
			case "control.force_state": {
				const encodedState = num("state.state");
				const subState = num("state.substate");
				if (encodedState === undefined || subState === undefined) return undefined;
				if (Math.floor(encodedState / 10) !== 9) return 0;
				// Device charge sub-states differ from the public command values.
				return subState === 7 ? 1 : subState === 6 ? 2 : subState === 3 ? 3 : 0;
			}
			case "control.grid_mode": {
				if (!this.mk2.hasUnambiguousSwitchState()) return undefined;
				const switchState = num("switch.state");
				const limit = num("assist.limit");
				const encodedState = num("state.state");
				const mainState = encodedState === undefined ? undefined : Math.floor(encodedState / 10);
				if (switchState === 2) return 2;
				if (switchState === undefined || limit === undefined) return undefined;
				if (mainState !== undefined && mainState >= 4 && mainState <= 6
					&& (limit === 0 || this.mk2.getConfirmedInputCurrentSetpoint() === 0)) return 1;
				if (mainState !== undefined && mainState >= 7 && mainState <= 9) return 0;
				return undefined;
			}
			case "control.IBatBulk": return num("setting.IBatBulk");
			case "control.UBatAbsorption": return num("setting.UBatAbsorption");
			case "control.UBatFloat": return num("setting.UBatFloat");
			case "control.IMainsLimitAC1": return num("setting.IMainsLimitAC1");
			case "control.DisableCharge": return flag("setting.flag.DisableCharge");
			case "control.WeakACInput": return flag("setting.flag.WeakACInput");
			case "control.DisableAES": return flag("setting.flag.DisableAES");
			case "control.AssistEnabled": return flag("setting.flag.AssistEnabled");
			case "control.DynamicCurrentLimiter": return flag("setting.flag.DynamicCurrentLimiter");
			default: return undefined;
		}
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (!state) {
			this.log.info(`state ${id} deleted`);
			return;
		}

		const idShort = splitIdFromAdapter(id);
		if (shouldHandleControlState(idShort, state) && this.mk2) {
			this.log.debug(`control ${id} -> MK2 value ${state.val}`);
			this.toSendQueue.push({
				name: idShort,
				value: state.val as number,
				attempts: 0,
				ts: Date.now(),
			});
			return;
		}
		if (!CONTROL_STATE_IDS.has(idShort)) return;
		if (state.ack !== false) return;
		// A control state written as a string used to be a completely silent
		// no-op. Say why it was ignored.
		if (typeof state.val !== "number") {
			this.log.warn(`control ${id}: value ${JSON.stringify(state.val)} is not a number; write ignored`);
		} else {
			this.log.debug(`control ${id}: ack=${String(state.ack)}; only ack=false commands are forwarded`);
		}
	}
}

if (require.main !== module) {
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new VictronMk2(options);
} else {
	(() => new VictronMk2())();
}
