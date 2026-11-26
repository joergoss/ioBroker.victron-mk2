#!/usr/bin/env node
/**
 * Controlled reversible live acceptance for the production single-MultiPlus setup.
 *
 * Required preconditions (all enforced before the first write):
 * - MultiPlus in Bypass (80), switch On, effective and configured limit 5 A.
 * - DisableCharge=true, PowerAssist enabled, charge current 0 A.
 * - Absorption 14.2 V, float 13.4 V and bulk current 120 A.
 * - AC output unloaded and the ioBroker adapter stopped for exclusive port access.
 *
 * The script changes only the temporary limit, AC1 limit (4 <-> 5 A), grid and
 * switch 2/3 states. Charger-only is skipped because enabling charging just for
 * a positive test is prohibited. Settings/flags are exercised as same-value
 * writes, which must take the EEPROM-avoidance path. Every step reads W0E/F5;
 * grid operations additionally require their effective main state. Finally the
 * script restores and verifies Bypass/On, 5 A and DisableCharge=true.
 *
 * Run from the repository with build/ present, or set MK2_MODULE_PATH to a
 * development mk2Protocol.js. NODE_PATH may be needed for a temporary build.
 * MK2_PORT and MK2_ACCEPTANCE_OUT override the default port and JSON report
 * path (/tmp/mk2-write-acceptance.json). With MK2_VALIDATE_EEPROM_FREE=1 the
 * first AC1 write also exercises prepareSettingWrite and asserts on-wire that
 * its short FlagsExt0 S form contains no EEPROM-flags byte. The same opt-in
 * also clears the confirmed-setpoint cache after the 0 A step and verifies a
 * cold 0 A -> 3.1 A transition before restoring 5 A.
 */
'use strict';

const { Mk2Protocol } = require(process.env.MK2_MODULE_PATH || '../build/mk2/mk2Protocol');

