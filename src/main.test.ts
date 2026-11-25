import { expect } from "chai";
import proxyquire from "proxyquire";
import { Mk2ValidationError } from "./lib/errors";
import { Mk2Protocol } from "./mk2/mk2Protocol";
import { asConnection, FakeMk2Connection } from "./test-utils/fake-mk2";

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
		for (const [mode, expectedSwitch] of [[1, 3], [2, 2]]) {
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
});
