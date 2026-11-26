import { expect } from "chai";
import proxyquire from "proxyquire";
import { Mk2ValidationError } from "./lib/errors";
import { Mk2Protocol } from "./mk2/mk2Protocol";
import { asConnection, FakeMk2Connection, FakeMk2Serial, versionFrame } from "./test-utils/fake-mk2";
import { Mk2Connection } from "./mk2/mk2Connection";
import { PollLoop } from "./lib/poll-loop";

/**
 * Adapter lifecycle tests with a stubbed ioBroker runtime. No hardware and no
 * js-controller are involved; the point is to cover the paths that the dummy
 * test never touched (onReady failure, empty port, startup state, unload).
 */
class FakeAdapter {
	public log: any;
	public errors: string[] = [];
	public states: Record<string, any> = {};
	public objects: Record<string, any> = {};
	public config: any = {};
	public handlers: Record<string, (...args: any[]) => any> = {};
	public subscriptions: string[] = [];
	public failGetObject = false;

	constructor(public options: any) {
		this.log = {
			level: "info",
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: (msg: string) => {
				this.errors.push(msg);
			},
		};
	}

	on(event: string, cb: any): void {
		this.handlers[event] = cb;
	}

	async setStateAsync(id: string, state: any): Promise<void> {
		this.states[id] = state;
	}

	async getStateAsync(id: string): Promise<any> {
		return this.states[id];
	}

	async getObjectAsync(id: string): Promise<any> {
		if (this.failGetObject) {
			throw new Error("state database unavailable");
		}
		return this.objects[id];
	}

	async setObjectNotExistsAsync(id: string, obj: any): Promise<void> {
		this.objects[id] = obj;
	}

	async extendObjectAsync(id: string, obj: any): Promise<void> {
		this.objects[id] = { ...this.objects[id], ...obj };
	}

	subscribeStates(pattern: string): void {
		this.subscriptions.push(pattern);
	}
}

function createAdapter(config: any, failGetObject = false): any {
	const { default: _unused, ...rest } = {} as any; // keep linters quiet about unused vars
	void rest;
	const factory = proxyquire.noCallThru()("./main", {
		"@iobroker/adapter-core": { Adapter: FakeAdapter },
	}) as any;
	const adapter = factory({});
	adapter.config = config;
	adapter.failGetObject = failGetObject;
	return adapter;
}

