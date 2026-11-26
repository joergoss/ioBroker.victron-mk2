#!/usr/bin/env node
/**
 * Strictly read-only live protocol matrix for one MultiPlus on /dev/ttyUSB-Serial-1.
 * Stop the ioBroker adapter first for exclusive serial access. No S commands,
 * setting writes, force-state, Off, reset or other device changes are sent.
 *
 * Overrides: MK2_PORT, MK2_MODULE_PATH, MK2_PACKAGE_PATH, MK2_MATRIX_OUT and
 * NODE_PATH (for dependencies of a temporary build). Raw frames, timings,
 * values and transport counters are written to /tmp/mk2-protocol-matrix.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const modulePath = process.env.MK2_MODULE_PATH || path.join(__dirname, '../build/mk2/mk2Protocol.js');
const packagePath = process.env.MK2_PACKAGE_PATH || path.join(__dirname, '../package.json');
const portPath = process.env.MK2_PORT || '/dev/ttyUSB-Serial-1';
const OUT = process.env.MK2_MATRIX_OUT || '/tmp/mk2-protocol-matrix.json';
const { Mk2Protocol } = require(modulePath);

const logger = {
    level: 'debug',
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
const protocol = new Mk2Protocol(portPath, logger);
const conn = protocol.conn;
conn.responseTimeoutMs = 5000;
conn.debug = true;

const report = {
    started: new Date().toISOString(),
    port: portPath,
    responseTimeoutMs: 5000,
    buildPath: modulePath,
    adapterVersion: require(packagePath).version,
    tests: [],
};
let current = null;
conn.frame_debug = (direction, frame) => {
    if (current && Buffer.isBuffer(frame)) {
        current.frames.push({ direction, hex: frame.toString('hex') });
    }
};

function save() {
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
}

async function run(name, fn, details) {
    current = { name, started: new Date().toISOString(), frames: [] };
    const start = Date.now();
    const before = {
        timeouts: conn.timeouts,
        protocolErrors: conn.protocolErrors,
        syncErrors: conn.syncErrors,
        checksumErrors: conn.checksumErrors,
    };
    try {
        const value = await fn();
        current.ok = true;
        if (value !== undefined) current.value = value;
    } catch (error) {
        current.ok = false;
        current.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    current.ms = Date.now() - start;
    current.finished = new Date().toISOString();
    current.countersBefore = before;
    current.countersAfter = {
        timeouts: conn.timeouts,
        protocolErrors: conn.protocolErrors,
        syncErrors: conn.syncErrors,
        checksumErrors: conn.checksumErrors,
    };
    current.state = protocol.mk2Model['state.state'].value;
    current.switchState = protocol.mk2Model['switch.state'].value;
    current.mk2Version = conn.mk2Version;
    current.mk2Mode = conn.mk2Mode;
    if (details) Object.assign(current, details(current));
    report.tests.push(current);
    console.log(`${current.ok ? 'OK  ' : 'FAIL'} ${name} ${current.ms}ms${current.error ? ` ${current.error}` : ''}`);
    save();
    current = null;
}

async function activeVersion() {
    await conn.ensureSynced();
    await conn.discardInput();
    await conn.port.write(protocol.create_frame('V', ''));
    const response = await conn.receiveFrame(5000);
    if (response[2] !== 0x56) throw new Error(`active V: unexpected command 0x${response[2]?.toString(16)}`);
    return {
        raw: response.toString('hex'),
        version: (response[3] | response[4] << 8 | response[5] << 16 | response[6] << 24) >>> 0,
        mode: response[7],
    };
}

async function main() {
    await run('sync/passive-version', () => conn.ensureSynced());
    await run('V/active-version', activeVersion);

    for (let round = 1; round <= 3; round++) {
        await run(`round${round}/A/address`, () => protocol.address());
        await run(`round${round}/W0E/state`, () => protocol.get_state());
        await run(`round${round}/W05-W06/device-info`, async () => {
            protocol.deviceInfoLoaded = false;
            await protocol.loadDeviceInfo();
            return {
                deviceSwVersion: protocol.mk2Model['info.device_sw_version'].value,
                formatted: protocol.mk2Model['info.device_sw_version_text'].value,
            };
        });
        await run(`round${round}/W36/scalings`, () => protocol.loadScalingsIfNeeded());
        await run(`round${round}/L/leds`, () => protocol.led_status());
        await run(`round${round}/F5/master-multi-led`, () => protocol.master_multi_led_info(), (test) => {
            const frame = [...test.frames].reverse().find((entry) => entry.direction.startsWith('RECV') && Buffer.from(entry.hex, 'hex')[1] === 0x41);
            if (!frame) return {};
            const raw = Buffer.from(frame.hex, 'hex');
            return {
                rawLength: raw[0],
                acInputConfig: raw[6],
                inputOverriddenByPanel: Boolean(raw[6] & 0x04),
                remotePanelDetectedBit: Boolean(raw[6] & 0x80),
                fixedSwitchCandidate: raw.length > 13 ? raw[13] : null,
                trailingSwitchCandidate: raw.length > (raw[0] & 0x7f) ? raw[raw[0] & 0x7f] : null,
            };
        });
        await run(`round${round}/F0/dc-info`, () => protocol.dc_info());
        await run(`round${round}/F1/ac-info`, () => protocol.ac_info());
    }

    for (let id = 0; id <= 19; id++) {
        let supported = false;
        await run(`ram/${id}/W36/info`, async () => {
            const info = await protocol.getRamInfo(id);
            supported = info.supported;
            return info;
        });
        if (supported) {
            await run(`ram/${id}/W30/read`, () => protocol.readRamVar(id));
        }
    }

    for (let id = 0; id <= 65; id++) {
        let supported = false;
        await run(`setting/${id}/W35/info`, async () => {
            const info = await protocol.getSettingInfo(id, true);
            supported = info.supported;
            return info;
        });
        if (supported) {
            await run(`setting/${id}/W31/read`, () => protocol.readSetting(id));
        }
    }

    report.finished = new Date().toISOString();
    report.summary = {
        total: report.tests.length,
        passed: report.tests.filter((test) => test.ok).length,
        failed: report.tests.filter((test) => !test.ok).length,
        failures: report.tests.filter((test) => !test.ok).map((test) => ({ name: test.name, error: test.error, ms: test.ms })),
    };
    save();
    console.log(JSON.stringify(report.summary, null, 2));
    if (report.summary.failed > 0) process.exitCode = 1;
}

main()
    .catch((error) => {
        console.error(error.stack || error);
        process.exitCode = 1;
    })
    .finally(() => conn.shutdown());
