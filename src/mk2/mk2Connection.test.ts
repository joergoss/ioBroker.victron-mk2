import { expect } from "chai";
import { Mk2Connection } from "./mk2Connection";
import { Mk2Protocol } from "./mk2Protocol";
import { Mk2TransportError } from "../lib/errors";
import { FakeMk2Serial, mk2Frame, versionFrame } from "../test-utils/fake-mk2";

const log = {
	level: "info",
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

function connWith(fake: FakeMk2Serial): Mk2Connection {
	return new Mk2Connection("fake", log as any, fake as any);
}

describe("Mk2Connection", () => {
	it("uses the 5000 ms response budget by default (issue #79)", () => {
		const conn = connWith(new FakeMk2Serial());
		expect(conn.responseTimeoutMs).to.equal(5000);
	});

	describe("receiveFrame", () => {
		it("reads a complete length-prefixed frame", async () => {
			const fake = new FakeMk2Serial();
			const frame = versionFrame();
			fake.push(frame);
			const conn = connWith(fake);
			const result = await conn.receiveFrame();
			expect(result.equals(frame)).to.equal(true);
		});

		it("accumulates partial reads until the frame is complete", async () => {
			const fake = new FakeMk2Serial();
			fake.splitResponses = true;
			const frame = versionFrame();
			for (let i = 0; i < frame.length; i += 2) {
				fake.push(frame.slice(i, i + 2));
			}
			const conn = connWith(fake);
			const result = await conn.receiveFrame();
			expect(result.equals(frame)).to.equal(true);
		});

		it("rejects a frame with a wrong checksum", async () => {
			const fake = new FakeMk2Serial();
			const frame = versionFrame();
			frame[frame.length - 1] ^= 0xFF;
			fake.push(frame);
			const conn = connWith(fake);
			await expect(conn.receiveFrame()).to.be.rejectedWith("checksum");
		});

		it("times out when no data arrives", async () => {
			const fake = new FakeMk2Serial();
			const conn = connWith(fake);
			await expect(conn.receiveFrame(40)).to.be.rejectedWith("Timeout");
		});
	});

	describe("sync", () => {
		it("captures the MK2 version and mode from the version frame", async () => {
			const fake = new FakeMk2Serial();
			fake.push(versionFrame());
			const conn = connWith(fake);
			await conn.sync();
			expect(conn.synced).to.equal(true);
			expect(conn.mk2Version).to.equal(0x00113e98);
			expect(conn.mk2Mode).to.equal(0x00);
		});
	});

	describe("failure recovery (issue #8)", () => {
		it("counts checksum errors, closes the port and invalidates the sync", async () => {
			const frame = versionFrame();
			frame[frame.length - 1] ^= 0xFF;
			const fake = new FakeMk2Serial();
			fake.push(frame);
			await fake.open();
			const conn = connWith(fake);
			await expect(conn.receiveFrame(100)).to.be.rejectedWith("checksum");
			expect(conn.checksumErrors).to.equal(1);
			expect(conn.synced).to.equal(false);
			expect(fake.isOpen()).to.equal(false);
			expect(conn.lastError).to.contain("checksum");
		});

		it("counts timeouts and resynchronises on the next call", async () => {
			const fake = new FakeMk2Serial();
			await fake.open();
			const conn = connWith(fake);
			await expect(conn.receiveFrame(40)).to.be.rejectedWith("Timeout");
			expect(conn.timeouts).to.equal(1);
			expect(fake.isOpen()).to.equal(false);
			expect(conn.lastError).to.contain("Timeout");

			fake.push(versionFrame());
			await conn.ensureSynced();
			expect(fake.isOpen()).to.equal(true);
			expect(conn.synced).to.equal(true);
		});

		it("classifies a missing response as a transport error (issue #40)", async () => {
			const fake = new FakeMk2Serial(); // never answers
			fake.push(versionFrame());
			const conn = connWith(fake);
			await expect(conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async () => undefined, { readTimeoutMs: 30 }))
				.to.be.rejectedWith(Mk2TransportError);
			// and the failure is visible in the diagnostics, not only as a throw (#68)
			expect(conn.timeouts).to.equal(1);
			expect(conn.lastError).to.contain("Timeout");
			expect(fake.isOpen()).to.equal(false);
		});

		it("invalidates the connection on an asynchronous serial error", async () => {
			const fake = new FakeMk2Serial();
			fake.push(versionFrame());
			await fake.open();
			const conn = connWith(fake);
			await conn.sync();
			expect(conn.synced).to.equal(true);

			fake.emitError(new Error("EIO: USB device disconnected"));
			expect(conn.synced).to.equal(false);
			expect(conn.protocolErrors).to.equal(1);
			expect(conn.lastError).to.contain("serial error: EIO");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(fake.isOpen()).to.equal(false);
		});
	});

	describe("sync robustness", () => {
		it("synchronises when the stream starts with garbage", async () => {
			const fake = new FakeMk2Serial();
			fake.push(Buffer.from([0x00, 0x13, 0x77]));
			fake.push(versionFrame());
			const conn = connWith(fake);
			await conn.sync();
			expect(conn.synced).to.equal(true);
			expect(conn.mk2Version).to.equal(0x00113e98);
		});

		it("synchronises when the version frame arrives byte by byte", async () => {
			const fake = new FakeMk2Serial();
			for (const b of versionFrame()) {
				fake.push(Buffer.from([b]));
			}
			const conn = connWith(fake);
			await conn.sync();
			expect(conn.synced).to.equal(true);
		});

		it("ignores a version-looking sequence with a broken checksum", async () => {
			const fake = new FakeMk2Serial();
			const bad = versionFrame();
			bad[bad.length - 1] ^= 0xFF;
			fake.push(bad);
			fake.push(versionFrame());
			const conn = connWith(fake);
			await conn.sync();
			expect(conn.synced).to.equal(true);
			expect(conn.mk2Version).to.equal(0x00113e98);
		});

		it("keeps frames that arrive after the version frame", async () => {
			const fake = new FakeMk2Serial();
			fake.push(versionFrame());
			fake.push(mk2Frame(0x41, [0x01, 0x00]));
			const conn = connWith(fake);
			await conn.sync();
			const next = await conn.receiveFrame(200);
			expect(next[2]).to.equal(0x41);
		});

		it("finds a valid frame behind an incomplete false candidate (issue #20)", async () => {			const fake = new FakeMk2Serial();
			// 7f ff 56 looks like a long version frame but is incomplete; the real
			// version frame follows immediately in the same buffer.
			fake.push(Buffer.from([0x7f, 0xff, 0x56]));
			fake.push(versionFrame());
			const conn = connWith(fake);
			await conn.sync();
			expect(conn.synced).to.equal(true);
			expect(conn.mk2Version).to.equal(0x00113e98);
		});
	});

	describe("communicate", () => {		it("decodes a valid response and records the request", async () => {
			const response = mk2Frame(0x41, [0x01, 0x00]);
			const fake = new FakeMk2Serial(() => response);
			fake.push(versionFrame());
			const conn = connWith(fake);
			let decoded: Buffer | undefined;
			await conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async (frame) => {
				decoded = frame;
			});
			expect(decoded?.equals(response)).to.equal(true);
			expect(fake.written).to.have.length(1);
		});

		it("ignores a version frame while waiting for the real response", async () => {
			const response = mk2Frame(0x41, [0x01, 0x00]);
			const fake = new FakeMk2Serial(() => [versionFrame(), response]);
			fake.push(versionFrame());
			const conn = connWith(fake);
			let decoded: Buffer | undefined;
			await conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async (frame) => {
				decoded = frame;
			});
			expect(decoded?.equals(response)).to.equal(true);
		});

		it("propagates a timeout when the device does not answer", async () => {
			const fake = new FakeMk2Serial(() => null);
			fake.push(versionFrame());
			const conn = connWith(fake);
			conn.responseTimeoutMs = 40; // keep this failure-path test independent of the production default
			await expect(
				conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async () => undefined),
			).to.be.rejectedWith("Timeout");
		});

		it("propagates a checksum error", async () => {
			const response = mk2Frame(0x41, [0x01, 0x00]);
			response[response.length - 1] ^= 0xFF;
			const fake = new FakeMk2Serial(() => response);
			fake.push(versionFrame());
			const conn = connWith(fake);
			await expect(
				conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async () => undefined),
			).to.be.rejectedWith("checksum");
		});

		it("propagates a decode exception", async () => {
			const response = mk2Frame(0x41, [0x01, 0x00]);
			const fake = new FakeMk2Serial(() => response);
			fake.push(versionFrame());
			const conn = connWith(fake);
			await expect(
				conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async () => {
					throw new Error("decode failed");
				}),
			).to.be.rejectedWith("decode failed");
		});
	});

	describe("sync/ensureSynced", () => {
		it("syncs on a version frame and only once per connection", async () => {
			const fake = new FakeMk2Serial();
			fake.push(versionFrame());
			const conn = connWith(fake);
			await conn.ensureSynced();
			expect(conn.synced).to.equal(true);
			expect(fake.isOpen()).to.equal(true);
			// a second call must not need another frame
			await conn.ensureSynced();
			expect(conn.synced).to.equal(true);
		});

		it("resynchronises after the port was closed", async () => {
			const fake = new FakeMk2Serial();
			fake.push(versionFrame());
			const conn = connWith(fake);
			await conn.ensureSynced();
			await fake.close();
			fake.push(versionFrame());
			await conn.ensureSynced();
			expect(conn.synced).to.equal(true);
		});
	});
});

