import { expect } from "chai";
import { Mk2Protocol } from "./mk2Protocol";
import { switchStateFromRegister } from "./mk2Switch";
import { asConnection, FakeMk2Connection, FakeMk2Serial, mk2Frame, versionFrame } from "../test-utils/fake-mk2";
import { Mk2Connection } from "./mk2Connection";

function makeLog() {
	const infos: string[] = [];
	return {
		infos,
		logger: {
			level: "info",
			debug: () => undefined,
			info: (msg: string) => infos.push(msg),
			warn: () => undefined,
			error: () => undefined,
		} as any,
	};
}

function protocolWith(fake: FakeMk2Connection, logger?: any): Mk2Protocol {
	return new Mk2Protocol("fake", logger ?? makeLog().logger, asConnection(fake));
}

describe("switch state derivation (issue #7)", () => {
	it("maps the switch register bits to the panel state", () => {
		expect(switchStateFromRegister(0b00110000)).to.equal(3); // On
		expect(switchStateFromRegister(0b00010000)).to.equal(1); // Charger only
		expect(switchStateFromRegister(0b00100000)).to.equal(2); // Inverter only
		expect(switchStateFromRegister(0)).to.equal(4); // Off
	});

	it("adopts the device switch state and exposes it as switch.state", async () => {
		const fake = new FakeMk2Connection();
		fake.switchRegister = 0b00010000; // charger only
		const p = protocolWith(fake);
		await p.master_multi_led_info();
		expect(p.currentSwitchState).to.equal(1);
		expect(p.mk2Model["switch.state"].value).to.equal(1);
		await p.set_assist(5);
		expect(fake.switchState).to.equal(1);
	});

	it("logs when the device switch state differs from the local assumption", async () => {
		const fake = new FakeMk2Connection();
		fake.switchRegister = 0b00100000; // inverter only
		const log = makeLog();
		const p = protocolWith(fake, log.logger);
		await p.master_multi_led_info();
		expect(log.infos.some((m) => m.includes("switch state changed"))).to.equal(true);
	});

	it("refuses to switch a device on implicitly when it is Off", async () => {
		const fake = new FakeMk2Connection();
		fake.switchRegister = 0;
		const p = protocolWith(fake);
		await p.master_multi_led_info();
		expect(p.currentSwitchState).to.equal(4);
		await expect(p.set_assist(5)).to.be.rejectedWith("Off");
		expect(fake.switchState).to.equal(3); // nothing was written
	});

	it("does not derive a switch state when the frame has no register (issue #38)", async () => {
		const fake = new FakeMk2Connection();
		fake.masterMultiLedHasRegister = false;
		const p = protocolWith(fake);
		await p.set_switch_state(2);
		await p.master_multi_led_info();
		expect(p.currentSwitchState).to.equal(2); // unchanged, not from the checksum
		expect(p.mk2Model["switch.state"].value).to.equal(null);
		expect(p.mk2Model["switch.SwitchInvert"].value).to.equal(null);
	});

	it("uses the register when it is present", async () => {
		const fake = new FakeMk2Connection();
		fake.switchRegister = 0b00010000;
		const p = protocolWith(fake);
		await p.master_multi_led_info();
		expect(p.mk2Model["switch.state"].value).to.equal(1);
	});

	it("keeps the cached switch state when the write fails (issue #47)", async () => {
		const fake = new FakeMk2Connection();
		fake.failNext = "ff53"; // the S command fails at the transport level
		const p = protocolWith(fake);
		await expect(p.set_switch_state(2)).to.be.rejected;
		expect(p.currentSwitchState).to.equal(3);
		expect(p.mk2Model["switch.state"].value).to.equal(3);
	});
});

describe("connection diagnostics (issue #8)", () => {
	it("marks the connection as established after a successful poll", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		await p.poll();
		expect(p.mk2Model["info.connection"].value).to.equal(true);
	});

	it("marks the connection as lost when the poll fails", async () => {
		const fake = new FakeMk2Connection();
		fake.failNext = "02ff4cb3"; // the L (LED status) request
		const p = protocolWith(fake);
		await p.poll();
		expect(p.mk2Model["info.connection"].value).to.equal(false);
	});

	it("mirrors the connection error counters into the model", async () => {
		const fake = new FakeMk2Connection();
		fake.timeouts = 3;
		fake.checksumErrors = 1;
		fake.lastError = "MK2 frame checksum error";
		const p = protocolWith(fake);
		await p.poll();
		expect(p.mk2Model["diag.timeouts"].value).to.equal(3);
		expect(p.mk2Model["diag.checksum_errors"].value).to.equal(1);
		expect(p.mk2Model["diag.last_error"].value).to.equal("MK2 frame checksum error");
	});

	it("propagates a transport failure inside an optional block (issue #16)", async () => {
		const fake = new FakeMk2Connection();
		// the RAM info request for the internal SOC fails at the transport level
		fake.failNext = "05ff57360d0062";
		const p = protocolWith(fake);
		await p.poll();
		expect(p.mk2Model["info.connection"].value).to.equal(false);
	});
});

describe("error message quality (issue #61)", () => {
	it("logs the decoder message instead of [object Object]", async () => {
		const fake = new FakeMk2Connection();
		fake.dcPhase = 0x00; // invalid DC phase marker -> the decoder rejects the frame
		const errors: string[] = [];
		const logger = {
			level: "info",
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: (m: string) => errors.push(m),
		} as any;
		const p = new Mk2Protocol("fake", logger, asConnection(fake));
		await p.poll();
		expect(errors.some((m) => m.includes("no dc_info frame"))).to.equal(true);
		expect(errors.some((m) => m.includes("[object Object]"))).to.equal(false);
	});
});

describe("failure-path diagnostics and extended settings (issue #82)", () => {
	it("mirrors diagnostics even when the state-only poll fails", async () => {
		const fake = new FakeMk2Connection();
		fake.failNext = "04ff410100bb";
		fake.protocolErrors = 2;
		fake.syncErrors = 3;
		const p = protocolWith(fake);

		await expect(p.pollStateOnly()).to.be.rejectedWith("simulated communication failure");
		expect(p.mk2Model["diag.protocol_errors"].value).to.equal(2);
		expect(p.mk2Model["diag.sync_errors"].value).to.equal(3);
	});

	it("aborts the full poll on an extended-setting transport failure", async () => {
		const fake = new FakeMk2Connection();
		const p = protocolWith(fake);
		const firstExtendedInfoRequest = p.create_frame("W", Buffer.from([0x35, 2, 0])).toString("hex");
		fake.failNext = firstExtendedInfoRequest;

		await p.poll();

		expect(p.mk2Model["info.connection"].value).to.equal(false);
		expect(fake.requests.at(-1)?.toString("hex")).to.equal(firstExtendedInfoRequest);
	});

	it("stops extended settings after a partial response and bad checksum (issue #92)", async () => {
		const first = mk2Frame(0x57, [0x89, 0x9c, 0x7f]);
		const broken = mk2Frame(0x57, [0x8a, 0x00, 0x00]);
		broken[broken.length - 1] ^= 0xff;
		const serial = new FakeMk2Serial(() => [first, broken]);
		serial.push(versionFrame());
		const conn = new Mk2Connection("fake", makeLog().logger, serial as any);
		const p = new Mk2Protocol("fake", makeLog().logger, conn);

		await expect(p.loadExtendedSettings()).to.be.rejectedWith("checksum");
		expect(serial.written).to.have.length(1);
		expect(serial.openCount).to.equal(1);
		expect(conn.synced).to.equal(false);
		expect(conn.checksumErrors).to.equal(1);
	});
});
