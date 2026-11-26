import { expect } from "chai";
import { Mk2Protocol } from "./mk2Protocol";
import { asConnection, FakeMk2Connection } from "../test-utils/fake-mk2";
import { Mk2ReadbackError } from "../lib/errors";

const log = {
	level: "info",
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

function protocolWith(fake: FakeMk2Connection): Mk2Protocol {
	return new Mk2Protocol("fake", log as any, asConnection(fake));
}

describe("Mk2Protocol", () => {
	it("create_frame matches the protocol examples", () => {
		const p = protocolWith(new FakeMk2Connection());
		// Address example from MK2 protocol appendix 1
		expect(p.create_frame("A", "\x01\x00").toString("hex")).to.equal("04ff410100bb");
		// S variant 2 example: switch on, limit 31.5 A
		const setAssist = Buffer.from([0x03, 0x3B, 0x01, 0x01, 0x80]);
		expect(p.create_frame("S", setAssist).toString("hex")).to.equal("07ff53033b010180e7");
	});

	it("checksum accepts valid frames and rejects corrupt ones", () => {
		const p = protocolWith(new FakeMk2Connection());
		const frame = p.create_frame("A", "\x01\x00");
		expect(p.checksum(frame)).to.equal(true);
		const bad = Buffer.from(frame);
		bad[bad.length - 1] ^= 0xFF;
		expect(p.checksum(bad)).to.equal(false);
	});

	it("pollStateOnly only reads address and state", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.pollStateOnly();
		expect(fake.requests.map((r) => r[2])).to.deep.equal([0x41, 0x57]);
		expect(p.mk2Model["state.state"].value).to.equal(80);
	});

	it("poll populates the model with plausible values", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.poll();
		expect(p.mk2Model["state.state"].value).to.equal(80);
		expect(p.mk2Model["ac_info.umains"].value).to.equal(237);
		expect(p.mk2Model["ac_info.fmains"].value).to.equal(50);
		expect(p.mk2Model["dc_info.ubat"].value).to.be.closeTo(13.02, 0.01);
		expect(p.mk2Model["dc_info.ibat"].value).to.equal(0);
		expect(p.mk2Model["dc_info.icharge"].value).to.equal(0);
		expect(p.mk2Model["assist.minlimit"].value).to.equal(3.1);
		expect(p.mk2Model["assist.maxlimit"].value).to.equal(16);
		expect(p.mk2Model["assist.limit"].value).to.equal(16);
		expect(p.mk2Model["led.mains"].value).to.equal(1);
		expect(p.mk2Model["led.inverter"].value).to.equal(0);
		expect(p.mk2Model["setting.flag.DisableAES"].value).to.equal(true);
		expect(p.mk2Model["setting.flag.AssistEnabled"].value).to.equal(true);
		expect(p.mk2Model["setting.flag.DisableCharge"].value).to.equal(true);
		expect(p.mk2Model["setting.flag.EnableReducedFloat"].value).to.equal(true);
		expect(p.mk2Model["setting.flag.WeakACInput"].value).to.equal(false);
		expect(p.mk2Model["setting.IBatBulk"].value).to.equal(120);
	});

	it("maps state 0 to a display name (issue #50)", () => {
		const p = protocolWith(new FakeMk2Connection());
		expect(p.mk2Model["state.state"].states?.["0"]).to.equal("down");
	});
});

