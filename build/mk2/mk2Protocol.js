"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Mk2Protocol = exports.Calc = void 0;
const mk2Connection_1 = require("./mk2Connection");
const mk2Model_1 = require("./mk2Model");
const mk2Settings_1 = require("./mk2Settings");
const mk2Ram_1 = require("./mk2Ram");
const mk2Switch_1 = require("./mk2Switch");
const bp = __importStar(require("bufferpack"));
const errors_1 = require("../lib/errors");
class Calc {
}
exports.Calc = Calc;
function scale(factor) {
    return (0, mk2Ram_1.ramScale)(factor);
}
function round(number, decimal) {
    const e = Math.pow(10, decimal);
    return Math.round(number * e) / e;
}
const FLAGS0_KEYS = {
    0: "setting.flag.MultiPhaseSystem",
    1: "setting.flag.MultiPhaseLeader",
    2: "setting.flag.Freq60Hz",
    3: "setting.flag.DisableWaveCheck",
    4: "setting.flag.DoNotStopAfter10HrBulk",
    5: "setting.flag.AssistEnabled",
    6: "setting.flag.DisableCharge",
    7: "setting.flag.WaveCheckInverted",
    8: "setting.flag.DisableAES",
    11: "setting.flag.EnableReducedFloat",
    13: "setting.flag.DisableGroundRelay",
    14: "setting.flag.WeakACInput",
    15: "setting.flag.RemoteOverrulesAC2",
};
class Mk2Protocol {
    /**
     * Drop all connection-derived caches when the MK2 resynchronised (review
     * T15): after a reconnect or a device replacement, scalings, setting ranges,
     * RAM support and the device identification may all be different.
     */
    checkConnectionGeneration() {
        if (this.conn.generation === this.connectionGeneration) {
            return;
        }
        this.connectionGeneration = this.conn.generation;
        this.calc = new Calc();
        this.settingInfoCache.clear();
        this.ramInfoCache.clear();
        this.unsupportedRam.clear();
        this.deviceInfoLoaded = false;
        this.mk2Model["info.device_sw_version"].value = null;
        this.mk2Model["info.device_sw_version_text"].value = null;
        this.longWinmonFrames = false;
        this.shortWinmonForWrites = false;
        this.confirmedInputCurrentSetpoint = null;
        this.switchStateAmbiguous = true;
        this.currentSwitchState = 3;
        this.clearSwitchModel();
        this.extendedSettingsLoaded = false;
        this.failedExtendedSettings.clear();
        this.unsupportedScalings.clear();
        this.log.debug("new MK2 sync generation, cached metadata reset");
    }
    constructor(portPath, log, conn) {
        this.mk2Model = new mk2Model_1.Mk2Model();
        /** Current VE.Bus switch state used for S commands (default: On). */
        this.currentSwitchState = 3;
        /** Bounded wait for F5/main-state readback; live 1909209 took about 9 s to return to Bypass. */
        this.switchReadbackTimeoutMs = 15000;
        /** Grid relays/main state can settle later than the panel register; stay below the 60 s queue TTL. */
        this.gridModeReadbackTimeoutMs = 45000;
        /** §7.3.2 documents up to one second for force-state transitions. */
        this.forceStateReadbackTimeoutMs = 3000;
        this.switchReadbackPollIntervalMs = 100;
        /** False after an F5 DMC-dedicated frame whose limit bytes must be ignored. */
        this.inputCurrentLimitsValid = true;
        /** True until an unambiguous F5 switch register has been decoded. */
        this.switchStateAmbiguous = true;
        /** Cached CommandGetSettingInfo answers, keyed by setting id. */
        this.settingInfoCache = new Map();
        this.extendedSettingsLoaded = false;
        this.failedExtendedSettings = new Set();
        this.unsupportedScalings = new Set();
        this.ramInfoCache = new Map();
        this.unsupportedRam = new Set();
        this.deviceInfoLoaded = false;
        this.longWinmonFrames = false;
        this.shortWinmonForWrites = false;
        this.connectionGeneration = -1;
        /** Last input-current setpoint this adapter confirmed on the device; null when unknown. */
        this.confirmedInputCurrentSetpoint = null;
        this.portPath = portPath;
        this.conn = conn !== null && conn !== void 0 ? conn : new mk2Connection_1.Mk2Connection(portPath, log);
        this.calc = new Calc();
        this.log = log;
        this.clearSwitchModel();
    }
    /** True only when the latest F5 proves the panel switch state. */
    hasUnambiguousSwitchState() {
        return !this.switchStateAmbiguous && typeof this.mk2Model["switch.state"].value === "number";
    }
    getConfirmedInputCurrentSetpoint() {
        return this.confirmedInputCurrentSetpoint;
    }
    /** Reconcile a command state without confusing special 0 A with the F5 minimum. */
    getReconciledAssistSetpoint() {
        if (this.confirmedInputCurrentSetpoint !== null) {
            return this.confirmedInputCurrentSetpoint;
        }
        const limit = this.mk2Model["assist.limit"].value;
        if (typeof limit !== "number")
            return undefined;
        const encoded = this.mk2Model["state.state"].value;
        const mainState = typeof encoded === "number" ? Math.floor(encoded / 10) : null;
        if (mainState !== null && mainState >= 4 && mainState <= 6) {
            if (limit === 0)
                return 0;
            const minimum = this.mk2Model["assist.minlimit"].value;
            if (typeof minimum === "number" && limit <= minimum + 0.01)
                return undefined;
        }
        return limit;
    }
    async poll() {
        try {
            await this.conn.ensureSynced();
            this.checkConnectionGeneration();
            await this.address();
            await this.optionalStep("device identification", () => this.loadDeviceInfo());
            await this.loadScalingsIfNeeded();
            await this.led_status();
            await this.get_state();
            await this.master_multi_led_info();
            await this.dc_info();
            await this.ac_info();
            await this.optionalStep("RAM telemetry", () => this.readRamTelemetry());
            await this.get_setting_IBatBulk();
            await this.get_flags();
            await this.get_flags1();
            await this.optionalStep("extended settings", () => this.loadExtendedSettings());
            this.mk2Model["info.connection"].value = true;
        }
        catch (Exception) {
            this.mk2Model["info.connection"].value = false;
            this.log.error("Exception in poll " + (Exception instanceof Error ? Exception.message : JSON.stringify(Exception)));
        }
        finally {
            this.updateDiagnostics();
        }
    }
    /**
     * Optional feature blocks must not abort the whole poll: firmware without a
     * given RAM variable or setting is normal, not a connection failure.
     */
    async optionalStep(name, fn) {
        try {
            await fn();
        }
        catch (error) {
            // Only feature-level failures are optional. A transport error means the
            // connection is gone and must reach poll()'s failure path (review T6).
            if (error instanceof errors_1.Mk2TransportError) {
                throw error;
            }
            this.log.warn(`optional step "${name}" failed: ${error instanceof Error ? error.message : error}`);
        }
    }
    /** Mirror the connection health counters into the model (issue #8). */
    updateDiagnostics() {
        var _a, _b, _c, _d, _e;
        this.mk2Model["diag.timeouts"].value = (_a = this.conn.timeouts) !== null && _a !== void 0 ? _a : 0;
        this.mk2Model["diag.checksum_errors"].value = (_b = this.conn.checksumErrors) !== null && _b !== void 0 ? _b : 0;
        this.mk2Model["diag.last_error"].value = (_c = this.conn.lastError) !== null && _c !== void 0 ? _c : "";
        this.mk2Model["diag.protocol_errors"].value = (_d = this.conn.protocolErrors) !== null && _d !== void 0 ? _d : 0;
        this.mk2Model["diag.sync_errors"].value = (_e = this.conn.syncErrors) !== null && _e !== void 0 ? _e : 0;
    }
    /**
     * Minimal, read-only poll of the device address and main state. It runs first
     * in every cycle, is the only serial exchange while the MultiPlus is Off
     * (unless a power-on control is queued), and confirms that the device has
     * finished booting before any control command is sent.
     */
    async pollStateOnly() {
        try {
            await this.conn.ensureSynced();
            this.checkConnectionGeneration();
            await this.address();
            await this.get_state();
            // Successful exchange: connected. The full poll owns its own failure case.
            this.mk2Model["info.connection"].value = true;
        }
        finally {
            // State-only is the first request after every resync. Publish sync and
            // transport diagnostics here as well, not only after a full poll (#82).
            this.updateDiagnostics();
        }
    }
    checksum(buffer) {
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
            sum = sum + buffer[i];
        }
        const check = sum % 256;
        //this.log.debug("checksum",check)
        return check == 0 ? true : false;
    }
    create_frame(command, data) {
        const len = command.length + data.length + 1;
        let buf = Buffer.from([len, [0xFF]]);
        buf = Buffer.concat([buf, Buffer.from(command)]);
        buf = Buffer.concat([buf, Buffer.from(data)]);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
            sum = sum + buf[i];
        }
        sum = 256 - sum % 256;
        buf = Buffer.concat([buf, Buffer.from([sum])]);
        //    this.log.debug("SEND -> ", buf, buf.toString(), 'checksum',sum);
        // this.conn.frame_debug("SEND ->", buf);
        return buf;
    }
    async address() {
        this.log.debug("******   adress");
        return this.conn.communicate(this.create_frame("A", "\x01\x00"), async (response) => {
            if (response[0] < 0x04 || response[1] != 0xff || response[2] != 0x41 || response[3] != 0x01) {
                throw new Error("no address frame");
            }
            // The reply carries the address currently used by the MK2 (§7.1).
            this.mk2Model["info.address"].value = response[4];
        });
    }
    async led_status() {
        this.log.debug("******   led_status");
        return this.conn.communicate(this.create_frame("L", ""), async (response) => {
            // §4 note b: MK2 >= 1130128 omits the trailing 0x00, so the response can
            // be as short as 4 (length, marker, on, blink) plus checksum.
            if (response[0] < 0x04 || response[1] != 0xff || response[2] != 0x4c) {
                throw new Error("no led_status frame");
            }
            const led_status = response[3];
            const led_blink = response[4];
            let mains = mk2Model_1.led.UNKNOWN;
            let absorption = mk2Model_1.led.UNKNOWN;
            let bulk = mk2Model_1.led.UNKNOWN;
            let float = mk2Model_1.led.UNKNOWN;
            let inverter = mk2Model_1.led.UNKNOWN;
            let overload = mk2Model_1.led.UNKNOWN;
            let low_bat = mk2Model_1.led.UNKNOWN;
            let temp = mk2Model_1.led.UNKNOWN;
            // if (!this.mk2Model["led.mains"].value) {
            if (led_status == 0x1f && led_blink == 0x1f) {
                // unable to determine the LED status
            }
            else {
                mains = ((led_blink & 1) << 1) + (led_status & 1) >> 0;
                absorption = ((led_blink & 2) << 1) + (led_status & 2) >> 1;
                bulk = ((led_blink & 4) << 1) + (led_status & 4) >> 2;
                float = ((led_blink & 8) << 1) + (led_status & 8) >> 3;
                inverter = ((led_blink & 16) << 1) + (led_status & 16) >> 4;
                overload = ((led_blink & 32) << 1) + (led_status & 32) >> 5;
                low_bat = ((led_blink & 64) << 1) + (led_status & 64) >> 6;
                temp = ((led_blink & 128) << 1) + (led_status & 128) >> 7;
            }
            this.mk2Model["led.mains"].value = mains;
            this.mk2Model["led.absorption"].value = absorption;
            this.mk2Model["led.bulk"].value = bulk;
            this.mk2Model["led.float"].value = float;
            this.mk2Model["led.inverter"].value = inverter;
            this.mk2Model["led.overload"].value = overload;
            this.mk2Model["led.low_bat"].value = low_bat;
            this.mk2Model["led.temp"].value = temp;
        });
    }
    /** Load one RAM scale/offset pair into the calc cache (table-driven). */
    async loadRamScaling(id, field) {
        const info = await this.getRamInfo(id);
        if (!info.supported) {
            // Sc = 0 means "not supported". Caching scale 0 would publish 0 V / 0 A
            // as if they were measurements (review M1) - leave the field empty and
            // warn only once per connection instead of on every poll (N6).
            if (!this.unsupportedScalings.has(field)) {
                this.unsupportedScalings.add(field);
                this.log.warn(`RAM variable ${id} is not supported by this firmware; dependent values stay null`);
            }
            return;
        }
        this.calc[field] = { scale: info.sc, offset: info.offset, signed: info.signed };
    }
    // Thin wrappers keep the historical method names used by tests and scripts.
    async umains_calc_load() { return this.loadRamScaling(0, "umains_calc"); }
    async imains_calc_load() { return this.loadRamScaling(1, "imains_calc"); }
    async uinv_calc_load() { return this.loadRamScaling(2, "uinv_calc"); }
    async iinv_calc_load() { return this.loadRamScaling(3, "iinv_calc"); }
    async ubat_calc_load() { return this.loadRamScaling(4, "ubat_calc"); }
    async ibat_calc_load() { return this.loadRamScaling(5, "ibat_calc"); }
    async finv_calc_load() { return this.loadRamScaling(7, "finv_calc"); }
    async fmains_calc_load() { return this.loadRamScaling(8, "fmains_calc"); }
    /** Load every missing scaling exactly once per connection. */
    async loadScalingsIfNeeded() {
        this.log.debug("******   loadScalingsIfNeeded");
        for (const def of Mk2Protocol.RAM_SCALINGS) {
            if (!this.calc[def.field] && !this.unsupportedScalings.has(def.field)) {
                await this.loadRamScaling(def.id, def.field);
            }
        }
    }
    async dc_info() {
        this.log.debug("******   dc_info");
        return this.conn.communicate(this.create_frame("F", "\x00"), async (response) => {
            if (response[0] < 0x0f || response[1] != 0x20 || response[6] != 0x0c) {
                throw new Error("no dc_info frame");
            }
            const ubat = bp.unpack("<H", response, 7)[0];
            // DC current fields are unsigned 24-bit values (protocol §6.1).
            const ibat = response[9] | (response[10] << 8) | (response[11] << 16);
            const cbat = response[12] | (response[13] << 8) | (response[14] << 16);
            // Inverter period, single byte like the mains period on this firmware.
            const finv = response[15];
            // Each measurement depends only on its own scaling. An unsupported
            // current scale must not erase a valid voltage (§6.1, §7.3.3).
            this.mk2Model["dc_info.ubat"].value = this.calc.ubat_calc
                ? round(((ubat + this.calc.ubat_calc.offset) * scale(this.calc.ubat_calc.scale)), 2)
                : null;
            if (this.calc.ibat_calc) {
                const inverterCurrent = round(((ibat + this.calc.ibat_calc.offset) * scale(this.calc.ibat_calc.scale)), 2);
                const chargeCurrent = round(((cbat + this.calc.ibat_calc.offset) * scale(this.calc.ibat_calc.scale)), 2);
                this.mk2Model["dc_info.ibat"].value = inverterCurrent;
                this.mk2Model["dc_info.icharge"].value = chargeCurrent;
                // Net battery current (appendix 2): charging devices minus inverting
                // devices. Positive means charging, like the BMV sign convention.
                this.mk2Model["dc_info.ibat_net"].value = round(chargeCurrent - inverterCurrent, 2);
            }
            else {
                for (const key of ["dc_info.ibat", "dc_info.icharge", "dc_info.ibat_net"]) {
                    this.mk2Model[key].value = null;
                }
            }
            if (this.calc.finv_calc) {
                const period = (finv + this.calc.finv_calc.offset) * scale(this.calc.finv_calc.scale);
                // Appendix 2 applies Scale/Offset first and checks the scaled period.
                this.mk2Model["dc_info.finv"].value = period > 0 ? round(10 / period, 2) : 0;
            }
            else {
                this.mk2Model["dc_info.finv"].value = null;
            }
        });
    }
    async ac_info() {
        this.log.debug("******   ac_info");
        return this.conn.communicate(this.create_frame("F", "\x01"), async (frame) => {
            if (frame[0] < 0x0f || frame[1] != 0x20 || frame[6] < 0x05 || frame[6] > 0x0B) {
                throw new Error("no ac_info frame");
            }
            const data = bp.unpack("<B B B B B H H H H B", frame, 2);
            const bf_factor = data[0];
            const inv_factor = data[1];
            // const reserved   = data[2];
            const state = data[3];
            const phase_info = data[4];
            const umains = data[5];
            const imains = data[6];
            const uinv = data[7];
            const iinv = data[8];
            // §6.1 and the Appendix 1/2 frame layouts carry one period byte at
            // data[13]. Future trailing bytes are handled by the generic receiver.
            const fmains = data[9];
            // State/phase need no scaling. Every analog value is independent:
            // one unsupported RAM variable must not blank the other measurements.
            this.mk2Model["ac_info.state"].value = this.acStateFieldValid() ? state : null;
            this.mk2Model["ac_info.phase_info"].value = phase_info;
            this.mk2Model["ac_info.umains"].value = this.calc.umains_calc
                ? round(((umains + this.calc.umains_calc.offset) * scale(this.calc.umains_calc.scale)), 0)
                : null;
            // §6.1 footnote c: a zero factor means unknown current, not 0 A.
            const signed16 = (raw, signed) => signed && raw >= 0x8000 ? raw - 0x10000 : raw;
            this.mk2Model["ac_info.imains"].value = this.calc.imains_calc && bf_factor !== 0
                ? round(((signed16(imains, this.calc.imains_calc.signed) + this.calc.imains_calc.offset) * scale(this.calc.imains_calc.scale) * bf_factor), 2)
                : null;
            this.mk2Model["ac_info.uinv"].value = this.calc.uinv_calc
                ? round(((uinv + this.calc.uinv_calc.offset) * scale(this.calc.uinv_calc.scale)), 0)
                : null;
            this.mk2Model["ac_info.iinv"].value = this.calc.iinv_calc && inv_factor !== 0
                ? round(((signed16(iinv, this.calc.iinv_calc.signed) + this.calc.iinv_calc.offset) * scale(this.calc.iinv_calc.scale) * inv_factor), 2)
                : null;
            if (this.calc.fmains_calc) {
                // Appendix 2 applies Scale/Offset first and checks the scaled period.
                const mainsPeriod = (fmains + this.calc.fmains_calc.offset) * scale(this.calc.fmains_calc.scale);
                this.mk2Model["ac_info.fmains"].value = mainsPeriod > 0 ? round(10 / mainsPeriod, 2) : 0;
            }
            else {
                this.mk2Model["ac_info.fmains"].value = null;
            }
        });
    }
    /**
     * Protocol §6.1: the AC info <State> field exists only on Multi firmware
     * >= 207. On older units the byte carries something else, so publishing it
     * as a state would be misleading (measured on firmware 1909140: raw 70).
     */
    acStateFieldValid() {
        const version = this.mk2Model["info.device_sw_version"].value;
        if (typeof version != "number" || version <= 0) {
            return true; // unknown firmware: keep the raw value
        }
        return version % 1000 >= 207;
    }
    /** Publish "unknown" for all switch fields without touching the cached state. */
    clearSwitchModel() {
        for (const key of Object.keys(this.mk2Model)) {
            if (key.startsWith("switch.")) {
                this.mk2Model[key].value = null;
            }
        }
    }
    async master_multi_led_info() {
        this.log.debug("******   master_multi_led_info");
        return this.conn.communicate(this.create_frame("F", "\x05"), async (response) => {
            // §3.2: responses may grow. A 0x0C frame carries 11 data bytes and NO
            // switch register; only 0x0D and longer include it. Reading data[11]
            // unconditionally used to return the checksum as the switch register.
            if (response[0] < 0x0c || response[1] != 0x41) {
                throw new Error("no master_multi_led_info frame");
            }
            this.switchStateAmbiguous = false;
            const dmcDedicated = (response[6] & 0x08) !== 0;
            this.inputCurrentLimitsValid = !dmcDedicated;
            if (dmcDedicated) {
                // §6.2: with DMC dedicated the current-limit bytes are not valid.
                for (const key of ["assist.minlimit", "assist.maxlimit", "assist.limit"]) {
                    this.mk2Model[key].value = null;
                }
                this.confirmedInputCurrentSetpoint = null;
            }
            else {
                const data = bp.unpack("<H H H B", response, 7);
                this.mk2Model["assist.minlimit"].value = data[0] / 10.0;
                this.mk2Model["assist.maxlimit"].value = data[1] / 10.0;
                this.mk2Model["assist.limit"].value = data[2] / 10.0;
                this.reconcileConfirmedSetpoint(data[2] / 10.0, data[0] / 10.0);
            }
            const hasSwitchRegister = response[0] >= 0x0d && response.length >= 15;
            if (!hasSwitchRegister) {
                // No register in this frame: never derive a switch state from other
                // bytes (formerly the checksum), and keep the local state as-is.
                this.switchStateAmbiguous = true;
                this.clearSwitchModel();
                this.log.debug("master_multi_led_info: frame carries no switch register");
                return;
            }
            // §6.2 fixes the switch register at data byte 11 (frame index 13).
            // §3.2 requires generic trailing bytes to be ignored. The only exception
            // accepted here is the exact extended layout captured on firmware 1909209;
            // length/main-state/cache alone must never relocate the register (#108).
            const len = response[0] & 0x7f;
            const fixedIndex = 0x0d;
            const fixedRegister = response[fixedIndex];
            const trailingRegister = len > fixedIndex ? response[len] : undefined;
            const stateValue = this.mk2Model["state.state"].value;
            const mainState = typeof stateValue === "number" ? Math.floor(stateValue / 10) : 0;
            const version = this.mk2Model["info.device_sw_version"].value;
            const versionUnknown = typeof version !== "number" || version <= 0;
            const known1909209Layout = len === 0x0f && version === 1909209;
            const unknownExtendedLayout = len === 0x0f && !known1909209Layout && versionUnknown;
            let switch_register = known1909209Layout ? trailingRegister : fixedRegister;
            let switchRegisterTrusted = true;
            if (unknownExtendedLayout && trailingRegister !== undefined && trailingRegister !== fixedRegister) {
                const fixedState = (0, mk2Switch_1.switchStateFromRegister)(fixedRegister);
                const trailingState = (0, mk2Switch_1.switchStateFromRegister)(trailingRegister);
                if (fixedState === trailingState) {
                    // Bits 4/5 agree, so the state is proven even though the exact
                    // register and its other six bits are not (#99/#102).
                    switchRegisterTrusted = false;
                }
                else {
                    switch_register = undefined;
                }
            }
            const derived = switch_register === undefined ? undefined : (0, mk2Switch_1.switchStateFromRegister)(switch_register);
            const contradictsOff = derived === 4 && mainState !== 2 && mainState !== 0 && mainState !== 1;
            const contradictsChargerOnly = derived === 1 && mainState >= 4 && mainState <= 7;
            if (switch_register === undefined || contradictsOff || contradictsChargerOnly) {
                this.switchStateAmbiguous = true;
                const hasPrevious = this.mk2Model["switch.state"].value !== null;
                if (hasPrevious) {
                    this.log.debug(`master_multi_led_info: switch register ambiguous or inconsistent with state ${String(stateValue)}; keeping the previous value`);
                }
                else {
                    this.log.warn(`master_multi_led_info: switch register ambiguous or inconsistent with state ${String(stateValue)}; keeping it unknown`);
                    this.clearSwitchModel();
                }
                return;
            }
            const applied = (0, mk2Switch_1.switchStateFromRegister)(switch_register);
            // Bits 4/5 are proven by the common derived state even when two raw
            // candidates differ. The other six bits belong to one exact register
            // and stay unknown unless its position/value is unambiguous (#102).
            this.mk2Model["switch.SwitchCharge"].value = applied === 1 || applied === 3 ? 1 : 0;
            this.mk2Model["switch.SwitchInvert"].value = applied === 2 || applied === 3 ? 1 : 0;
            const detailBits = {
                "switch.DirectRemoteSwitchCharge": 0b00000001,
                "switch.DirectRemoteSwitchInvert": 0b00000010,
                "switch.FrontSwitchUp": 0b00000100,
                "switch.FrontSwitchDown": 0b00001000,
                "switch.OnboardRemoteInvertSwitch": 0b01000000,
                "switch.RemoteGeneratorSelected": 0b10000000,
            };
            for (const [key, mask] of Object.entries(detailBits)) {
                this.mk2Model[key].value = switchRegisterTrusted ? (switch_register & mask) > 0 ? 1 : 0 : null;
            }
            // The device is authoritative for the panel switch state (issue #7):
            // a front switch or remote panel change must not be overwritten by a
            // stale local cache on the next limit write.
            this.mk2Model["switch.state"].value = applied;
            if (applied !== this.currentSwitchState) {
                this.log.info(`switch state changed on the device: ${this.currentSwitchState} -> ${applied}; adopting it`);
                this.currentSwitchState = applied;
            }
        }, { readTimeoutMs: Math.max(2000, this.conn.responseTimeoutMs) }); // F5 honours the configured response budget (#81)
    }
    async get_state() {
        this.log.debug("******   get_state");
        return this.conn.communicate(this.create_frame("W", "\x0E\x00\x00"), async (response) => {
            this.decodeStateResponse(response, "get_state");
        });
    }
    /**
     * 0x94 <State> <Sub-state> (protocol §7.3.2). The historical state.state
     * encoding is mainState*10 + subState; the sub-state is also exposed on its
     * own so charge phases do not have to be decoded from a two-digit number.
     */
    decodeStateResponse(response, context) {
        if (response[0] < 0x05 || response[1] != 0xff || response[2] != 0x57 || response[3] != 0x94) {
            throw new Error(`${context}: no valid state response`);
        }
        const data = bp.unpack("<B B", response, 4);
        const mainState = data[0];
        const subState = data[1];
        // §7.3.2: main states 0-9; sub-state is 0 outside Charge and 0-8 in Charge.
        if (mainState > 9 || subState > 8 || (mainState !== 9 && subState !== 0)) {
            throw new Error(`${context}: invalid state response ${mainState}/${subState}`);
        }
        this.mk2Model["state.state"].value = mainState * 10 + subState;
        this.mk2Model["state.substate"].value = subState;
    }
    /** §5 note 3: 0 A selects Invert only when PowerAssist is known to be enabled. */
    requirePowerAssistForZeroLimit(context) {
        const assist = this.mk2Model["setting.flag.AssistEnabled"].value;
        if (assist === false) {
            throw new errors_1.Mk2ValidationError(`${context}: 0 A with PowerAssist disabled means charger off + Bypass, not Invert (§5 note 3)`);
        }
        if (assist !== true) {
            throw new errors_1.Mk2ValidationError(`${context}: 0 A requires a known enabled PowerAssist state; wait for the first complete poll`);
        }
    }
    /**
     * Drop the cached setpoint as soon as the device's effective limit no longer
     * matches it. The F5 limit is authoritative; a confirmed 0 A setpoint is
     * allowed to read back as the device minimum (1909209 does that).
     */
    reconcileConfirmedSetpoint(limit, minimum) {
        const confirmed = this.confirmedInputCurrentSetpoint;
        if (confirmed === null) {
            return;
        }
        if (confirmed === 0) {
            if (limit > minimum + 0.01) {
                this.confirmedInputCurrentSetpoint = null;
            }
            return;
        }
        if (Math.abs(limit * 10 - confirmed * 10) > 0.01) {
            this.confirmedInputCurrentSetpoint = null;
        }
    }
    /**
     * Send S without making a lost acknowledgement retryable. The request may
     * already have reached VE.Bus even when its response times out or is corrupt.
     */
    async sendS(context, data) {
        try {
            await this.conn.communicate(this.create_frame("S", data), async (response) => {
                if (response[0] < 0x02 || response[1] != 0xff || response[2] != 0x53) {
                    throw new errors_1.Mk2ReadbackError(`${context}: no valid S response`);
                }
                this.log.debug(`${context} S response ->${JSON.stringify(response)}`);
            });
        }
        catch (error) {
            if (error instanceof errors_1.Mk2ReadbackError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new errors_1.Mk2ReadbackError(`${context}: S command unconfirmed; refusing automatic retry: ${message}`);
        }
    }
    requireUnambiguousSwitchState(context) {
        if (!this.hasUnambiguousSwitchState()) {
            throw new errors_1.Mk2ValidationError(`${context}: no unambiguous current F5 switch state; refusing to send S`);
        }
    }
    hasAmbiguousMinimumForPositive(raw) {
        if (raw <= 0)
            return false;
        const limit = this.mk2Model["assist.limit"].value;
        if (typeof limit !== "number" || Math.abs(limit * 10 - raw) > 0.01)
            return false;
        if (this.confirmedInputCurrentSetpoint === 0)
            return true;
        const encoded = this.mk2Model["state.state"].value;
        const mainState = typeof encoded === "number" ? Math.floor(encoded / 10) : null;
        const minimum = this.mk2Model["assist.minlimit"].value;
        return mainState !== null && mainState >= 4 && mainState <= 6
            && typeof minimum === "number" && Math.abs(limit * 10 - minimum * 10) <= 0.01;
    }
    normalizeAssistLimit(ampere, context) {
        if (!Number.isFinite(ampere) || ampere < 0) {
            throw new errors_1.Mk2ValidationError(`${context}: invalid value ${ampere}`);
        }
        if (!this.inputCurrentLimitsValid) {
            throw new errors_1.Mk2ValidationError(`${context}: input-current limits are unavailable in DMC-dedicated mode (§6.2)`);
        }
        if (ampere === 0) {
            this.requirePowerAssistForZeroLimit(context);
        }
        const max = this.mk2Model["assist.maxlimit"].value;
        if (typeof max === "number" && max > 0 && ampere > max) {
            this.log.warn(`${context}: clamping ${ampere} A to ${max} A`);
            ampere = max;
        }
        const min = this.mk2Model["assist.minlimit"].value;
        if (ampere > 0 && typeof min === "number" && min > 0 && ampere < min) {
            this.log.warn(`${context}: clamping ${ampere} A up to the device minimum ${min} A`);
            ampere = min;
        }
        if (ampere > 0 && Math.round(ampere * 10) === 0) {
            this.log.warn(`${context}: clamping ${ampere} A up to the protocol resolution 0.1 A`);
            ampere = 0.1;
        }
        const raw = Math.round(ampere * 10);
        if (raw > 0x7fff) {
            throw new errors_1.Mk2ValidationError(`${context}: ${ampere} A exceeds the protocol range (max 3276.7 A)`);
        }
        return { ampere, raw };
    }
    // Set the ampere level for PowerAssist. explicitMode is used only by
    // grid_mode, which deliberately chooses the outgoing panel state itself.
    async set_assist(ampere, explicitMode = false) {
        const normalized = this.normalizeAssistLimit(ampere, "set_assist");
        ampere = normalized.ampere;
        const a = normalized.raw;
        if (!explicitMode) {
            this.requireUnambiguousSwitchState("set_assist");
        }
        if (this.currentSwitchState == 4) {
            throw new errors_1.Mk2ValidationError("set_assist: device switch is Off; use control.switch_state or control.grid_mode to switch it on explicitly");
        }
        if (ampere > 0 && this.currentSwitchState === 2) {
            this.log.warn("set_assist: a positive limit switches the device from Inverter only to On (charger/AC input enabled)");
        }
        if (ampere === 0 && this.currentSwitchState === 1) {
            this.log.debug("set_assist: 0 A selects Invert with PowerAssist, including from Charger only (§5 note 3)");
        }
        const minimumCollision = this.hasAmbiguousMinimumForPositive(a);
        const data = Buffer.from([this.currentSwitchState, a & 0xFF, (a >> 8) & 0xFF, 0x01, 0x80]);
        this.log.debug("******   set_assist");
        this.confirmedInputCurrentSetpoint = null;
        await this.sendS("set_assist", data);
        if (ampere === 0) {
            await this.waitForSwitchState(data[0] === 2 ? [2] : [2, 3], "set_assist", [4, 5, 6], this.gridModeReadbackTimeoutMs, 0);
        }
        else {
            // Exact raw readback plus an unambiguous panel state. When the old
            // special 0 A setpoint already displays the requested minimum, only a
            // grid main-state transition proves that the positive write applied (#119).
            await this.waitForSwitchState(ampere > 0 && data[0] === 2 ? 3 : data[0], "set_assist", minimumCollision ? [7, 8, 9] : undefined, minimumCollision ? this.gridModeReadbackTimeoutMs : this.switchReadbackTimeoutMs, a);
        }
        const appliedLimit = ampere === 0 ? 0 : this.mk2Model["assist.limit"].value;
        const appliedValue = typeof appliedLimit === "number" ? appliedLimit : ampere;
        this.mk2Model["control.set_assist"].value = appliedValue;
        this.confirmedInputCurrentSetpoint = appliedValue;
        return appliedValue;
    }
    /**
     * Set the VE.Bus switch state. Inverter only deliberately uses the 0 A
     * setpoint required by §5 note 3; On/Charger only restores the configured
     * or current positive limit. Off leaves the limit untouched.
     */
    async set_switch_state(state) {
        if (![1, 2, 3, 4].includes(state)) {
            throw new errors_1.Mk2ValidationError(`set_switch_state: invalid state ${state}`);
        }
        if (state === 2) {
            this.requirePowerAssistForZeroLimit("set_switch_state");
        }
        // Limit >= 0x8000 means "ignore current limit" (protocol §5, variant 2).
        // State 2 must instead carry 0 A: otherwise the request can cancel a
        // temporary zero-grid setpoint and return to On. A persisted 0 A setpoint
        // would make a recovered "On" unit never charge, so for charge-capable
        // states write the known configured (or current) limit instead of "ignore".
        let limit = state === 2 ? 0 : 0xFFFF;
        if (state === 1 || state === 3) {
            const configured = this.mk2Model["setting.IMainsLimitAC1"].value;
            const current = this.mk2Model["assist.limit"].value;
            const value = typeof configured === "number" && configured > 0
                ? configured
                : typeof current === "number" && current > 0 ? current : undefined;
            if (value !== undefined) {
                limit = this.normalizeAssistLimit(value, "set_switch_state").raw;
            }
        }
        if (limit < 0x8000 && !this.inputCurrentLimitsValid) {
            throw new errors_1.Mk2ValidationError("set_switch_state: input-current limit is unavailable in DMC-dedicated mode (§6.2)");
        }
        const data = Buffer.from([state, limit & 0xFF, (limit >> 8) & 0xFF, 0x01, 0x80]);
        const minimumCollision = limit > 0 && limit < 0x8000 && this.hasAmbiguousMinimumForPositive(limit);
        if (limit < 0x8000) {
            this.confirmedInputCurrentSetpoint = null;
        }
        await this.sendS("set_switch_state", data);
        // The S frame is only an acknowledgement. Verify the effective state
        // through bounded W0E/F5 readback; live transitions can take several seconds.
        // State 2 also requires the documented Invert main state, not just panel bits.
        await this.waitForSwitchState(state, "set_switch_state", state === 2 ? [4, 5, 6] : minimumCollision ? (state === 1 ? [8, 9] : [7, 8, 9]) : undefined, state === 2 || minimumCollision ? this.gridModeReadbackTimeoutMs : this.switchReadbackTimeoutMs, limit < 0x8000 ? limit : undefined);
        if (limit < 0x8000) {
            this.confirmedInputCurrentSetpoint = limit / 10;
        }
        return state;
    }
    /**
     * Explicit grid/solar mode.
     * 0 = grid (max input current, switch On)
     * 1 = zero grid / solar inverter (0 A, switch On; PowerAssist an => Invert)
     * 2 = inverter only (switch state 2 + 0 A). Live tests show that switch state
     * 2 with an ignored or nonzero limit does NOT enter Invert while AC is present,
     * so the 0 A limit is required - it is not a substitute for "ignore limit".
     * This 0 A setpoint persists until another limit is written.
     */
    async set_grid_mode(mode) {
        if (![0, 1, 2].includes(mode)) {
            throw new errors_1.Mk2ValidationError(`set_grid_mode: invalid mode ${mode}`);
        }
        if (this.deviceIsOff()) {
            // An explicit mode command may switch the unit on, but say so (review M4).
            this.log.warn("device switch is Off; grid_mode switches it on explicitly");
        }
        if (mode == 1 || mode == 2) {
            this.requirePowerAssistForZeroLimit("set_grid_mode");
        }
        // set_assist carries the switch state in the S frame. Mutate the local
        // cache only for the duration of the write and restore it if the write
        // does not reach/confirm the device; otherwise a failed grid_mode would
        // leave currentSwitchState and every later set_assist on a false state.
        const previousSwitchState = this.currentSwitchState;
        if (mode == 2) {
            this.currentSwitchState = 2;
            try {
                await this.set_assist(0, true);
            }
            catch (error) {
                // The S frame may have reached the device even though the write
                // ultimately failed. Reload the authoritative switch state instead
                // of restoring the pre-write guess.
                await this.reloadSwitchState(previousSwitchState);
                throw error;
            }
            return mode;
        }
        const configured = this.mk2Model["setting.IMainsLimitAC1"].value;
        const current = this.mk2Model["assist.limit"].value;
        const max = this.mk2Model["assist.maxlimit"].value;
        const knownLimit = typeof configured === "number" && configured > 0
            ? configured
            : typeof current === "number" && current > 0 ? current : undefined;
        if (mode == 0 && this.deviceIsOff() && knownLimit === undefined) {
            // Off recovery may run without a full poll. Never turn the unit on with
            // the generic 16 A/device-max fallback when no safe shore limit is known.
            throw new errors_1.Mk2ValidationError("set_grid_mode: Off recovery requires a known AC input limit");
        }
        // Grid mode must not silently raise the shore-current limit: prefer the
        // configured value, then keep the current one, never the device rating
        // just because the configuration is unknown (review N15).
        const limit = mode == 0 ? knownLimit !== null && knownLimit !== void 0 ? knownLimit : (typeof max == "number" && max > 0 ? max : 16) : 0;
        this.currentSwitchState = 3;
        try {
            const applied = await this.set_assist(limit, true);
            if (mode === 0) {
                await this.waitForSwitchState(3, "set_grid_mode", [7, 8, 9], this.gridModeReadbackTimeoutMs, Math.round(applied * 10));
            }
            // Zero-grid is fully validated by set_assist(0): the effective main
            // state must be Invert and the panel may report Inverter only.
        }
        catch (error) {
            await this.reloadSwitchState(previousSwitchState);
            throw error;
        }
        return mode;
    }
    /**
     * Poll W0E/F5 until the requested switch and (when required) main state are
     * visible. Never repeat S and never treat missing/ambiguous readback as success.
     */
    async waitForSwitchState(state, context, expectedMainStates, timeoutMs = this.switchReadbackTimeoutMs, expectedLimitRaw) {
        const expectedSwitches = Array.isArray(state) ? state : [state];
        const deadline = Date.now() + timeoutMs;
        let actual = null;
        let mainState = null;
        let actualLimit = null;
        let minimumLimit = null;
        let limitMatches = expectedLimitRaw === undefined;
        try {
            while (true) {
                // Extended F5 decoding plausibilises its register against the main
                // state. Refresh both, otherwise a stale Bypass state can hide a
                // completed transition to Invert indefinitely.
                await this.get_state();
                await this.master_multi_led_info();
                const encodedMainState = this.mk2Model["state.state"].value;
                mainState = typeof encodedMainState === "number" ? Math.floor(encodedMainState / 10) : null;
                const reported = this.switchStateAmbiguous ? null : this.mk2Model["switch.state"].value;
                if (reported !== null && typeof reported !== "number") {
                    throw new errors_1.Mk2ReadbackError(`${context}: invalid switch-state readback ${String(reported)}`);
                }
                actual = reported;
                const switchMatches = actual !== null && expectedSwitches.includes(actual);
                const mainMatches = expectedMainStates === undefined
                    || (mainState !== null && expectedMainStates.includes(mainState));
                const limitValue = this.mk2Model["assist.limit"].value;
                const minValue = this.mk2Model["assist.minlimit"].value;
                actualLimit = typeof limitValue === "number" ? limitValue : null;
                minimumLimit = typeof minValue === "number" ? minValue : null;
                if (expectedLimitRaw === 0) {
                    limitMatches = actualLimit !== null && minimumLimit !== null && actualLimit <= minimumLimit + 0.01;
                }
                else if (expectedLimitRaw !== undefined) {
                    limitMatches = actualLimit !== null && Math.abs(actualLimit * 10 - expectedLimitRaw) <= 0.01;
                }
                if (actual !== null && switchMatches && mainMatches && limitMatches) {
                    return actual;
                }
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    if (actual === null) {
                        throw new errors_1.Mk2ReadbackError(`${context}: no unambiguous switch-state readback after ${timeoutMs} ms`);
                    }
                    if (!switchMatches) {
                        throw new errors_1.Mk2ReadbackError(`${context}: device reports ${actual} instead of ${expectedSwitches.join("/")} after ${timeoutMs} ms`);
                    }
                    if (!mainMatches) {
                        throw new errors_1.Mk2ReadbackError(`${context}: switch ${actual} reached, but main state is ${String(mainState)} instead of ${expectedMainStates === null || expectedMainStates === void 0 ? void 0 : expectedMainStates.join("/")} after ${timeoutMs} ms`);
                    }
                    if (expectedLimitRaw === 0) {
                        throw new errors_1.Mk2ReadbackError(`${context}: 0 A was not applied (device reports ${String(actualLimit)} A, min ${String(minimumLimit)} A after ${timeoutMs} ms)`);
                    }
                    throw new errors_1.Mk2ReadbackError(`${context}: readback mismatch (wanted ${String(expectedLimitRaw === undefined ? undefined : expectedLimitRaw / 10)} A, device reports ${String(actualLimit)} A after ${timeoutMs} ms)`);
                }
                await new Promise((resolve) => setTimeout(resolve, Math.min(this.switchReadbackPollIntervalMs, remaining)));
            }
        }
        catch (error) {
            if (error instanceof errors_1.Mk2ReadbackError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new errors_1.Mk2ReadbackError(`${context}: readback failed after write acknowledgement: ${message}`);
        }
    }
    /** Off per the panel switch cache or the authoritative main state. */
    deviceIsOff() {
        if (this.currentSwitchState == 4) {
            return true;
        }
        const state = this.mk2Model["state.state"].value;
        return typeof state === "number" && Math.floor(state / 10) === 2;
    }
    /** Re-read F5 after a failed write; fall back to the pre-write value only
     * when the device cannot be asked (transport failure). */
    async reloadSwitchState(fallback) {
        try {
            await this.master_multi_led_info();
        }
        catch (_a) {
            this.currentSwitchState = fallback;
        }
    }
    async force_state(state) {
        this.log.debug("force_state ->" + state);
        if (![1, 2, 3].includes(state)) {
            throw new errors_1.Mk2ValidationError(`force_state: invalid state ${state} (1=equalise, 2=absorption, 3=float)`);
        }
        const version = this.mk2Model["info.device_sw_version"].value;
        if (typeof version === "number" && version > 0 && version % 1000 < 400) {
            throw new errors_1.Mk2ValidationError(`force_state: requires firmware revision xxyy400 or later, device has ${version}`);
        }
        const targetSubState = { 1: 7, 2: 6, 3: 3 }[state];
        const data = Buffer.from([0x0E, state, 0x00]);
        try {
            await this.conn.communicate(this.create_frame("W", data), async (response) => {
                if (response[1] === 0xff && response[2] === 0x57 && response[3] === 0x80) {
                    throw new errors_1.Mk2ValidationError(`force_state: device rejected state ${state} as unsupported`);
                }
                // The first 0x94 response can still contain the old state (§7.3.2).
                this.decodeStateResponse(response, "force_state");
            });
            const deadline = Date.now() + this.forceStateReadbackTimeoutMs;
            while (true) {
                const encoded = this.mk2Model["state.state"].value;
                const subState = this.mk2Model["state.substate"].value;
                if (typeof encoded === "number" && Math.floor(encoded / 10) === 9 && subState === targetSubState) {
                    return state;
                }
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    throw new errors_1.Mk2ReadbackError(`force_state: device reports state ${String(encoded)}/${String(subState)} instead of 9/${targetSubState} after ${this.forceStateReadbackTimeoutMs} ms`);
                }
                await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
                await this.get_state();
            }
        }
        catch (error) {
            if (error instanceof errors_1.Mk2ValidationError || error instanceof errors_1.Mk2ReadbackError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            // W0E may already have reached the device. Never let the queue repeat
            // it merely because confirmation failed or arrived too late.
            throw new errors_1.Mk2ReadbackError(`force_state: readback failed after write acknowledgement: ${message}`);
        }
    }
    /** Read Flags0 (setting 0) as a signed 16-bit value. */
    async readFlags0() {
        const raw = await this.readSetting(0);
        if (raw === null) {
            throw new Error("readFlags0: Flags0 not supported by this device");
        }
        return raw >= 0x8000 ? raw - 0x10000 : raw;
    }
    /**
     * Read a setting (CommandReadSetting, protocol §7.3.4).
     * Returns null when the device answers 0x91 (setting not supported).
     */
    async readSetting(id) {
        let value = null;
        await this.conn.communicate(this.create_frame("W", Buffer.from([0x31, id & 0xFF, (id >> 8) & 0xFF])), async (response) => {
            if (response[1] != 0xff || response[2] != 0x57) {
                throw new Error("readSetting: no valid response");
            }
            // 1909209 may return only 0x91 for an unsupported setting, without
            // the two value bytes present in older responses.
            if (response[3] == 0x91) {
                value = null;
                return;
            }
            if (response[0] < 0x05) {
                throw new Error("readSetting: response too short");
            }
            if (response[3] != 0x86) {
                throw new Error("readSetting: unexpected response 0x" + response[3].toString(16));
            }
            value = bp.unpack("<H", response, 4)[0];
        });
        return value;
    }
    /** Write a setting with CommandWriteSetting + CommandWriteData (§7.3.6/7.3.7). */
    async writeSetting(id, raw) {
        await this.prepareSettingWrite();
        const first_cmd = Buffer.from([0x33, id & 0xFF, (id >> 8) & 0xFF]);
        const second_cmd = Buffer.from([0x34, raw & 0xFF, (raw >> 8) & 0xFF]);
        const frames = Buffer.concat([this.create_frame("W", first_cmd), this.create_frame("W", second_cmd)]);
        return this.conn.communicate(frames, async (response) => {
            if (response[1] === 0xff && response[2] === 0x57 && response[3] === 0x80) {
                const reason = response.length > 5 ? `0x${response[4].toString(16)}` : "unknown";
                throw new errors_1.Mk2ValidationError(`writeSetting(${id}): device rejected the command (0x80, reason ${reason})`);
            }
            // 0x88 is the documented write acknowledgement; 0x87 occurs on some
            // firmware for the first of the two concatenated frames.
            if (response[0] < 0x05 || response[1] != 0xff || response[2] != 0x57
                || (response[3] != 0x88 && response[3] != 0x87)) {
                throw new Error(`writeSetting(${id}): no valid write response`);
            }
        });
    }
    /**
     * Firmware using long Winmon frames (observed on 1909209) rejects the legacy
     * WriteSetting/WriteData sequence. Protocol §5 offers FlagsExt0 bit 0 = 1 to
     * make the MK2 convert long frames to the old short format. The S command
     * keeps both the current switch state and the input limit unchanged.
     */
    async prepareSettingWrite() {
        if (!this.longWinmonFrames || this.shortWinmonForWrites) {
            return;
        }
        this.requireUnambiguousSwitchState("prepareSettingWrite");
        const limit = this.mk2Model["assist.limit"].value;
        const minimum = this.mk2Model["assist.minlimit"].value;
        let rawLimit;
        if (this.currentSwitchState === 2) {
            rawLimit = 0;
        }
        else if (this.currentSwitchState === 4) {
            rawLimit = typeof limit === "number" && limit > 0
                ? this.normalizeAssistLimit(limit, "prepareSettingWrite").raw : 0xFFFF;
        }
        else if (this.confirmedInputCurrentSetpoint !== null) {
            rawLimit = this.confirmedInputCurrentSetpoint === 0 ? 0
                : this.normalizeAssistLimit(this.confirmedInputCurrentSetpoint, "prepareSettingWrite").raw;
        }
        else if (limit === 0) {
            // A cold start/reconnect can still prove special 0 A from F5 + W0E.
            this.requirePowerAssistForZeroLimit("prepareSettingWrite");
            const encoded = this.mk2Model["state.state"].value;
            const mainState = typeof encoded === "number" ? Math.floor(encoded / 10) : null;
            if (mainState === null || mainState < 4 || mainState > 6) {
                throw new errors_1.Mk2ValidationError("prepareSettingWrite: 0 A is visible but the Invert main state is not confirmed");
            }
            rawLimit = 0;
        }
        else if (typeof limit === "number" && limit > 0) {
            if (typeof minimum === "number" && minimum > 0 && Math.abs(limit * 10 - minimum * 10) <= 0.01) {
                throw new errors_1.Mk2ValidationError("prepareSettingWrite: input-current setpoint is unknown (device reports its minimum); refusing the setting write");
            }
            rawLimit = this.normalizeAssistLimit(limit, "prepareSettingWrite").raw;
        }
        else {
            rawLimit = 0xFFFF;
        }
        if (rawLimit < 0x8000 && !this.inputCurrentLimitsValid) {
            throw new errors_1.Mk2ValidationError("prepareSettingWrite: input-current limit is unavailable in DMC-dedicated mode (§6.2)");
        }
        if (rawLimit === 0) {
            this.requirePowerAssistForZeroLimit("prepareSettingWrite");
        }
        const data = Buffer.from([
            this.currentSwitchState, rawLimit & 0xFF, (rawLimit >> 8) & 0xFF, 0x01, 0x80,
            0x00, 0x01,
            // No EEPROM byte: never clear Force-VE.Bus / Block-XMT as a side effect.
        ]);
        await this.sendS("prepareSettingWrite", data);
        await this.waitForSwitchState(this.currentSwitchState, "prepareSettingWrite", rawLimit === 0 ? [4, 5, 6] : undefined, rawLimit === 0 ? this.gridModeReadbackTimeoutMs : this.switchReadbackTimeoutMs, rawLimit < 0x8000 ? rawLimit : undefined);
        this.shortWinmonForWrites = true;
    }
    /** Write Flags0 with CommandWriteSetting + CommandWriteData. */
    async writeFlags0(flags) {
        return this.writeSetting(0, flags & 0xFFFF);
    }
    /**
     * CommandGetSettingInfo (protocol §7.3.8): scale, offset, default, min, max.
     * Answers are cached per connection; unsupported settings are reported with
     * `supported = false` instead of throwing.
     */
    async getSettingInfo(id, force = false) {
        const cached = this.settingInfoCache.get(id);
        if (cached && !force) {
            return cached;
        }
        const collector = new mk2Settings_1.SettingInfoCollector(id, this.longWinmonFrames && !this.shortWinmonForWrites);
        await this.conn.communicateMulti(this.create_frame("W", Buffer.from([0x35, id & 0xFF, (id >> 8) & 0xFF])), async (frame) => collector.addFrame(frame));
        if (!collector.isComplete()) {
            // Anything incomplete leaves min/max unknown and must not authorize a
            // write with made-up limits (review T2). Transport errors propagate.
            throw new Error(`getSettingInfo(${id}): incomplete response, refusing to use it`);
        }
        this.settingInfoCache.set(id, collector.info);
        return collector.info;
    }
    /**
     * Protocol §7.3.13.3: for flag settings the Maximum value is the bitmask of
     * supported flags. Never write a bit the device does not advertise.
     */
    async assertFlagSupported(flagBit) {
        const info = await this.getSettingInfo(0);
        if (!info.supported) {
            throw new Error("Flags0 is not supported by this device");
        }
        if (info.max !== null && (info.max & (1 << flagBit)) === 0) {
            throw new errors_1.Mk2ValidationError(`flag ${flagBit} is not supported by this device (mask 0x${info.max.toString(16)})`);
        }
    }
    /** Read Flags1 (setting 1) and expose the documented bits 27-31. */
    async get_flags1() {
        const raw = await this.readSetting(1);
        for (const def of mk2Settings_1.FLAGS1) {
            this.mk2Model[def.key].value = raw === null ? null : (raw & (1 << (0, mk2Settings_1.flags1Bit)(def.flag))) !== 0;
        }
    }
    /**
     * Read the extended, read-only settings once per connection. They are
     * configuration values, not telemetry, so they do not belong in the 2 s loop.
     */
    async loadExtendedSettings(force = false) {
        if (this.extendedSettingsLoaded && !force) {
            return;
        }
        for (const def of mk2Settings_1.READONLY_SETTINGS) {
            if (this.failedExtendedSettings.has(def.id) && !force) {
                this.mk2Model[def.key].value = null;
                continue;
            }
            try {
                const info = await this.getSettingInfo(def.id);
                if (!info.supported) {
                    this.mk2Model[def.key].value = null;
                    continue;
                }
                const raw = await this.readSetting(def.id);
                this.mk2Model[def.key].value = raw === null ? null : round((0, mk2Settings_1.settingDisplayValue)(info, raw), 3);
            }
            catch (error) {
                // A transport error invalidates the whole poll. Do not negative-cache
                // a setting or reopen the port for later settings in the same poll.
                if (error instanceof errors_1.Mk2TransportError) {
                    throw error;
                }
                // One genuinely broken/unsupported setting must neither block the
                // others nor cause a full reload on every poll (review N9).
                this.log.warn(`setting ${def.key} could not be loaded: ${error instanceof Error ? error.message : error}`);
                this.failedExtendedSettings.add(def.id);
                this.mk2Model[def.key].value = null;
            }
        }
        this.extendedSettingsLoaded = true;
    }
    /**
     * CommandGetRAMVarInfo (protocol §7.3.9) for an arbitrary RAM id, cached per
     * connection. Sc = 0 means the variable is not supported by this firmware.
     */
    async getRamInfo(id) {
        const cached = this.ramInfoCache.get(id);
        if (cached) {
            return cached;
        }
        let sc = 0;
        let offset = 0;
        let seenScale = false;
        let seenOffset = false;
        let complete = false;
        const longMode = this.longWinmonFrames && !this.shortWinmonForWrites;
        await this.conn.communicateMulti(this.create_frame("W", Buffer.from([0x36, id & 0xFF, (id >> 8) & 0xFF])), async (response) => {
            if (response[1] != 0xff || response[2] != 0x57) {
                throw new Error("getRamInfo: not a Winmon response frame");
            }
            // Exact value-free unsupported response observed on 1909209.
            if (response[3] === 0x8e && response[0] < 0x05) {
                if (response[0] === 0x03 && response.length === 5) {
                    sc = 0;
                    seenScale = true;
                    complete = true;
                    return true;
                }
                throw new Error("getRamInfo: incomplete scale response");
            }
            // Mode 2 is flat: 0x8E ScLo ScHi OffsetLo OffsetHi. Only len=8
            // with Offset-Low 0x8F is indistinguishable from a short pair;
            // reject it rather than caching a guessed offset (#107/#115).
            const longResponse = response[3] === 0x8e && response[0] >= 0x07
                && (longMode || (response[0] === 0x07 && response.length === 9));
            if (longResponse) {
                if (longMode && response[0] === 0x08 && response[6] === 0x8f) {
                    throw new Error("getRamInfo: ambiguous short-pair/long+trailer response");
                }
                const rawSc = response[4] | (response[5] << 8);
                const rawOffset = response[6] | (response[7] << 8);
                sc = rawSc >= 0x8000 ? rawSc - 0x10000 : rawSc;
                offset = rawOffset >= 0x8000 ? rawOffset - 0x10000 : rawOffset;
                seenScale = true;
                seenOffset = true;
                complete = true;
                return true;
            }
            // Legacy responses consist of 0x8E/0x8F W-frame triplets and may
            // be split over multiple MK2 frames (#107).
            for (let i = 3; i + 2 < response.length; i += 3) {
                const cmd = response[i];
                const value = response[i + 1] | (response[i + 2] << 8);
                const signed = value >= 0x8000 ? value - 0x10000 : value;
                if (cmd === 0x8e) {
                    sc = signed;
                    seenScale = true;
                }
                else if (cmd === 0x8f) {
                    offset = signed;
                    seenOffset = true;
                }
            }
            if (!seenScale) {
                throw new Error("getRamInfo: response carries no scale");
            }
            // Only Sc=0 permits omission of the Offset response (§7.3.9).
            complete = sc === 0 || seenOffset;
            return complete;
        });
        if (!complete || !seenScale || (sc !== 0 && !seenOffset)) {
            throw new Error(`getRamInfo(${id}): incomplete response, refusing to cache it`);
        }
        const info = (0, mk2Ram_1.makeRamInfo)(id, sc, offset);
        this.ramInfoCache.set(id, info);
        return info;
    }
    /**
     * CommandReadRAMVar (protocol §7.3.3), one id per request. Returns null when
     * the firmware does not offer the variable; such ids are not polled again.
     */
    async readRamVar(id) {
        if (this.unsupportedRam.has(id)) {
            return null;
        }
        const info = await this.getRamInfo(id);
        if (!info.supported) {
            this.unsupportedRam.add(id);
            return null;
        }
        let raw = null;
        let unsupported = false;
        await this.conn.communicate(this.create_frame("W", Buffer.from([0x30, id & 0xFF, (id >> 8) & 0xFF])), async (response) => {
            if (response[0] < 0x05 || response[1] != 0xff || response[2] != 0x57) {
                throw new Error("readRamVar: no valid response");
            }
            if (response[3] == 0x90) {
                unsupported = true;
                return;
            }
            if (response[3] != 0x85) {
                throw new Error("readRamVar: unexpected response 0x" + response[3].toString(16));
            }
            raw = bp.unpack("<H", response, 4)[0];
        });
        if (unsupported || raw === null) {
            this.unsupportedRam.add(id);
            return null;
        }
        return round((0, mk2Ram_1.ramDisplayValue)(info, raw), 3);
    }
    /** Filtered power values and the internal battery monitor SOC (§7.3.13.1). */
    async readRamTelemetry() {
        const telemetry = [
            { id: 14, key: "power.inverter" },
            { id: 16, key: "power.output" },
            { id: 13, key: "battery.soc" },
        ];
        for (const def of telemetry) {
            this.mk2Model[def.key].value = await this.readRamVar(def.id);
        }
    }
    /**
     * Device identification: MK2 version/mode come from the version frame, the
     * MultiPlus firmware from CommandSendSoftwareVersion (§7.3.1). Read once per
     * connection; these values do not change while the device is running.
     */
    async loadDeviceInfo(force = false) {
        if (this.deviceInfoLoaded && !force) {
            return;
        }
        this.mk2Model["info.mk2_version"].value = this.conn.mk2Version;
        this.mk2Model["info.mk2_mode"].value = this.conn.mk2Mode;
        const version = await this.readDeviceVersion();
        if (version !== null) {
            this.mk2Model["info.device_sw_version"].value = version;
            this.mk2Model["info.device_sw_version_text"].value = (0, mk2Ram_1.formatDeviceVersion)(version);
        }
        this.deviceInfoLoaded = true;
    }
    /**
     * Read the 32-bit device version (protocol §7.3.1). Newer firmware answers
     * command 0x05 with a long Winmon frame containing both 16-bit parts. In
     * that case the legacy 0x06 request is not supported and must not be sent.
     */
    async readDeviceVersion() {
        let part0 = null;
        let part1 = null;
        await this.conn.communicate(this.create_frame("W", Buffer.from([0x05, 0x00, 0x00])), async (response) => {
            if (response[0] < 0x05 || response[1] != 0xff || response[2] != 0x57 || response[3] != 0x82) {
                throw new Error("readDeviceVersion 0x05: no valid response");
            }
            part0 = bp.unpack("<H", response, 4)[0];
            // Long response: 0x82 <LoPart0> <HiPart0> <LoPart1> <HiPart1> XX XX.
            this.longWinmonFrames = response[0] >= 0x09 && response.length >= 11;
            if (this.longWinmonFrames) {
                part1 = bp.unpack("<H", response, 6)[0];
            }
        });
        if (part0 === null) {
            return null;
        }
        if (part1 === null) {
            part1 = await this.readDeviceVersionPart(0x06, 0x83);
        }
        return part1 === null ? null : ((part1 << 16) | part0) >>> 0;
    }
    async readDeviceVersionPart(command, expected) {
        let part = null;
        await this.conn.communicate(this.create_frame("W", Buffer.from([command, 0x00, 0x00])), async (response) => {
            if (response[3] === 0x80) {
                // Mode-2 firmware answers unknown commands with 0x80 <reason>.
                // Identification is diagnostic; do not fail the whole poll.
                return;
            }
            if (response[0] < 0x05 || response[1] != 0xff || response[2] != 0x57 || response[3] != expected) {
                throw new Error(`readDeviceVersionPart 0x${command.toString(16)}: no valid response`);
            }
            part = bp.unpack("<H", response, 4)[0];
        });
        return part;
    }
    async get_flags() {
        this.log.debug("******   get_flags");
        const flags = await this.readFlags0();
        // Bits 9, 10 and 12 are "not promoted options" and stay untouched.
        for (const [bit, key] of Object.entries(FLAGS0_KEYS)) {
            this.mk2Model[key].value = (flags & (1 << parseInt(bit))) !== 0;
        }
        // Protocol §7.3.13.3: flags[7] must be the inverse of flags[3].
        const waveCheck = (flags & (1 << 3)) !== 0;
        const waveCheckInverted = (flags & (1 << 7)) !== 0;
        if (waveCheck === waveCheckInverted) {
            this.log.warn("Flags0 bit 3 and bit 7 are not inverted (wave check); device configuration is inconsistent");
        }
    }
    async set_flagDisableCharge(value) {
        return this.setFlags0Bit(6, value, "DisableCharge");
    }
    async set_flagWeakACInput(value) {
        return this.setFlags0Bit(14, value, "WeakACInput");
    }
    async set_flagDisableAES(value) {
        return this.setFlags0Bit(8, value, "DisableAES");
    }
    async set_flagAssistEnabled(value) {
        return this.setFlags0Bit(5, value, "AssistEnabled");
    }
    /**
     * Read-modify-write for one Flags0 bit: validate against the device support
     * mask, write, then read the register back and warn on a mismatch.
     */
    async setFlags0Bit(bit, value, name) {
        if (value !== 0 && value !== 1) {
            throw new errors_1.Mk2ValidationError(`${name}: value must be 0 or 1 (got ${value})`);
        }
        await this.assertFlagSupported(bit);
        const mask = 1 << bit;
        const flags = await this.readFlags0();
        const next = value == 1 ? flags | mask : flags & ~mask;
        if (next === flags) {
            // Nothing to change: do not spend an EEPROM write, but still publish
            // the fresh authoritative register read.
            const flagKey = FLAGS0_KEYS[bit];
            if (flagKey)
                this.mk2Model[flagKey].value = (flags & mask) !== 0;
            this.log.debug(`${name}: already ${value}, no write needed`);
            return value;
        }
        await this.writeFlags0(next);
        const readback = await this.readFlags0();
        if (((readback & mask) !== 0) !== (value == 1)) {
            throw new errors_1.Mk2ReadbackError(`${name}: readback mismatch after write (wanted ${value})`);
        }
        const flagKey = FLAGS0_KEYS[bit];
        if (flagKey)
            this.mk2Model[flagKey].value = (readback & mask) !== 0;
        return value;
    }
    /** Same pattern for Flags1 (global flag numbers 16-31, setting id 1). */
    async setFlags1Bit(flag, value, name) {
        if (value !== 0 && value !== 1) {
            throw new errors_1.Mk2ValidationError(`${name}: value must be 0 or 1 (got ${value})`);
        }
        const bit = (0, mk2Settings_1.flags1Bit)(flag);
        const info = await this.getSettingInfo(1);
        if (!info.supported) {
            throw new errors_1.Mk2ValidationError("Flags1 is not supported by this device");
        }
        if (info.max !== null && (info.max & (1 << bit)) === 0) {
            throw new errors_1.Mk2ValidationError(`${name}: flag ${flag} is not supported by this device`);
        }
        const mask = 1 << bit;
        const flags = await this.readSetting(1);
        if (flags === null) {
            // Never read-modify-write from an assumed zero: that would clear every
            // unrelated Flags1 option on the device (review T11).
            throw new errors_1.Mk2ValidationError(`${name}: Flags1 register could not be read, refusing to write`);
        }
        const next = value == 1 ? flags | mask : flags & ~mask;
        if (next === flags) {
            const def = mk2Settings_1.FLAGS1.find((d) => d.flag === flag);
            if (def)
                this.mk2Model[def.key].value = (flags & mask) !== 0;
            this.log.debug(`${name}: already ${value}, no write needed`);
            return value;
        }
        await this.writeSetting(1, next);
        const readback = await this.readSetting(1);
        if (readback === null) {
            throw new errors_1.Mk2ReadbackError(`${name}: no Flags1 readback after write`);
        }
        if (((readback & mask) !== 0) !== (value == 1)) {
            throw new errors_1.Mk2ReadbackError(`${name}: readback mismatch after write (wanted ${value})`);
        }
        const def = mk2Settings_1.FLAGS1.find((d) => d.flag === flag);
        if (def)
            this.mk2Model[def.key].value = (readback & mask) !== 0;
        return value;
    }
    async set_flagDynamicCurrentLimiter(value) {
        return this.setFlags1Bit(28, value, "DynamicCurrentLimiter");
    }
    /**
     * Write a scaled setting (charge voltages, AC input limits) using the device
     * metadata: display -> raw conversion, device min/max validation, write and
     * readback. Also refreshes the read-only setting state.
     */
    async setSettingScaled(id, value, name) {
        var _a, _b;
        if (!Number.isFinite(value)) {
            throw new errors_1.Mk2ValidationError(`${name}: invalid value ${value}`);
        }
        const info = await this.getSettingInfo(id);
        if (!info.supported) {
            throw new errors_1.Mk2ValidationError(`${name}: not supported by this device`);
        }
        const raw = (0, mk2Settings_1.settingRawValue)(info, value);
        const min = (_a = info.min) !== null && _a !== void 0 ? _a : 0;
        const max = (_b = info.max) !== null && _b !== void 0 ? _b : 0xffff;
        if (raw < min || raw > max) {
            throw new errors_1.Mk2ValidationError(`${name}: ${value} is out of the device range (raw ${min}-${max})`);
        }
        const current = await this.readSetting(id);
        const def = mk2Settings_1.READONLY_SETTINGS.find((d) => d.id === id);
        if (current === null) {
            throw new errors_1.Mk2ValidationError(`${name}: setting could not be read before writing (0x91), refusing W33/W34`);
        }
        if (current === raw) {
            this.log.debug(`${name}: already ${value}, no EEPROM write needed`);
            // The previous write may have landed while its readback failed;
            // refresh the published value from the value we just read.
            const applied = round((0, mk2Settings_1.settingDisplayValue)(info, current), 3);
            if (def)
                this.mk2Model[def.key].value = applied;
            return applied;
        }
        await this.writeSetting(id, raw);
        let readback = await this.readSetting(id);
        if (readback !== raw) {
            // The write may have been applied even though the first readback
            // failed. Re-read once so the published value is not stale.
            try {
                const retry = await this.readSetting(id);
                if (retry !== null)
                    readback = retry;
            }
            catch (_c) {
                // transport failure: the caller retries, the read-before-write
                // guard prevents a second EEPROM write
            }
            if (readback === null) {
                throw new errors_1.Mk2ReadbackError(`${name}: no readback after write`);
            }
            if (readback !== raw) {
                throw new errors_1.Mk2ReadbackError(`${name}: readback mismatch (wrote raw ${raw}, device reports ${readback})`);
            }
        }
        const applied = round((0, mk2Settings_1.settingDisplayValue)(info, readback), 3);
        if (def) {
            this.mk2Model[def.key].value = applied;
        }
        // Acknowledge the quantized value the device holds, not the raw request.
        return applied;
    }
    async set_UBatAbsorption(value) {
        return this.setSettingScaled(2, value, "UBatAbsorption");
    }
    async set_UBatFloat(value) {
        return this.setSettingScaled(3, value, "UBatFloat");
    }
    async set_IMainsLimitAC1(value) {
        return this.setSettingScaled(6, value, "IMainsLimitAC1");
    }
    async get_setting_IBatBulk() {
        this.log.debug("******   get_setting_IBatBulk");
        const info = await this.getSettingInfo(4);
        const raw = await this.readSetting(4);
        this.mk2Model["setting.IBatBulk"].value =
            raw === null || !info.supported ? null : round((0, mk2Settings_1.settingDisplayValue)(info, raw), 2);
    }
    async set_setting_IBatBulk(value) {
        var _a, _b;
        this.log.debug("******   set_setting_IBatBulk value: " + value);
        if (!Number.isInteger(value)) {
            throw new errors_1.Mk2ValidationError(`IBatBulk must be an integer (got ${value})`);
        }
        const info = await this.getSettingInfo(4);
        if (!info.supported) {
            throw new errors_1.Mk2ValidationError("IBatBulk is not supported by this device");
        }
        // Device limits come from GetSettingInfo; 0-120 A is only the fallback for
        // firmware that does not report them.
        const raw = (0, mk2Settings_1.settingRawValue)(info, value);
        const min = (_a = info.min) !== null && _a !== void 0 ? _a : 0;
        const max = (_b = info.max) !== null && _b !== void 0 ? _b : 120;
        if (raw < min || raw > max) {
            throw new errors_1.Mk2ValidationError(`IBatBulk must be between ${min} and ${max} (got ${value})`);
        }
        const current = await this.readSetting(4);
        if (current === null) {
            throw new errors_1.Mk2ValidationError("IBatBulk: setting could not be read before writing (0x91), refusing W33/W34");
        }
        if (current === raw) {
            const applied = round((0, mk2Settings_1.settingDisplayValue)(info, current), 2);
            this.mk2Model["setting.IBatBulk"].value = applied;
            this.log.debug(`IBatBulk: already ${applied}, no EEPROM write needed`);
            return applied;
        }
        await this.writeSetting(4, raw);
        const readback = await this.readSetting(4);
        if (readback === null) {
            throw new errors_1.Mk2ReadbackError("IBatBulk: no readback after write");
        }
        if (readback !== raw) {
            throw new errors_1.Mk2ReadbackError(`IBatBulk: readback mismatch (wrote raw ${raw}, device reports ${readback})`);
        }
        this.mk2Model["setting.IBatBulk"].value = round((0, mk2Settings_1.settingDisplayValue)(info, readback), 2);
        return this.mk2Model["setting.IBatBulk"].value;
    }
}
exports.Mk2Protocol = Mk2Protocol;
/** RAM ids whose scale/offset the DC/AC frames need (protocol §7.3.9). */
Mk2Protocol.RAM_SCALINGS = [
    { id: 0, field: "umains_calc" },
    { id: 1, field: "imains_calc" },
    { id: 2, field: "uinv_calc" },
    { id: 3, field: "iinv_calc" },
    { id: 4, field: "ubat_calc" },
    { id: 5, field: "ibat_calc" },
    { id: 7, field: "finv_calc" },
    { id: 8, field: "fmains_calc" },
];
//# sourceMappingURL=mk2Protocol.js.map