describe("concurrency (issue #23)", () => {
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it("serialises concurrent exchanges instead of interleaving them", async () => {
		const response = mk2Frame(0x41, [0x01, 0x00]);
		const fake = new FakeMk2Serial(() => response);
		fake.push(versionFrame());
		const conn = new Mk2Connection("fake", log as any, fake as any);
		const order: string[] = [];

		await Promise.all([
			conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async () => {
				order.push("a-start");
				await sleep(60);
				order.push("a-end");
			}),
			conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async () => {
				order.push("b-start");
				await sleep(1);
				order.push("b-end");
			}),
		]);
		expect(order).to.deep.equal(["a-start", "a-end", "b-start", "b-end"]);
	});

	it("honours a responseTimeout above the former fixed deadline (issue #48)", async function () {
		this.timeout(10000);
		const response = mk2Frame(0x41, [0x01, 0x00]);
		const fake = new FakeMk2Serial(() => response);
		fake.responseDelayMs = 2100; // longer than the old fixed 2000 ms deadline
		fake.push(versionFrame());
		const conn = new Mk2Connection("fake", log as any, fake as any);
		conn.responseTimeoutMs = 3000;
		await conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async () => undefined);
		expect(conn.timeouts).to.equal(0);
	});
});

describe("sync split robustness (issue #56)", () => {
	it("synchronises with a split at every byte offset", async () => {
		for (let split = 1; split < 9; split++) {
			const fake = new FakeMk2Serial();
			const frame = versionFrame();
			fake.push(frame.slice(0, split));
			const conn = connWith(fake);
			const pending = conn.sync();
			// let the scanner see the partial frame before the rest arrives
			await new Promise((resolve) => setTimeout(resolve, 25));
			fake.push(frame.slice(split));
			await pending;
			expect(conn.synced, `split at byte ${split}`).to.equal(true);
		}
	});
});