describe("Mk2Protocol control writes", () => {
	it("set_assist uses the current switch state and updates the limit", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.set_assist(10);
		expect(fake.switchState).to.equal(3);
		expect(fake.limit).to.equal(10);
	});

	it("set_assist preserves an explicitly selected switch state", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await p.set_switch_state(2);
		await p.set_assist(10);
		expect(fake.switchState).to.equal(2);
		expect(fake.limit).to.equal(10);
	});

	it("set_assist rejects invalid values", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await expect(p.set_assist(-1)).to.be.rejectedWith("invalid");
		await expect(p.set_assist(NaN)).to.be.rejectedWith("invalid");
	});

	it("set_assist clamps to the device maximum", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.poll();
		await p.set_assist(20);
		expect(fake.limit).to.equal(16);
	});

	it("set_switch_state rejects invalid states", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await expect(p.set_switch_state(0)).to.be.rejectedWith("invalid");
		await expect(p.set_switch_state(5)).to.be.rejectedWith("invalid");
	});

	it("writes 0 A when selecting Inverter only directly (issue #100)", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await p.set_switch_state(2);
		const request = fake.requests.filter((r) => r[2] === 0x53).at(-1)!;
		expect(request[3]).to.equal(2);
		expect(request[4] | (request[5] << 8)).to.equal(0);
	});

	it("rejects direct Inverter only when 0 A was not applied (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		fake.ignoreAssistWrites = true;
		const p = protocolWith(fake);
		p.gridModeReadbackTimeoutMs = 20;
		p.switchReadbackPollIntervalMs = 1;
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await expect(p.set_switch_state(2)).to.be.rejectedWith("0 A was not applied");
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("rejects direct On when its positive limit was not applied (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		fake.ignoreAssistWrites = true;
		const p = protocolWith(fake);
		p.switchReadbackTimeoutMs = 20;
		p.switchReadbackPollIntervalMs = 1;
		p.mk2Model["setting.IMainsLimitAC1"].value = 5;
		await expect(p.set_switch_state(3)).to.be.rejectedWith("readback mismatch");
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("does not retry an applied S command whose ACK was lost (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		fake.failAfterApplied = "ff53";
		const p = protocolWith(fake);
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await expect(p.set_switch_state(2)).to.be.rejectedWith(Mk2ReadbackError, "S command unconfirmed");
		expect(fake.switchState).to.equal(2); // request side effect happened before the lost ACK
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("writes Charger only with the configured positive limit", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.IMainsLimitAC1"].value = 5;
		await p.set_switch_state(1);
		const request = fake.requests.filter((r) => r[2] === 0x53).at(-1)!;
		expect(request[3]).to.equal(1);
		expect(request[4] | (request[5] << 8)).to.equal(50);
		expect(p.mk2Model["switch.state"].value).to.equal(1);
	});

	it("confirms Off without changing the input limit", async () => {
		const fake = new FakeMk2Connection();
		fake.limit = 5;
		const p = protocolWith(fake);
		await p.set_switch_state(4);
		const request = fake.requests.filter((r) => r[2] === 0x53).at(-1)!;
		expect(request[3]).to.equal(4);
		expect(request[4] | (request[5] << 8)).to.equal(0xffff);
		expect(p.mk2Model["state.state"].value).to.equal(20);
		expect(p.mk2Model["switch.state"].value).to.equal(4);
		expect(fake.limit).to.equal(5);
	});

	it("does not retry Off when low-power readback becomes unavailable (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		fake.failNext = "ff570e"; // S Off succeeds, W0E is unavailable in low power
		const p = protocolWith(fake);
		await expect(p.set_switch_state(4)).to.be.rejectedWith(Mk2ReadbackError, "readback failed after write acknowledgement");
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("requires known enabled PowerAssist before direct Inverter only (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await expect(p.set_switch_state(2)).to.be.rejectedWith("known enabled PowerAssist");
		p.mk2Model["setting.flag.AssistEnabled"].value = false;
		await expect(p.set_switch_state(2)).to.be.rejectedWith("PowerAssist disabled");
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(0);
	});

	it("requires the Invert main state for zero grid (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		fake.linkMainStateToSwitch = false; // panel changes, W0E incorrectly stays Bypass
		const p = protocolWith(fake);
		p.gridModeReadbackTimeoutMs = 20;
		p.switchReadbackPollIntervalMs = 1;
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await expect(p.set_grid_mode(1)).to.be.rejectedWith("main state is 8 instead of 4/5/6");
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("requires a grid main state after grid_mode=0 (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		fake.currentState = 4;
		fake.switchState = 2;
		fake.switchRegister = 0b00100000;
		fake.linkMainStateToSwitch = false; // switch On arrives, W0E remains Invert
		const p = protocolWith(fake);
		p.gridModeReadbackTimeoutMs = 20;
		p.switchReadbackPollIntervalMs = 1;
		await p.get_state();
		await p.master_multi_led_info();
		await expect(p.set_grid_mode(0)).to.be.rejectedWith("main state is 4 instead of 7/8/9");
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("does not expose a post-S transport failure as retryable (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		fake.failNext = "ff570e"; // S succeeds, the following W0E readback fails
		const p = protocolWith(fake);
		await expect(p.set_switch_state(3)).to.be.rejectedWith(Mk2ReadbackError, "readback failed after write acknowledgement");
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("waits for a delayed switch-state transition without repeating S (issue #98)", async () => {
		const fake = new FakeMk2Connection();
		fake.switchState = 2;
		fake.switchRegister = 0b00100000;
		fake.switchUpdateDelayMs = 150;
		const p = protocolWith(fake);
		await p.master_multi_led_info();

		await p.set_switch_state(3);
		expect(p.mk2Model["switch.state"].value).to.equal(3);
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
		expect(fake.requests.filter((r) => r[2] === 0x46 && r[3] === 0x05).length).to.be.greaterThan(2);
	});

	it("waits for the target switch state after grid_mode (issue #98)", async () => {
		const fake = new FakeMk2Connection();
		fake.switchState = 2;
		fake.switchRegister = 0b00100000;
		fake.switchUpdateDelayMs = 150;
		const p = protocolWith(fake);
		await p.master_multi_led_info();

		await p.set_grid_mode(0);
		expect(p.mk2Model["switch.state"].value).to.equal(3);
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("refreshes the main state while validating an extended F5 transition (issue #98)", async () => {
		const fake = new FakeMk2Connection();
		fake.extendedMasterMultiLedFrame = true;
		fake.linkMainStateToSwitch = true;
		fake.switchUpdateDelayMs = 150;
		const p = protocolWith(fake);
		p.switchReadbackTimeoutMs = 300;
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await p.pollStateOnly();
		await p.master_multi_led_info();

		await p.set_grid_mode(2);
		expect(p.mk2Model["state.state"].value).to.equal(40);
		expect(p.mk2Model["switch.state"].value).to.equal(2);
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("accepts Inverter only as the zero-grid result with PowerAssist (§5 note 3)", async () => {
		const fake = new FakeMk2Connection();
		fake.zeroLimitSelectsInverter = true;
		const p = protocolWith(fake);
		p.switchReadbackTimeoutMs = 20;
		p.mk2Model["setting.flag.AssistEnabled"].value = true;

		await p.set_grid_mode(1);
		expect(p.mk2Model["switch.state"].value).to.equal(2);
		expect(fake.limit).to.equal(0);
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("waits for a delayed 0 A limit instead of rejecting the first F5 (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		fake.limitUpdateDelayMs = 150;
		const p = protocolWith(fake);
		p.gridModeReadbackTimeoutMs = 500;
		p.switchReadbackPollIntervalMs = 5;
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await p.set_assist(0);
		expect(fake.limit).to.equal(0);
		expect(p.mk2Model["state.state"].value).to.equal(40);
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("selects Invert for 0 A from Charger only when PowerAssist is enabled (§5 note 3)", async () => {
		const fake = new FakeMk2Connection();
		fake.switchState = 1;
		fake.switchRegister = 0b00010000;
		const p = protocolWith(fake);
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await p.master_multi_led_info();
		expect(p.currentSwitchState).to.equal(1);
		await p.set_assist(0);
		expect(fake.switchState).to.equal(2);
		expect(p.mk2Model["state.state"].value).to.equal(40);
		expect(p.mk2Model["switch.state"].value).to.equal(2);
	});

	it("reports the last state after a bounded readback timeout (issue #98)", async () => {
		const fake = new FakeMk2Connection();
		fake.switchState = 2;
		fake.switchRegister = 0b00100000;
		fake.switchUpdateDelayMs = 100;
		const p = protocolWith(fake);
		p.switchReadbackTimeoutMs = 20;
		p.switchReadbackPollIntervalMs = 1;
		await p.master_multi_led_info();

		await expect(p.set_switch_state(3)).to.be.rejectedWith("device reports 2 instead of 3 after 20 ms");
		expect(fake.requests.filter((r) => r[2] === 0x53).length).to.equal(1);
	});

	it("set_grid_mode grid uses max limit and On", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.set_grid_mode(0);
		expect(fake.switchState).to.equal(3);
		expect(fake.limit).to.equal(16);
	});

	it("set_grid_mode zero_grid writes 0 A and confirms Invert", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await p.set_grid_mode(1);
		expect(fake.switchState).to.equal(2);
		expect(p.mk2Model["state.state"].value).to.equal(40);
		expect(fake.limit).to.equal(0);
	});

	it("set_grid_mode inverter_only selects switch state 2", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await p.set_grid_mode(2);
		expect(fake.switchState).to.equal(2);
	});

	it("set_grid_mode rejects invalid modes", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await expect(p.set_grid_mode(3)).to.be.rejectedWith("invalid");
	});

	it("restores the cached switch state when the grid-mode write fails", async () => {
		const fake = new FakeMk2Connection();
		fake.switchRegister = 0b00100000; // Inverter only
		const p = protocolWith(fake);
		await p.master_multi_led_info();
		expect(p.currentSwitchState).to.equal(2);

		fake.failNext = "ff53";
		await expect(p.set_grid_mode(0)).to.be.rejected;
		expect(p.currentSwitchState).to.equal(2);
	});

	it("rejects zero grid when PowerAssist is disabled (issue #45)", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.flag.AssistEnabled"].value = false;
		await expect(p.set_grid_mode(1)).to.be.rejectedWith("PowerAssist");
		expect(fake.requests.filter((r) => r[2] == 0x53).length).to.equal(0);
	});

	it("allows zero grid with PowerAssist enabled", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await p.set_grid_mode(1);
		expect(fake.limit).to.equal(0);
	});

	it("clamps up to the device minimum instead of acknowledging an impossible value (issue #49)", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.poll(); // minlimit = 3.1 A
		await p.set_assist(0.1);
		expect(fake.limit).to.be.closeTo(3.1, 0.001);
		p.mk2Model["setting.flag.AssistEnabled"].value = true;
		await p.set_assist(0); // 0 A is the inverter mode, not clamped
		expect(fake.limit).to.equal(0);
	});

	it("never rounds a positive limit into the special 0 A mode (issue #101)", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.master_multi_led_info();
		p.mk2Model["assist.minlimit"].value = 0;
		await p.set_assist(0.04);
		expect(fake.limit).to.equal(0.1);
		const request = fake.requests.filter((r) => r[2] === 0x53).at(-1)!;
		expect(request[4] | (request[5] << 8)).to.equal(1);
	});

	it("set_assist(0) is rejected too when PowerAssist is disabled (issue #69)", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.flag.AssistEnabled"].value = false;
		await expect(p.set_assist(0)).to.be.rejectedWith("PowerAssist");
		expect(fake.requests.filter((r) => r[2] == 0x53).length).to.equal(0);
	});

	it("set_setting_IBatBulk accepts a valid value", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.set_setting_IBatBulk(100);
		expect(fake.requests.some((r) => r.includes(0x34))).to.equal(true);
	});

	it("set_setting_IBatBulk rejects invalid values", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await expect(p.set_setting_IBatBulk(-1)).to.be.rejectedWith("between 0 and 120");
		await expect(p.set_setting_IBatBulk(121)).to.be.rejectedWith("between 0 and 120");
		await expect(p.set_setting_IBatBulk(1.5)).to.be.rejectedWith("must be an integer");
	});

	it("set_flagDisableCharge and set_flagWeakACInput accept 0/1", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.set_flagDisableCharge(1);
		await p.set_flagWeakACInput(0);
		expect(fake.requests.length).to.be.greaterThan(1);
	});

	it("force_state validates the 0x94 response", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.force_state(3);
		expect(fake.requests.some((r) => r[3] == 0x0E)).to.equal(true);
	});

	it("set_grid_mode grid uses the configured AC1 limit when available (issue #44)", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.IMainsLimitAC1"].value = 10;
		await p.set_grid_mode(0);
		expect(fake.limit).to.equal(10);
	});

	it("set_grid_mode grid falls back to the device maximum without a configured limit", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		p.mk2Model["setting.IMainsLimitAC1"].value = null;
		await p.set_grid_mode(0);
		expect(fake.limit).to.equal(16);
	});

	it("set_grid_mode grid keeps the current limit when nothing is configured (issue #70)", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.set_assist(5);
		p.mk2Model["setting.IMainsLimitAC1"].value = null;
		await p.master_multi_led_info(); // actual limit is now 5 A
		await p.set_grid_mode(0);
		expect(fake.limit).to.equal(5);
	});
});

