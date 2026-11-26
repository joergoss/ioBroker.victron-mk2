import { expect } from "chai";
import { Mk2Protocol } from "./mk2Protocol";
import { Mk2Connection } from "./mk2Connection";
import { isStableState } from "../lib/state-gate";
import { processControlWritesDetailed, QueueItem } from "../lib/send-queue";
import { Mk2ValidationError } from "../lib/errors";
import { asConnection, FakeMk2Connection, FakeMk2Serial, mk2Frame, veBusFrame, versionFrame } from "../test-utils/fake-mk2";

const log = {
	level: "info",
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
} as any;

function protocolWith(fake: FakeMk2Connection): Mk2Protocol {
	return new Mk2Protocol("fake", log, asConnection(fake));
}

function protocolWithSerial(fake: FakeMk2Serial): Mk2Protocol {
	return new Mk2Protocol("fake", log, new Mk2Connection("fake", log, fake as any));
}

describe("v0.4.8 protocol-audit regressions", () => {
	describe("F5 switch-register layouts (#108/#109)", () => {
		it("ignores a generic trailing byte instead of replacing the documented register", async () => {
			const f5 = veBusFrame(0x41, [
				0x10, 0, 0, 0, 4, 0x1f, 0, 0xa0, 0, 0x64, 0,
				0x10, // documented Charger only
				0x30, // appended future byte: must not become On
			], 0x0e);
			const serial = new FakeMk2Serial((request) => {
				if (request[2] === 0x57 && request[3] === 0x0e) return mk2Frame(0x57, [0x94, 8, 0]);
				if (request[2] === 0x46 && request[3] === 0x05) return f5;
				return null;
			});
			serial.push(versionFrame());
			const p = protocolWithSerial(serial);
			await p.get_state();
			await p.master_multi_led_info();
			expect(p.mk2Model["switch.state"].value).to.equal(1);
			expect(p.currentSwitchState).to.equal(1);
		});

		it("does not turn a documented On register into Off from appended zeroes", async () => {
			const f5 = veBusFrame(0x41, [
				0x10, 0, 0, 0, 4, 0x1f, 0, 0xa0, 0, 0x64, 0,
				0x30, 0, 0,
			], 0x0f);
			const serial = new FakeMk2Serial((request) => {
				if (request[2] === 0x57 && request[3] === 0x0e) return mk2Frame(0x57, [0x94, 2, 0]);
				if (request[2] === 0x46 && request[3] === 0x05) return f5;
				return null;
			});
			serial.push(versionFrame());
			const p = protocolWithSerial(serial);
			await p.get_state();
			await p.master_multi_led_info();
			expect(p.mk2Model["switch.state"].value).not.to.equal(4);
			expect(p.hasUnambiguousSwitchState()).to.equal(false);

			// Once another firmware is known, the documented base layout wins.
			p.mk2Model["info.device_sw_version"].value = 2612431;
			await p.master_multi_led_info();
			expect(p.mk2Model["switch.state"].value).to.equal(3);
		});

		it("does not promote a generic trailing register when firmware is unknown", async () => {
			const live = Buffer.from("0f4110000400041f00a0003200008077b0", "hex");
			const serial = new FakeMk2Serial((request) => {
				if (request[2] === 0x57 && request[3] === 0x0e) return mk2Frame(0x57, [0x94, 2, 0]);
				if (request[2] === 0x46 && request[3] === 0x05) return live;
				return null;
			});
			serial.push(versionFrame());
			const p = protocolWithSerial(serial);
			expect(p.mk2Model["info.device_sw_version"].value).to.equal(null);
			await p.get_state();
			await p.master_multi_led_info();
			// The complete frame decoded (bytes 11/12 = 0x0032 = 5.0 A), so the
			// null switch state comes from the ambiguity guard and not a lost frame.
			expect(p.mk2Model["assist.limit"].value).to.equal(5);
			expect(p.mk2Model["switch.state"].value).to.equal(null);
			expect(p.hasUnambiguousSwitchState()).to.equal(false);
		});

		it("accepts agreeing On bits after power-on before firmware identification", async () => {
			const on = Buffer.from("0f4110010000041f00a000320032007701", "hex");
			const serial = new FakeMk2Serial((request) => {
				if (request[2] === 0x57 && request[3] === 0x0e) return mk2Frame(0x57, [0x94, 2, 0]);
				if (request[2] === 0x46 && request[3] === 0x05) return on;
				return null;
			});
			serial.push(versionFrame());
			const p = protocolWithSerial(serial);
			await p.get_state();
			await p.master_multi_led_info();
			expect(p.mk2Model["switch.state"].value).to.equal(3);
			expect(p.hasUnambiguousSwitchState()).to.equal(true);
		});

		it("refuses set_assist before sending S when no switch register exists", async () => {
			const fake = new FakeMk2Connection();
			fake.masterMultiLedHasRegister = false;
			const p = protocolWith(fake);
			await p.master_multi_led_info();
			await expect(p.set_assist(5)).to.be.rejectedWith(Mk2ValidationError, "no unambiguous");
			expect(fake.requests.filter((r) => r[2] === 0x53)).to.have.length(0);
		});
	});

	describe("S limit readbacks and special 0 A (#110/#112/#119)", () => {
		it("rejects a different raw deciamp value despite a near floating-point request", async () => {
			const fake = new FakeMk2Connection();
			fake.ignoreAssistWrites = true;
			fake.limit = 4.1;
			const p = protocolWith(fake);
			p.switchReadbackTimeoutMs = 20;
			p.switchReadbackPollIntervalMs = 1;
			await p.master_multi_led_info();
			await expect(p.set_assist(4.04)).to.be.rejectedWith("readback mismatch");
			const s = fake.requests.filter((r) => r[2] === 0x53);
			expect(s).to.have.length(1);
			expect(s[0][4] | (s[0][5] << 8)).to.equal(40);
		});

		it("never accepts special 0 A for a positive request", async () => {
			const fake = new FakeMk2Connection();
			fake.ignoreAssistWrites = true;
			fake.limit = 0;
			const p = protocolWith(fake);
			p.switchReadbackTimeoutMs = 20;
			p.switchReadbackPollIntervalMs = 1;
			p.mk2Model["assist.minlimit"].value = 0;
			await p.master_multi_led_info();
			p.mk2Model["assist.minlimit"].value = 0;
			await expect(p.set_assist(0.1)).to.be.rejectedWith("readback mismatch");
		});

		it("requires a grid transition when the old 0 A minimum equals the positive request", async () => {
			const fake = new FakeMk2Connection();
			fake.zeroLimitSelectsInverter = false;
			fake.zeroLimitReportsMinimum = true;
			fake.linkMainStateToSwitch = false;
			fake.currentState = 4;
			const p = protocolWith(fake);
			p.gridModeReadbackTimeoutMs = 30;
			p.switchReadbackPollIntervalMs = 1;
			p.mk2Model["setting.flag.AssistEnabled"].value = true;
			await p.master_multi_led_info();
			await p.set_grid_mode(1);
			fake.ignoreAssistWrites = true;
			await expect(p.set_assist(3.1)).to.be.rejectedWith("main state is 4 instead of 7/8/9");
			expect(p.mk2Model["state.state"].value).to.equal(40);
		});

		it("requires grid proof for a cold special-0-A minimum collision", async () => {
			for (const directSwitch of [false, true]) {
				const fake = new FakeMk2Connection();
				fake.zeroLimitSelectsInverter = false;
				fake.zeroLimitReportsMinimum = true;
				fake.linkMainStateToSwitch = false;
				fake.ignoreAssistWrites = true;
				fake.currentState = 4;
				fake.limit = 3.1;
				const p = protocolWith(fake);
				p.gridModeReadbackTimeoutMs = 20;
				p.switchReadbackPollIntervalMs = 1;
				await p.get_state();
				await p.master_multi_led_info();
				expect(p.getConfirmedInputCurrentSetpoint()).to.equal(null);
				const write = directSwitch ? p.set_switch_state(3) : p.set_assist(3.1);
				await expect(write).to.be.rejectedWith("main state is 4 instead of 7/8/9");
			}
		});

		it("preserves a proven cold 0 A setpoint without an EEPROM-flags byte", async () => {
			const fake = new FakeMk2Connection();
			fake.deviceSwVersion = 1909209;
			fake.longSoftwareVersionResponse = true;
			fake.longSettingInfoResponse = true;
			fake.limit = 0;
			fake.switchState = 3;
			fake.switchRegister = 0x30;
			fake.currentState = 4;
			fake.linkMainStateToSwitch = false;
			fake.zeroLimitSelectsInverter = false;
			const p = protocolWith(fake);
			p.mk2Model["setting.flag.AssistEnabled"].value = true;
			await p.loadDeviceInfo();
			await p.get_state();
			await p.master_multi_led_info();
			fake.requests.length = 0;
			await p.writeSetting(0, 0x89f0);
			const mode = fake.requests.find((r) => r[2] === 0x53 && r[9] === 1)!;
			expect(mode[4] | (mode[5] << 8)).to.equal(0);
			expect(mode).to.have.length(11);
			expect(fake.limit).to.equal(0);
			expect(p.mk2Model["state.state"].value).to.equal(40);
		});

		it("refuses the preparatory S frame when the switch state is unproven", async () => {
			const fake = new FakeMk2Connection();
			fake.deviceSwVersion = 1909209;
			fake.longSoftwareVersionResponse = true;
			fake.longSettingInfoResponse = true;
			fake.masterMultiLedHasRegister = false;
			const p = protocolWith(fake);
			await p.loadDeviceInfo();
			await p.master_multi_led_info();
			await expect(p.writeSetting(0, 0x89f0)).to.be.rejectedWith("no unambiguous");
			expect(fake.requests.filter((r) => r[2] === 0x53)).to.have.length(0);
			expect(fake.writes).to.have.length(0);
		});
	});

	describe("W0E and W36 validation (#106/#107/#115)", () => {
		it("invalidates a previous device version on a new sync generation", async () => {
			const fake = new FakeMk2Connection();
			const p = protocolWith(fake);
			p.mk2Model["info.device_sw_version"].value = 1909209;
			p.mk2Model["info.device_sw_version_text"].value = "19 9 209";
			fake.generation++;
			await p.pollStateOnly();
			expect(p.mk2Model["info.device_sw_version"].value).to.equal(null);
			expect(p.mk2Model["info.device_sw_version_text"].value).to.equal(null);
		});

		it("rejects invalid state bytes without opening the stability gate", async () => {
			const fake = new FakeMk2Connection();
			fake.currentState = 0xff;
			fake.currentSubState = 0xff;
			const p = protocolWith(fake);
			await expect(p.get_state()).to.be.rejectedWith("invalid state response 255/255");
			expect(p.mk2Model["state.state"].value).to.equal(0);
			expect(isStableState(p.mk2Model["state.state"].value)).to.equal(false);
		});

		it("collects scale and offset from separate MK2 response frames", async () => {
			const serial = new FakeMk2Serial((request) => {
				if (request[2] === 0x57 && request[3] === 0x36) return [
					mk2Frame(0x57, [0x8e, 0x2f, 0x7c]),
					mk2Frame(0x57, [0x8f, 0xcd, 0]),
				];
				return null;
			});
			serial.push(versionFrame());
			const p = protocolWithSerial(serial);
			const info = await p.getRamInfo(8);
			expect(info.offset).to.equal(205);
			expect(info.supported).to.equal(true);
		});

		it("rejects supported short RAM metadata without the required offset", async () => {
			const p = protocolWith(new FakeMk2Connection());
			p.conn.communicateMulti = async (_request, decode) => {
				await decode(mk2Frame(0x57, [0x8e, 0x9c, 0x7f]));
			};
			await expect(p.getRamInfo(0)).to.be.rejectedWith("incomplete response");
			expect((p as any).ramInfoCache.has(0)).to.equal(false);
		});

		it("rejects an ambiguous short-pair/long+trailer W36 response in long mode", async () => {
			const fake = new FakeMk2Connection();
			fake.deviceSwVersion = 1909209;
			fake.longSoftwareVersionResponse = true;
			const p = protocolWith(fake);
			await p.loadDeviceInfo();
			p.conn.communicateMulti = async (_request, decode) => {
				await decode(mk2Frame(0x57, [0x8e, 0x30, 0x78, 0x8f, 0xcd, 0]));
			};
			await expect(p.getRamInfo(8)).to.be.rejectedWith("ambiguous short-pair/long+trailer");
			expect((p as any).ramInfoCache.has(8)).to.equal(false);
		});

		it("accepts unambiguous long W36 responses with trailing bytes", async () => {
			for (const test of [
				{ data: [0x8e, 0x2f, 0x7c, 0xcd, 0, 0x55], offset: 205 },
				{ data: [0x8e, 0x2f, 0x7c, 0x8f, 0, 0x11, 0x22], offset: 143 },
			]) {
				const fake = new FakeMk2Connection();
				fake.deviceSwVersion = 1909209;
				fake.longSoftwareVersionResponse = true;
				const p = protocolWith(fake);
				await p.loadDeviceInfo();
				p.conn.communicateMulti = async (_request, decode) => {
					await decode(mk2Frame(0x57, test.data));
				};
				expect((await p.getRamInfo(8)).offset).to.equal(test.offset);
			}
		});

		it("parses long RAM metadata before short triplets when offset-low is 0x8f", async () => {
			const serial = new FakeMk2Serial((request) => {
				if (request[2] === 0x57 && request[3] === 0x36) return Buffer.from("07ff578e2f7c8f00db", "hex");
				return null;
			});
			serial.push(versionFrame());
			const p = protocolWithSerial(serial);
			const info = await p.getRamInfo(8);
			expect(info.offset).to.equal(143);
			expect(info.sc).to.equal(0x7c2f);
		});
	});

	describe("RAM semantics in F0/F1 (#117)", () => {
		it("uses unsigned AC current when RAM Sc is positive", async () => {
			const serial = new FakeMk2Serial((request) => {
				if (request[2] === 0x57 && request[3] === 0x36) return mk2Frame(0x57, [0x8e, 0x9c, 0x7f, 0x8f, 0, 0]);
				if (request[2] === 0x46 && request[3] === 0x01) return veBusFrame(0x20, [
					1, 1, 0, 8, 8, 0, 0, 0, 0x80, 0, 0, 0, 0, 20,
				], 0x0f);
				return null;
			});
			serial.push(versionFrame());
			const p = protocolWithSerial(serial);
			await p.loadScalingsIfNeeded();
			await p.ac_info();
			expect(p.mk2Model["ac_info.imains"].value).to.equal(327.68);
		});

		it("applies offset before converting a zero raw inverter period", async () => {
			const fake = new FakeMk2Connection();
			fake.inverterPeriod = 0;
			const p = protocolWith(fake);
			p.calc.finv_calc = { scale: 0x7857, offset: 256, signed: true };
			await p.dc_info();
			expect(p.mk2Model["dc_info.finv"].value).to.equal(76.6);
		});
	});

	describe("setting-write gates and no-op reconciliation (#111/#114/#116)", () => {
		it("does not write a scaled setting after a 0x91 pre-read", async () => {
			for (const id of [2, 4]) {
				const fake = new FakeMk2Connection();
				fake.unreadableSettings.add(id);
				const p = protocolWith(fake);
				const write = id === 2 ? p.set_UBatAbsorption(14.3) : p.set_setting_IBatBulk(100);
				await expect(write).to.be.rejectedWith(Mk2ValidationError, "0x91");
				expect(fake.writes).to.have.length(0);
			}
		});

		it("treats an explicit 0x80 setting rejection as permanent", async () => {
			const fake = new FakeMk2Connection();
			fake.rejectLegacyWritesInLongMode = true;
			const p = protocolWith(fake);
			const queue: QueueItem[] = [{ name: "control.UBatAbsorption", value: 14.3, attempts: 0 }];
			const result = await processControlWritesDetailed(p, queue, log);
			expect(result.dropped).to.have.length(1);
			expect(fake.requests.filter((r) => r[2] === 0x57 && r[3] === 0x33)).to.have.length(1);
			expect(p.mk2Model["diag.last_control_error"].value).to.contain("0x80");
		});

		it("refreshes a same-value PowerAssist flag without an EEPROM write", async () => {
			const fake = new FakeMk2Connection();
			const p = protocolWith(fake);
			p.mk2Model["setting.flag.AssistEnabled"].value = null;
			await p.set_flagAssistEnabled(1);
			expect(fake.writes).to.have.length(0);
			expect(p.mk2Model["setting.flag.AssistEnabled"].value).to.equal(true);
			await p.master_multi_led_info();
			await p.set_assist(0);
			expect(fake.limit).to.equal(0);
		});

		it("returns the actual scaled IBatBulk value on a no-op write", async () => {
			const fake = new FakeMk2Connection();
			fake.settingInfoOverrides.set(4, { sc: 3, offset: 0, def: 0, min: 0, max: 120 });
			fake.ibatBulk = 1;
			const p = protocolWith(fake);
			expect(await p.set_setting_IBatBulk(4)).to.equal(3);
			expect(p.mk2Model["setting.IBatBulk"].value).to.equal(3);
			expect(fake.writes).to.have.length(0);
		});
	});
});