describe("adapter lifecycle", () => {
	it("reports a failed onReady instead of crashing (issue #57)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 }, true);
		await adapter.handlers.ready();
		expect(adapter.errors.some((m: string) => m.includes("onReady failed"))).to.equal(true);
		expect(adapter.states["info.connection"].val).to.equal(false);
		expect(adapter.pollLoop).to.equal(undefined);
	});

	it("creates objects and reports not-connected with an empty port (issues #52, #58)", async () => {
		const adapter = createAdapter({ portPath: "", interval: 3600 });
		await adapter.handlers.ready();
		expect(Object.keys(adapter.objects).length).to.be.greaterThan(50);
		expect(adapter.states["info.connection"].val).to.equal(false);
		expect(adapter.pollLoop).to.equal(undefined);
		expect(adapter.subscriptions).to.have.length(0);
	});

	it("starts with connection=false and only then starts the loop (issues #58, #79)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		await adapter.handlers.ready();
		expect(adapter.states["info.connection"].val).to.equal(false);
		expect(adapter.pollLoop).to.not.equal(undefined);
		expect(adapter.mk2.conn.responseTimeoutMs).to.equal(5000);
		expect(adapter.subscriptions).to.deep.equal(["control.*"]);
		await adapter.handlers.unload(() => undefined);
	});

	it("keeps an explicitly configured response timeout (issue #79)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600, responseTimeout: 2750 });
		await adapter.handlers.ready();
		expect(adapter.mk2.conn.responseTimeoutMs).to.equal(2750);
		await adapter.handlers.unload(() => undefined);
	});

	it("mirrors the grid-mode input limit into control.set_assist", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		adapter.mk2 = {
			master_multi_led_info: async () => undefined,
			mk2Model: {
				"control.grid_mode": { value: 2, setFunc: async () => 0 },
				"control.set_assist": { value: 16 },
				"diag.last_control_error": { value: "" },
			},
		};
		adapter.toSendQueue = [{ name: "control.grid_mode", value: 0, attempts: 0 }];

		await adapter.processToSendQueue();

		expect(adapter.states["control.grid_mode"]).to.include({ val: 0, ack: true });
		expect(adapter.states["control.set_assist"]).to.include({ val: 16, ack: true });
	});

	it("resets a rejected control state to the device value", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		adapter.modelPopulated = true;
		adapter.mk2 = {
			master_multi_led_info: async () => undefined,
			mk2Model: {
				"control.IMainsLimitAC1": {
					value: 15,
					setFunc: async () => {
						throw new Mk2ValidationError("out of range");
					},
				},
				"setting.IMainsLimitAC1": { value: 16 },
				"diag.last_control_error": { value: "" },
			},
		};
		adapter.states["control.IMainsLimitAC1"] = { val: 15, ack: false };
		adapter.toSendQueue = [{ name: "control.IMainsLimitAC1", value: 15, attempts: 0 }];

		await adapter.processToSendQueue();

		// The rejected request must not stay visible as the current value.
		expect(adapter.states["control.IMainsLimitAC1"]).to.include({ val: 16, ack: true });
	});

	it("does not reset a control state that was overwritten by a newer request", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		adapter.modelPopulated = true;
		adapter.mk2 = {
			master_multi_led_info: async () => undefined,
			mk2Model: {
				"control.IMainsLimitAC1": {
					value: 15,
					setFunc: async () => {
						throw new Mk2ValidationError("out of range");
					},
				},
				"setting.IMainsLimitAC1": { value: 16 },
				"diag.last_control_error": { value: "" },
			},
		};
		adapter.states["control.IMainsLimitAC1"] = { val: 14, ack: false };
		adapter.toSendQueue = [{ name: "control.IMainsLimitAC1", value: 15, attempts: 0 }];

		await adapter.processToSendQueue();

		expect(adapter.states["control.IMainsLimitAC1"]).to.include({ val: 14, ack: false });
	});

	it("does not start a second loop when mainLoop runs twice (issue #64)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		await adapter.handlers.ready();
		const first = adapter.pollLoop;
		adapter.mainLoop();
		expect(adapter.pollLoop).to.equal(first);
		await adapter.handlers.unload(() => undefined);
	});

	it("publishes reconnection after a recovered state-only poll failure (issue #77)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const model: Record<string, any> = {
			"info.connection": { value: false },
			"info.address": { value: 0 },
			"state.state": { value: 80 },
			"state.substate": { value: 0 },
			"assist.maxlimit": { value: null },
			"diag.timeouts": { value: 0 },
			"diag.checksum_errors": { value: 0 },
			"diag.last_error": { value: "" },
		};
		let failStatePoll = false;
		adapter.mk2 = {
			conn: { timeouts: 0, checksumErrors: 0, lastError: "" },
			mk2Model: model,
			pollStateOnly: async () => {
				if (failStatePoll) throw new Error("state poll timeout");
				model["info.connection"].value = true;
			},
			poll: async () => {
				model["info.connection"].value = true;
			},
		};
		adapter.toSendQueue = [];

		await adapter.updateStates();
		expect(adapter.states["info.connection"].val).to.equal(true);

		failStatePoll = true;
		await adapter.updateStates();
		expect(adapter.states["info.connection"].val).to.equal(false);

		failStatePoll = false;
		await adapter.updateStates();
		expect(adapter.states["info.connection"].val).to.equal(true);
	});

	it("skips the full poll while Off with no power-on request (issue #83)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const fake = new FakeMk2Connection();
		fake.currentState = 2;
		fake.switchState = 4;
		fake.switchRegister = 0;
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		adapter.mk2 = protocol;
		adapter.toSendQueue = [];
		let fullPolls = 0;
		protocol.poll = async () => {
			fullPolls++;
			protocol.mk2Model["info.connection"].value = false;
		};

		await adapter.updateStates();

		expect(fullPolls).to.equal(0);
		expect(adapter.states["state.state"].val).to.equal(20);
		expect(adapter.states["info.connection"].val).to.equal(true);
		expect(adapter.states["switch.state"]).to.equal(undefined);
		expect(adapter.states["dc_info.ubat"]).to.equal(undefined);
		expect(adapter.states["led.mains"]).to.equal(undefined);
	});

	it("processes explicit power-on controls without a full poll while Off (issue #83)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const fake = new FakeMk2Connection();
		fake.currentState = 2;
		fake.switchState = 4;
		fake.switchRegister = 0;
		const originalFlags = fake.flags0;
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		adapter.mk2 = protocol;
		adapter.toSendQueue = [
			{ name: "control.DisableCharge", value: 0, attempts: 0 },
			{ name: "control.switch_state", value: 3, attempts: 0 },
		];
		let fullPolls = 0;
		protocol.poll = async () => {
			fullPolls++;
			protocol.mk2Model["info.connection"].value = false;
		};

		await adapter.updateStates();

		expect(fullPolls).to.equal(0);
		expect(fake.switchState).to.equal(3);
		expect(fake.flags0).to.equal(originalFlags); // non-power-on control was not sent
		expect(adapter.toSendQueue).to.have.length(0);
		expect(adapter.states["control.switch_state"]).to.include({ val: 3, ack: true });
	});

	it("rejects Off grid-mode recovery without a known AC input limit (issue #83)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const fake = new FakeMk2Connection();
		fake.currentState = 2;
		fake.switchState = 4;
		fake.switchRegister = 0;
		fake.limit = 0;
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		adapter.mk2 = protocol;
		adapter.toSendQueue = [{ name: "control.grid_mode", value: 0, attempts: 0 }];
		protocol.poll = async () => {
			protocol.mk2Model["info.connection"].value = false;
		};

		await adapter.updateStates();

		expect(fake.switchState).to.equal(4);
		expect(fake.requests.some((request) => request[2] === 0x53)).to.equal(false);
		expect(adapter.toSendQueue).to.have.length(0);
		expect(adapter.states["diag.last_control_error"].val).to.contain("known AC input limit");
	});

	it("loads Flags0 for Off grid modes that need PowerAssist (issues #82, #83)", async () => {
		for (const [mode, expectedSwitch] of [[1, 2], [2, 2]]) {
			const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
			const fake = new FakeMk2Connection();
			fake.currentState = 2;
			fake.switchState = 4;
			fake.switchRegister = 0;
			const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
			adapter.mk2 = protocol;
			adapter.toSendQueue = [{ name: "control.grid_mode", value: mode, attempts: 0 }];
			protocol.poll = async () => {
				throw new Error("full poll must not be required");
			};

			await adapter.updateStates();

			expect(fake.switchState).to.equal(expectedSwitch);
			expect(adapter.states["setting.flag.AssistEnabled"].val).to.equal(true);
			expect(adapter.toSendQueue).to.have.length(0);
		}
	});

	it("loads Flags0 for Off direct Inverter-only recovery (issue #101)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const fake = new FakeMk2Connection();
		fake.currentState = 2;
		fake.switchState = 4;
		fake.switchRegister = 0;
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		adapter.mk2 = protocol;
		adapter.toSendQueue = [{ name: "control.switch_state", value: 2, attempts: 0 }];
		protocol.poll = async () => {
			throw new Error("full poll must not be required");
		};

		await adapter.updateStates();

		expect(fake.switchState).to.equal(2);
		expect(adapter.states["setting.flag.AssistEnabled"].val).to.equal(true);
		expect(adapter.toSendQueue).to.have.length(0);
	});

	it("rejects Off grid-mode recovery when the panel register is missing (issue #83)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const fake = new FakeMk2Connection();
		fake.currentState = 2;
		fake.switchState = 4;
		fake.masterMultiLedHasRegister = false;
		fake.limit = 0;
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		adapter.mk2 = protocol;
		adapter.toSendQueue = [{ name: "control.grid_mode", value: 0, attempts: 0 }];
		adapter.states["control.grid_mode"] = { val: 0, ack: false };
		protocol.poll = async () => {
			protocol.mk2Model["info.connection"].value = false;
		};

		await adapter.updateStates();

		expect(protocol.currentSwitchState).to.equal(3);
		expect(fake.switchState).to.equal(4);
		expect(fake.requests.some((request) => request[2] === 0x53)).to.equal(false);
		expect(adapter.states["control.grid_mode"]).to.include({ val: 0, ack: false });
		expect(adapter.states["diag.last_control_error"].val).to.contain("known AC input limit");
	});

	it("does not reset stale controls before the model was polled (issue #83)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const fake = new FakeMk2Connection();
		fake.currentState = 2;
		fake.switchState = 4;
		fake.switchRegister = 0;
		fake.limit = 0;
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		adapter.mk2 = protocol;
		adapter.toSendQueue = [];
		adapter.states["control.switch_state"] = { val: 4, ack: false };
		protocol.poll = async () => {
			protocol.mk2Model["info.connection"].value = false;
		};

		await adapter.updateStates();

		// The Off cycle never polled switch.state, so its static default must not
		// be published as the device's actual value.
		expect(adapter.states["control.switch_state"]).to.include({ val: 4, ack: false });
	});

	it("resets a stale control state once a full poll populated the model", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const fake = new FakeMk2Connection();
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		adapter.mk2 = protocol;
		adapter.toSendQueue = [];
		adapter.states["control.switch_state"] = { val: 4, ack: false };

		await adapter.updateStates();

		expect(adapter.states["control.switch_state"]).to.include({ val: 3, ack: true });
	});

	it("maps forced charge sub-states back to public force_state values (issue #103)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		adapter.modelPopulated = true;
		adapter.mk2 = new Mk2Protocol("fake", adapter.log, asConnection(new FakeMk2Connection()));
		for (const [encoded, subState, expected] of [[97, 7, 1], [96, 6, 2], [93, 3, 3], [92, 2, 0], [80, 0, 0]]) {
			adapter.mk2.mk2Model["state.state"].value = encoded;
			adapter.mk2.mk2Model["state.substate"].value = subState;
			expect(adapter.actualControlValue("control.force_state")).to.equal(expected);
		}
	});

	it("stops all follow-up work after a failed full poll (issue #82)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const fake = new FakeMk2Connection();
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		adapter.mk2 = protocol;
		adapter.toSendQueue = [];
		protocol.poll = async () => {
			protocol.mk2Model["info.connection"].value = false;
			protocol.mk2Model["diag.timeouts"].value = 7;
		};
		let metadataReads = 0;
		protocol.getSettingInfo = async () => {
			metadataReads++;
			throw new Error("must not be called");
		};

		await adapter.updateStates();

		expect(adapter.states["info.connection"].val).to.equal(false);
		expect(adapter.states["diag.timeouts"].val).to.equal(7);
		expect(metadataReads).to.equal(0);
		expect(adapter.states["switch.state"]).to.equal(undefined);
		expect(adapter.states["dc_info.ubat"]).to.equal(undefined);
	});

	it("publishes all diagnostics after a state-only failure (issue #82)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const fake = new FakeMk2Connection();
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		adapter.mk2 = protocol;
		adapter.toSendQueue = [];
		protocol.pollStateOnly = async () => {
			protocol.mk2Model["diag.protocol_errors"].value = 2;
			protocol.mk2Model["diag.sync_errors"].value = 3;
			throw new Error("state-only failure");
		};

		await adapter.updateStates();

		expect(adapter.states["info.connection"].val).to.equal(false);
		expect(adapter.states["diag.protocol_errors"].val).to.equal(2);
		expect(adapter.states["diag.sync_errors"].val).to.equal(3);
	});

	it("never defaults set_assist to the device maximum when AC1 is unknown (#118)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(new FakeMk2Connection()));
		adapter.mk2 = protocol;
		protocol.mk2Model["assist.maxlimit"].value = 32;
		protocol.mk2Model["setting.IMainsLimitAC1"].value = null;
		await adapter.updateAssistLimitObject();
		expect(adapter.objects["control.set_assist"].common).to.include({ min: 0, max: 32 });
		expect(adapter.objects["control.set_assist"].common.def).to.equal(null);

		protocol.mk2Model["setting.IMainsLimitAC1"].value = 5;
		await adapter.updateAssistLimitObject();
		expect(adapter.objects["control.set_assist"].common.def).to.equal(5);
		protocol.mk2Model["setting.IMainsLimitAC1"].value = 7;
		await adapter.updateAssistLimitObject();
		expect(adapter.objects["control.set_assist"].common.def).to.equal(7);
	});

	it("does not acknowledge a dropped positive request from the old 0 A minimum (#119)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		adapter.modelPopulated = true;
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(new FakeMk2Connection()));
		adapter.mk2 = protocol;
		protocol.mk2Model["state.state"].value = 40;
		protocol.mk2Model["assist.minlimit"].value = 3.1;
		protocol.mk2Model["assist.limit"].value = 3.1;
		expect(adapter.actualControlValue("control.set_assist")).to.equal(undefined);
		expect(adapter.actualControlValue("control.grid_mode")).to.equal(undefined);
	});

	it("reports and reconciles controls dropped by the Off filter (#120)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		adapter.modelPopulated = true;
		adapter.staleControlsChecked = true;
		const fake = new FakeMk2Connection();
		fake.currentState = 2;
		fake.switchState = 4;
		fake.switchRegister = 0;
		const protocol = new Mk2Protocol("fake", adapter.log, asConnection(fake));
		protocol.mk2Model["setting.flag.DisableCharge"].value = true;
		adapter.mk2 = protocol;
		adapter.states["control.DisableCharge"] = { val: 0, ack: false };
		adapter.toSendQueue = [{ name: "control.DisableCharge", value: 0, attempts: 0 }];
		await adapter.updateStates();
		expect(fake.writes).to.have.length(0);
		expect(adapter.states["control.DisableCharge"]).to.include({ val: 1, ack: true });
		expect(adapter.states["diag.last_control_error"].val).to.contain("device is Off");
	});

	it("clamps an oversized interval instead of overflowing the timer (#121)", async () => {
		const adapter = createAdapter({ portPath: "", interval: 2_147_483.648 });
		await adapter.handlers.ready();
		expect(adapter.config.interval).to.equal(2);
	});

	it("cancels serial work and emits no states after the unload callback (#122)", async () => {
		const adapter = createAdapter({ portPath: "/dev/null", interval: 3600 });
		const serial = new FakeMk2Serial();
		serial.push(versionFrame());
		const conn = new Mk2Connection("fake", adapter.log, serial as any);
		conn.responseTimeoutMs = 10000;
		adapter.mk2 = new Mk2Protocol("fake", adapter.log, conn);
		const events: string[] = [];
		const originalSetState = adapter.setStateAsync.bind(adapter);
		adapter.setStateAsync = async (id: string, state: any) => {
			events.push(`state:${id}`);
			return originalSetState(id, state);
		};
		adapter.pollLoop = new PollLoop(() => adapter.updateStates(), 1000);
		adapter.pollLoop.start(0);
		await new Promise((resolve) => setTimeout(resolve, 30));
		await adapter.handlers.unload(() => events.push("callback"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(events.indexOf("callback")).to.be.greaterThanOrEqual(0);
		expect(events.slice(events.indexOf("callback") + 1).filter((event) => event.startsWith("state:"))).to.have.length(0);
		expect(serial.isOpen()).to.equal(false);
	});
});