describe("shutdown (issue #59)", () => {
	it("does not reopen the port after shutdown", async () => {
		const fake = new FakeMk2Serial();
		fake.push(versionFrame());
		const conn = connWith(fake);
		await conn.ensureSynced();
		expect(conn.synced).to.equal(true);
		await conn.shutdown();
		expect(fake.isOpen()).to.equal(false);
		await expect(conn.ensureSynced()).to.be.rejectedWith("shut down");
		expect(fake.isOpen()).to.equal(false);
	});
});

describe("diagnostic counters (issues #65, #66)", () => {
	it("counts a failed sync and records the error", async function () {
		this.timeout(10000);
		const fake = new FakeMk2Serial(); // no version frame ever
		const conn = connWith(fake);
		await expect(conn.sync()).to.be.rejectedWith("no version frame");
		expect(conn.syncErrors).to.equal(1);
		expect(conn.lastError).to.contain("no version frame");
		expect(fake.isOpen()).to.equal(false);
	});

	it("counts protocol errors such as an invalid frame length", async () => {
		const fake = new FakeMk2Serial();
		fake.push(Buffer.from([0x00, 0x00, 0x00]));
		const conn = connWith(fake);
		await expect(conn.receiveFrame(100)).to.be.rejectedWith("length 0");
		expect(conn.protocolErrors).to.equal(1);
	});
});

describe("appended LED status (issue #67)", () => {
	it("does not decode the appended LED block as the next response", async () => {
		const main = mk2Frame(0x41, [0x01, 0x00]);
		main[0] |= 0x80; // LED status appended (length bit 7)
		main[main.length - 1] = 0;
		let sum = 0;
		for (const b of main) sum += b;
		main[main.length - 1] = (256 - (sum % 256)) & 0xFF;

		const fake = new FakeMk2Serial();
		fake.push(Buffer.concat([main, Buffer.from([0x4c, 0x01, 0x00]), mk2Frame(0x41, [0x01, 0x00])]));
		const conn = connWith(fake);
		const first = await conn.receiveFrame(200);
		expect(first[2]).to.equal(0x41);
		const second = await conn.receiveFrame(200);
		expect(second[2]).to.equal(0x41); // the LED block must not be a response
	});
});

