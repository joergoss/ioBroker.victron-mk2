import { Mk2Serial } from "./serialWrapper";
import { Mk2TransportError } from "../lib/errors";

import * as util from "util";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export enum mk2SpezialFrame {
	normal = 0xFF,
	infox20 = 0x20,
	infox21 = 0x21,
	masterMultiLed = 0x41,
	ramReadOk = 0x85,
}

/**
 * Robust MK2 serial connection.
 *
 * The previous implementation relied on fixed sleeps and unbounded reads. This
 * version reads length-prefixed frames, validates checksums, applies timeouts
 * and propagates communication errors to the caller instead of silently
 * swallowing them.
 */
export class Mk2Connection {
	portPath: string;
	port: Mk2Serial;
	debug = false;
	busy = false;
	synced = false;
	log: ioBroker.Logger;
	/** MK2 firmware version and mode byte from the last version frame (§3.4). */
	mk2Version: number | null = null;
	mk2Mode: number | null = null;
	/** Diagnostics (issue #8), counted since the adapter started. */
	timeouts = 0;
	checksumErrors = 0;
	protocolErrors = 0;
	syncErrors = 0;
	lastError = "";
	/** Incremented on every successful sync, so clients can drop stale caches. */
	generation = 0;
	/**
	 * Response budget per frame. Protocol §3.3 recommends 500 ms, but long MK2
	 * frames and a busy host (ioBroker on a Raspberry Pi) need more headroom.
	 * 5000 ms has proven reliable on firmware 1909209. F5 uses the same budget
	 * with a 2000 ms minimum.
	 */
	responseTimeoutMs = 5000;
	/** Receive accumulator; bytes after a complete frame stay for the next read. */
	private rxBuffer = Buffer.alloc(0);

	/** Set when the current sync attempt rejected a mode-0x57 version frame. */
	private ve9BitModeSeen = false;

	private closedDown = false;

	constructor(portPath: string, log: ioBroker.Logger, port?: Mk2Serial) {
		this.portPath = portPath;
		this.log = log;
		this.debug = this.log?.level == "debug";
		this.port = port ?? new Mk2Serial(portPath, log);
		this.port.onError = (err) => this.handleSerialError(err);
	}

	async waitForFreeLine(): Promise<void> {
		while (this.busy) {
			await sleep(30);
		}
	}

	/** Serialises every exchange; the tail continues even after a failure. */
	private queueTail: Promise<unknown> = Promise.resolve();

	/** Open the port and synchronise once; resynchronise after a reconnect. */
	async ensureSynced(): Promise<void> {
		if (this.closedDown) {
			// After shutdown an in-flight iteration must not reopen the port (N3).
			throw new Mk2TransportError("connection is shut down");
		}
		try {
			if (!this.port.isOpen()) {
				this.synced = false;
				await this.port.open();
			}
			if (!this.synced) {
				await this.sync();
			}
		} catch (error) {
			return await this.failIo("serial open/sync", error);
		}
	}

	/** Permanently close the connection; a later ensureSynced() rejects. */
	async shutdown(): Promise<void> {
		this.closedDown = true;
		this.synced = false;
		try {
			await this.port.close();
		} catch {
			// best effort
		}
	}