const OUT = process.env.MK2_ACCEPTANCE_OUT || '/tmp/mk2-write-acceptance.json';
const PORT = process.env.MK2_PORT || '/dev/ttyUSB-Serial-1';
const fs = require('fs');
const log = {
    level: 'info',
    debug: () => undefined,
    info: (m) => console.log(`INFO ${m}`),
    warn: (m) => console.log(`WARN ${m}`),
    error: (m) => console.error(`ERROR ${m}`),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const p = new Mk2Protocol(PORT, log);
    p.conn.responseTimeoutMs = 5000;
    const validateEepromFree = process.env.MK2_VALIDATE_EEPROM_FREE === '1';
    const sentSFrames = [];
    if (validateEepromFree) {
        p.conn.debug = true;
        p.conn.frame_debug = (direction, frame) => {
            if (direction.startsWith('SEND') && frame[2] === 0x53) sentSFrames.push(Buffer.from(frame));
        };
    }
    const results = [];
    const snapshot = () => ({
        state: p.mk2Model['state.state'].value,
        switchState: p.mk2Model['switch.state'].value,
        limit: p.mk2Model['assist.limit'].value,
        configuredLimit: p.mk2Model['setting.IMainsLimitAC1'].value,
        disableCharge: p.mk2Model['setting.flag.DisableCharge'].value,
        disableAES: p.mk2Model['setting.flag.DisableAES'].value,
        assistEnabled: p.mk2Model['setting.flag.AssistEnabled'].value,
        absorption: p.mk2Model['setting.UBatAbsorption'].value,
        float: p.mk2Model['setting.UBatFloat'].value,
        bulk: p.mk2Model['setting.IBatBulk'].value,
        chargeCurrent: p.mk2Model['dc_info.icharge'].value,
    });

    function assertEepromFreeSFrames() {
        for (const frame of sentSFrames.splice(0)) {
            // Optional Reserved + FlagsExt0=1 starts at indexes 8/9. The
            // shortened frame is 11 bytes including length and checksum.
            if (frame.length >= 11 && frame[8] === 0 && frame[9] === 1 && frame.length !== 11) {
                throw new Error(`S compatibility frame carries an EEPROM-flags byte: ${frame.toString('hex')}`);
            }
        }
    }

    async function step(name, fn, expected) {
        const started = Date.now();
        try {
            const value = await fn();
            await p.get_state();
            await p.master_multi_led_info();
            await p.get_flags();
            const state = snapshot();
            if (validateEepromFree) assertEepromFreeSFrames();
            results.push({ name, ok: true, value, state, expected, ms: Date.now() - started });
            console.log(`OK ${name} ${JSON.stringify(state)}`);
        } catch (error) {
            results.push({ name, ok: false, error: error.message, state: snapshot(), expected, ms: Date.now() - started });
            console.error(`FAIL ${name}: ${error.message}`);
            throw error;
        }
    }

    async function waitForMainState(expectedStates, timeoutMs = 120000) {
        const deadline = Date.now() + timeoutMs;
        let last;
        do {
            await p.get_state();
            const encoded = p.mk2Model['state.state'].value;
            const mainState = typeof encoded === 'number' ? Math.floor(encoded / 10) : encoded;
            if (mainState !== last) console.log(`STATE main=${mainState} encoded=${encoded}`);
            last = mainState;
            if (expectedStates.includes(mainState)) return mainState;
            await sleep(250);
        } while (Date.now() < deadline);
        throw new Error(`Main-state readback: expected ${expectedStates.join('/')}, got ${last} after ${timeoutMs} ms`);
    }

    async function changeGridMode(mode) {
        const result = await p.set_grid_mode(mode);
        await waitForMainState(mode === 0 ? [7, 8, 9] : [4, 5, 6]);
        return result;
    }

    try {
        await p.pollStateOnly();
        const initialState = p.mk2Model['state.state'].value;
        if (initialState !== 80) throw new Error(`Unsafe start state ${initialState}; expected Bypass (80)`);
        await p.poll();
        const initial = snapshot();
        if (initial.disableCharge !== true) throw new Error('DisableCharge is not true; refusing write tests');
        if (initial.configuredLimit !== 5 || initial.limit !== 5) {
            throw new Error(`Unexpected AC limit configured=${initial.configuredLimit}, actual=${initial.limit}`);
        }
        if (initial.assistEnabled !== true) throw new Error('PowerAssist is not enabled; refusing 0 A tests');
        if (initial.bulk !== 120 || initial.absorption !== 14.2 || initial.float !== 13.4) {
            throw new Error(`Unexpected battery settings: ${JSON.stringify(initial)}`);
        }
        results.push({ name: 'preflight', ok: true, state: initial });
        console.log(`PREFLIGHT ${JSON.stringify(initial)}`);

        await step('set_assist 4 A', () => p.set_assist(4), 4);
        await step('set_assist restore 5 A', () => p.set_assist(5), 5);
        if (validateEepromFree) {
            // Exercise the long-mode preparation path without changing the
            // current MK2 mode. The S frame and subsequent readbacks are real.
            p.longWinmonFrames = true;
            p.shortWinmonForWrites = false;
        }
        await step('IMainsLimitAC1 4 A', () => p.set_IMainsLimitAC1(4), 4);
        await step('IMainsLimitAC1 restore 5 A', () => p.set_IMainsLimitAC1(5), 5);

        await step('grid_mode 2 inverter only', () => changeGridMode(2), 2);
        await step('switch_state 2 readback while already in inverter mode', () => p.set_switch_state(2), 2);
        await step('switch_state 3 restore on', () => p.set_switch_state(3), 3);
        await step('grid_mode 1 zero grid', () => changeGridMode(1), 1);
        await step('grid_mode 0 restore grid', () => changeGridMode(0), 0);

        // State 2 deliberately uses 0 A (§5 note 3); states 1/3 restore the
        // configured/current positive limit. Charger only is incompatible with
        // the required DisableCharge=true preflight on this device: the negative
        // live attempt was rejected by readback, so do not enable charging just
        // to turn that safety constraint into a positive test.
        results.push({
            name: 'switch_state 1 charger only',
            skipped: true,
            reason: 'Device retained On with DisableCharge=true; charging was not enabled for a positive test.',
        });
        console.log('SKIP switch_state 1 charger only: incompatible with DisableCharge=true');

        await step('set_assist 0 A', () => p.set_assist(0), 0);
        if (validateEepromFree) {
            // Simulate a reconnect only in this process. The real device stays
            // in special 0 A mode; 3.1 A must prove On + grid before success.
            p.confirmedInputCurrentSetpoint = null;
            await step('set_assist 3.1 A from cold 0 A', () => p.set_assist(3.1), 3.1);
        }
        await step('set_assist restore 5 A', () => p.set_assist(5), 5);

        await step('DisableCharge same value 1 (no EEPROM change)', () => p.set_flagDisableCharge(1), 1);
        await step('WeakACInput same value 0 (no EEPROM change)', () => p.set_flagWeakACInput(0), 0);
        await step('IBatBulk same value 120 (no EEPROM change)', () => p.set_setting_IBatBulk(120), 120);
        await step('Absorption same value 14.20 V (no EEPROM change)', () => p.set_UBatAbsorption(14.2), 14.2);
        await step('Float same value 13.40 V (no EEPROM change)', () => p.set_UBatFloat(13.4), 13.4);
        await step('DisableAES same value 1 (no EEPROM change)', () => p.set_flagDisableAES(1), 1);
        await step('AssistEnabled same value 1 (no EEPROM change)', () => p.set_flagAssistEnabled(1), 1);
        const dynamic = p.mk2Model['setting.flag.DynamicCurrentLimiter'].value;
        await step(`DynamicCurrentLimiter same value ${dynamic ? 1 : 0}`, () => p.set_flagDynamicCurrentLimiter(dynamic ? 1 : 0), dynamic ? 1 : 0);

        await step('final grid_mode 0 restore bypass', () => changeGridMode(0), 0);
        const finalState = snapshot();
        if (finalState.state !== 80 || finalState.switchState !== 3 || finalState.limit !== 5 || finalState.disableCharge !== true) {
            throw new Error(`Unsafe final state: ${JSON.stringify(finalState)}`);
        }
        results.push({ name: 'final', ok: true, state: finalState });
        console.log(`FINAL ${JSON.stringify(finalState)}`);
        fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    } finally {
        let restoreFailed = false;
        const restorations = [
            ['DisableCharge=1', () => p.mk2Model['setting.flag.DisableCharge'].value !== true, () => p.set_flagDisableCharge(1)],
            ['IMainsLimitAC1=5', () => p.mk2Model['setting.IMainsLimitAC1'].value !== 5, () => p.set_IMainsLimitAC1(5)],
            ['switch_state=3', () => p.mk2Model['switch.state'].value !== 3, () => p.set_switch_state(3)],
            ['set_assist=5', () => p.mk2Model['assist.limit'].value !== 5, () => p.set_assist(5)],
        ];
        for (const [name, needed, restore] of restorations) {
            if (!needed()) continue;
            try {
                await restore();
            } catch (error) {
                restoreFailed = true;
                console.error(`RESTORE WARNING ${name}: ${error.message}`);
            }
        }
        results.push({ name: 'restoration', ok: !restoreFailed, state: snapshot() });
        fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
        if (restoreFailed) process.exitCode = 1;
        await p.conn.shutdown();
    }
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