describe("transport error boundaries (issues #89, #91, #92)", () => {
	it("normalizes write failures and invalidates the connection (issue #89)", async () => {
		const fake = new FakeMk2Serial();
		fake.push(versionFrame());
		fake.writeError = new Error("write callback failed");
		const conn = connWith(fake);
		let caught: unknown;
		try {
			await conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async () => undefined);
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(Mk2TransportError);
		expect((caught as Error).message).to.contain("write callback failed");
		expect(conn.synced).to.equal(false);
		expect(conn.protocolErrors).to.equal(1);
		expect(conn.lastError).to.contain("write callback failed");
		expect(fake.isOpen()).to.equal(false);
	});

	it("normalizes serial open failures (issue #89)", async () => {
		const fake = new FakeMk2Serial();
		fake.openError = new Error("open callback failed");
		const conn = connWith(fake);
		let caught: unknown;
		try {
			await conn.communicate(mk2Frame(0x41, [0x01, 0x00]), async () => undefined);
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(Mk2TransportError);
		expect((caught as Error).message).to.contain("open callback failed");
		expect(conn.synced).to.equal(false);
		expect(conn.protocolErrors).to.equal(1);
		expect(conn.lastError).to.contain("open callback failed");
	});

	it("normalizes the first open through ensureSynced (issue #89)", async () => {
		const fake = new FakeMk2Serial();
		fake.openError = new Error("device missing");
		const conn = connWith(fake);
		let caught: unknown;
		try {
			await conn.ensureSynced();
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(Mk2TransportError);
		expect((caught as Error).message).to.contain("device missing");
		expect(conn.synced).to.equal(false);
		expect(conn.protocolErrors).to.equal(1);
		expect(conn.lastError).to.contain("device missing");
		expect(fake.isOpen()).to.equal(false);
	});

	it("publishes open-failure diagnostics from pollStateOnly (issue #89)", async () => {
		const fake = new FakeMk2Serial();
		fake.openError = new Error("device missing");
		const conn = connWith(fake);
		const protocol = new Mk2Protocol("fake", log as any, conn);
		let caught: unknown;
		try {
			await protocol.pollStateOnly();
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(Mk2TransportError);
		expect(protocol.mk2Model["diag.last_error"].value).to.contain("device missing");
		expect(protocol.mk2Model["diag.protocol_errors"].value).to.equal(1);
		expect(protocol.mk2Model["diag.sync_errors"].value).to.equal(0);
	});

	it("does not turn a partial multi-frame timeout into a quiet end (issue #92)", async () => {
		const firstFragment = mk2Frame(0x57, [0x89, 0x9c, 0x7f]);
		const fake = new FakeMk2Serial((request) => request[2] === 0x57 ? firstFragment : null);
		fake.push(versionFrame());
		const conn = connWith(fake);
		await expect(conn.communicateMulti(
			mk2Frame(0x57, [0x35, 2, 0]),
			async () => false,
			{ allowQuietEnd: true, readTimeoutMs: 40 },
		)).to.be.rejectedWith("Timeout");
		expect(conn.synced).to.equal(false);
		expect(conn.timeouts).to.equal(1);
	});

	it("rejects a full-length version frame in VE 9-bit mode (issue #91)", async function () {
		this.timeout(7000);
		const fake = new FakeMk2Serial();
		fake.push(mk2Frame(0x56, [0x98, 0x3e, 0x11, 0x00, 0x57]));
		const conn = connWith(fake);
		await expect(conn.sync()).to.be.rejectedWith("VE 9-bit");
		expect(conn.synced).to.equal(false);
		expect(conn.syncErrors).to.equal(1);
	});

	it("rejects a version frame shorter than version plus mode (issue #91)", async function () {
		this.timeout(7000);
		const fake = new FakeMk2Serial();
		fake.push(mk2Frame(0x56, [0x98, 0x3e, 0x11]));
		const conn = connWith(fake);
		await expect(conn.sync()).to.be.rejectedWith("no version frame");
		expect(conn.synced).to.equal(false);
		expect(conn.syncErrors).to.equal(1);
	});

	it("does not reuse a VE 9-bit diagnostic for a later failed attempt (issue #91)", async function () {
		this.timeout(15000);
		const fake = new FakeMk2Serial();
		fake.push(mk2Frame(0x56, [0x98, 0x3e, 0x11, 0x00, 0x57]));
		const conn = connWith(fake);
		await expect(conn.sync()).to.be.rejectedWith("VE 9-bit");
		// The device is back on VE.Bus (or gone): no version frame arrives at all.
		await expect(conn.sync()).to.be.rejectedWith("no version frame");
		expect(conn.lastError).to.contain("no version frame");
		expect(conn.lastError).to.not.contain("VE 9-bit");
		expect(conn.syncErrors).to.equal(2);
	});
});