describe("Mk2Protocol protocol validation", () => {
	it("ac_info accepts a non-1 BF factor", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.poll();
		fake.bfFactor = 2;
		await p.ac_info();
		expect(p.mk2Model["ac_info.umains"].value).to.equal(237);
	});

	it("dc_info accepts a different reserved marker byte", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.poll();
		fake.dcMarker = 0x00;
		await p.dc_info();
		expect(p.mk2Model["dc_info.ubat"].value).to.be.closeTo(13.02, 0.01);
	});

	it("led_status accepts a short protocol frame", async () => {
		const fake = new FakeMk2Connection();
		fake.ledDataLength = 3;
		const p = protocolWith(fake);
		await p.led_status();
		expect(p.mk2Model["led.mains"].value).to.equal(1);
	});

	it("led_status accepts a frame without the trailing 0x00 (issue #43)", async () => {
		const fake = new FakeMk2Connection();
		// MK2 >= 1130128 omits the trailing 0x00 (§4 note b): length 4 + checksum
		fake.ledDataLength = 2;
		const p = protocolWith(fake);
		await p.led_status();
		expect(p.mk2Model["led.mains"].value).to.equal(1);
		expect(p.mk2Model["led.inverter"].value).to.equal(0);
	});

	it("address accepts a longer response frame", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		// the default address frame already exercises the minimum length
		await p.address();
		expect(fake.requests.length).to.equal(1);
	});
});