	/**
	 * Synchronise on the MK2 version frame.
	 *
	 * When the port is opened in the middle of a transmission, the byte stream
	 * does not start at a frame boundary. Instead of trusting the first length
	 * byte (which used to produce a startup timeout on every adapter start), scan
	 * the stream for a complete, checksum-valid version frame and keep the
	 * remaining bytes for the next read.
	 */
	async sync(): Promise<void> {
		try {
			this.ve9BitModeSeen = false;
			if (!this.port.isOpen()) {
				await this.port.open();
			}
			await this.discardInput();

			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				// read() without a size returns everything buffered. A sized read would
				// return null until that many bytes are available, which would stall
				// the synchronisation forever on a 9-byte version frame.
				const chunk = this.port.readAvailable();
				if (chunk) {
					this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
				}
				if (this.extractVersionFrame()) {
					this.synced = true;
					this.generation++;
					this.log.debug("sync: version frame received");
					return;
				}
				await sleep(20);
			}
			this.synced = false;
			// A failed sync is a transport failure and must be visible in diag.* (N10).
			const message = this.ve9BitModeSeen
				? "MK2 reports VE 9-bit mode instead of VE.Bus"
				: "Sync - receive no version frame - no mk2 connected ?";
			await this.fail("sync", message);
		} catch (error) {
			return await this.failIo("serial sync", error);
		}
	}

	/** Find a complete, checksum-valid 'V' frame anywhere in the rx buffer. */
	private extractVersionFrame(): boolean {
		const buf = this.rxBuffer;
		let incompleteAt: number | null = null;
		for (let i = 0; i + 2 < buf.length; i++) {
			if (buf[i + 1] !== 0xff || buf[i + 2] !== 0x56) {
				continue;
			}
			const len = buf[i] & 0x7f;
			if (len < 7) {
				// §3.4 requires V + four version bytes + mode. Shorter frames are
				// malformed and must never be accepted as synchronized (#91).
				continue;
			}
			const total = len + 2;
			if (i + total > buf.length) {
				// Incomplete candidate: remember it, but keep scanning - a complete
				// valid frame may already follow later in the buffer (review T10).
				if (incompleteAt === null) {
					incompleteAt = i;
				}
				continue;
			}
			const frame = buf.slice(i, i + total);
			if (!this.checksum(frame)) {
				continue; // false positive inside other data, keep scanning
			}
			// 'V' <Version0..3> <Mode> (§3.4)
			this.mk2Version = (frame[3] | (frame[4] << 8) | (frame[5] << 16) | (frame[6] << 24)) >>> 0;
			this.mk2Mode = frame[7];
			this.rxBuffer = buf.slice(i + total);
			if (this.mk2Mode === 0x57) {
				// Mode W is VE 9-bit RS485, not VE.Bus. Keep scanning for a valid
				// later VE.Bus frame, but never declare operational sync here.
				this.ve9BitModeSeen = true;
				this.log.warn("MK2 reports VE 9-bit mode; VE.Bus sync required");
				continue;
			}
			return true;
		}
		if (incompleteAt !== null) {
			// Keep an incomplete candidate for the next read; drop the rest.
			this.rxBuffer = buf.slice(incompleteAt);
		} else {
			// Keep a possible frame start (length + marker + command = 3 bytes),
			// not just two bytes - otherwise a split after the third byte loses
			// the length byte and the sync never succeeds (review N9).
			this.rxBuffer = buf.slice(Math.max(0, buf.length - 3));
		}
		return false;
	}

	/** Drop stale input, both in the driver buffer and in our own accumulator. */
	private async discardInput(): Promise<void> {
		this.rxBuffer = Buffer.alloc(0);
		await this.port.flush_Workaround();
	}

	/**
	 * Send a request and decode one valid response frame.
	 *
	 * Version frames and unknown frames are ignored until the response or a
	 * timeout arrives. Errors (timeout, checksum, decode) are propagated to the
	 * caller so that failed writes never look successful.
	 */
	async communicate(request: Buffer, decode: (response: Buffer) => Promise<void>, options: { readTimeoutMs?: number } = {}): Promise<void> {
		return this.communicateMulti(request, async (response: Buffer) => {
			await decode(response);
			return true;
		}, options);
	}

	/**
	 * Send a request and decode as many response frames as the device sends.
	 *
	 * The MK2 packs up to three 3-byte Winmon frames into one MK2 frame, so a
	 * command like CommandGetSettingInfo (five responses) arrives as several MK2
	 * frames. `decode` returns true once the answer is complete. Transport
	 * failures always propagate, including after a partial response (issue #92).
	 */
	async communicateMulti(
		request: Buffer,
		decode: (response: Buffer) => Promise<boolean>,
		options: { readTimeoutMs?: number } = {},
	): Promise<void> {
		// A busy flag plus an await is not a mutex (review T13). Queue every
		// exchange on a promise tail instead: concurrent callers are strictly
		// serialised and a failure does not break the chain.
		const run = this.queueTail.then(() => this.performExchange(request, decode, options));
		this.queueTail = run.catch(() => undefined);
		return run;
	}

	private async performExchange(
		request: Buffer,
		decode: (response: Buffer) => Promise<boolean>,
		options: { readTimeoutMs?: number } = {},
	): Promise<void> {
		this.busy = true;

		try {
			try {
				await this.ensureSynced();
				await this.discardInput();
				this.frame_debug("SEND ->", request);
				await this.port.write(request);
			} catch (error) {
				return await this.failIo("serial setup/write", error);
			}

			const deadline = Date.now() + Math.max(2000, 2 * this.responseTimeoutMs);
			while (Date.now() < deadline) {
				let frame: Buffer;
				try {
					frame = await this.receiveFrame(options.readTimeoutMs ?? this.responseTimeoutMs);
				} catch (error) {
					// A transport error after a partial response is never a legitimate
					// quiet end. Propagate it and keep the failed-poll I/O boundary (#92).
					return await this.failIo("serial read", error);
				}
				const spezial = frame[1] as number;
				const frameType = frame[2] as number;

				// The MK2 may send a version frame while responding; it is not a
				// protocol error and must not abort the whole poll.
				if (spezial == mk2SpezialFrame.normal && frameType == 0x56) {
					this.log.debug("VERSION FRAME ignored while waiting for response");
					continue;
				}

				if (
					spezial == mk2SpezialFrame.normal ||
					spezial == mk2SpezialFrame.infox20 ||
					spezial == mk2SpezialFrame.infox21 ||
					spezial == mk2SpezialFrame.masterMultiLed ||
					spezial == mk2SpezialFrame.ramReadOk
				) {
					if (await decode(frame)) {
						return;
					}
				}
			}
			await this.fail("timeout", "Timeout waiting for response from MK2");
			throw new Error("unreachable");
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Read one complete length-prefixed frame, with timeout and checksum
	 * validation. Partial reads are accumulated until the whole frame arrived.
	 * The default follows the configured response budget (protocol §3.3 names
	 * 500 ms; a busy host may need more). Callers may provide a different
	 * per-request budget.
	 */
	async receiveFrame(timeoutMs = this.responseTimeoutMs): Promise<Buffer> {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (this.rxBuffer.length == 0) {
				const lengthByte = this.port.read(1);
				if (lengthByte) {
					this.rxBuffer = Buffer.concat([this.rxBuffer, lengthByte]);
				} else {
					await sleep(5);
					continue;
				}
			}

			// Bit 7 of the length byte means an LED status frame is appended;
			// it must not be counted as part of the frame length.
			const len = this.rxBuffer[0] & 0x7F;
			const ledAppended = (this.rxBuffer[0] & 0x80) !== 0;
			if (len == 0) {
				await this.fail("protocol", "Invalid MK2 frame length 0");
			}
			// Length excludes the length and checksum bytes, so the complete
			// frame has len + 2 bytes (length + len + checksum).
			const needed = len + 2;

			while (this.rxBuffer.length < needed && Date.now() < deadline) {
				const chunk = this.port.read(needed - this.rxBuffer.length);
				if (chunk) {
					this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
				} else {
					await sleep(5);
				}
			}

			if (this.rxBuffer.length < needed) {
				await this.fail("timeout", "Timeout while receiving complete MK2 frame");
			}

			let frame: Buffer = this.rxBuffer.slice(0, needed);
			if (!this.checksum(frame)) {
				await this.fail("checksum", "MK2 frame checksum error");
			}
			this.rxBuffer = this.rxBuffer.slice(needed);
			this.frame_debug("RECV <-", frame);
			// Bit 7 is LED-append framing metadata, not part of the protocol
			// length. Mask it before handing the frame to the decoders; the
			// checksum was already verified over the raw byte.
			frame[0] &= 0x7f;
			if (ledAppended) {
				// Appendix 1 carries LED on/blink inside the checksummed frame.
				// Consume an immediately buffered legacy external L block when
				// present, otherwise strip the in-frame bytes without waiting (#88).
				if (!this.discardAppendedLedStatus()) {
					if (frame.length < 5) {
						await this.fail("protocol", "LED-appended frame too short");
					}
					frame = this.removeInFrameLedStatus(frame);
				}
			}
			return frame;
		}
		await this.fail("timeout", "Timeout waiting for MK2 frame");
		throw new Error("unreachable");
	}

	/** Consume an immediately buffered legacy external L block, if present. */
	private discardAppendedLedStatus(): boolean {
		// Pull bytes already buffered by the driver, but never wait for a late
		// external block: the documented in-frame variant needs no grace delay.
		const chunk = this.port.readAvailable();
		if (chunk) {
			this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
		}
		if (this.rxBuffer.length >= 3 && this.rxBuffer[0] == 0x4c) {
			// Older firmware appends a trailing 0x00 that would otherwise be
			// read as the next frame length (0 -> protocol error).
			const consume = this.rxBuffer.length >= 4 && this.rxBuffer[3] == 0x00 ? 4 : 3;
			this.log.debug("discarding external LED status block");
			this.rxBuffer = this.rxBuffer.slice(consume);
			return true;
		}
		return false;
	}

	/** Strip the documented in-frame LED on/blink bytes and rebuild the base frame. */
	private removeInFrameLedStatus(frame: Buffer): Buffer {
		const ledOn = frame[frame.length - 3];
		const ledBlink = frame[frame.length - 2];
		const base = Buffer.concat([frame.subarray(0, -3), frame.subarray(-1)]);
		base[0] = (base[0] - 2) & 0x7f;
		let sum = 0;
		for (const byte of base.subarray(0, -1)) sum += byte;
		base[base.length - 1] = (256 - (sum % 256)) & 0xff;
		this.log.debug(`in-frame LED status: on=0x${ledOn.toString(16)}, blink=0x${ledBlink.toString(16)}`);
		return base;
	}

	/**
	 * Count the failure and invalidate the connection. A timeout or checksum
	 * error means the byte stream cannot be trusted any more, so the port is
	 * closed and the next poll reopens and resynchronises (issue #8).
	 */
	private async fail(kind: "timeout" | "checksum" | "protocol" | "sync", message: string): Promise<void> {
		if (kind == "timeout") this.timeouts++;
		if (kind == "checksum") this.checksumErrors++;
		if (kind == "protocol") this.protocolErrors++;
		if (kind == "sync") this.syncErrors++;
		this.lastError = message;
		this.synced = false;
		this.rxBuffer = Buffer.alloc(0);
		try {
			await this.port.close();
		} catch {
			// best effort; the reopen path handles a closed or broken port
		}
		throw new Mk2TransportError(message);
	}

	/** Normalize open/write/read failures and force a clean resync (#89). */
	private async failIo(operation: string, error: unknown): Promise<never> {
		if (error instanceof Mk2TransportError) {
			throw error;
		}
		const detail = error instanceof Error ? error.message : String(error);
		this.protocolErrors++;
		this.lastError = `${operation}: ${detail}`;
		this.synced = false;
		this.rxBuffer = Buffer.alloc(0);
		try {
			await this.port.close();
		} catch {
			// best effort; the next exchange reopens and resynchronises
		}
		throw new Mk2TransportError(this.lastError);
	}

	/**
	 * Asynchronous serial errors (USB unplugged, driver reset) must not only be
	 * logged: invalidate the sync and close the port so the next poll reopens and
	 * resynchronises (issue #8).
	 */
	private handleSerialError(err: Error): void {
		this.protocolErrors++;
		this.lastError = "serial error: " + err.message;
		this.synced = false;
		this.rxBuffer = Buffer.alloc(0);
		void this.port.close().catch(() => undefined);
	}

	/** Set of exchange queue: serialises requests; see communicateMulti. */
	async waitForIdle(timeoutMs = 3000): Promise<void> {
		await Promise.race([this.queueTail, sleep(timeoutMs)]);
	}

	checksum(frame: Buffer): boolean {
		let sum = 0;
		for (let i = 0; i < frame.length; i++) {
			sum += frame[i];
		}
		return sum % 256 == 0;
	}

	frame_debug(txt: string, frame: Buffer, data?: any): void {
		if (this.debug) {
			this.log.debug("-------------------------------------------------------------------------------------");
			this.log.debug(txt + util.inspect(frame));
			let legend = "       ";
			for (let i = 0; i < frame.length; i++) {
				legend += i.toString().padStart(3, " ");
			}
			this.log.debug(txt + legend);
			if (data) this.log.debug(data);
			this.log.debug("-------------------------------------------------------------------------------------");
		}
	}
}
