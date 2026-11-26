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
exports.splitIdFromAdapter = splitIdFromAdapter;
const utils = __importStar(require("@iobroker/adapter-core"));
const mk2Protocol_1 = require("./mk2/mk2Protocol");
const state_gate_1 = require("./lib/state-gate");
const control_rules_1 = require("./lib/control-rules");
const send_queue_1 = require("./lib/send-queue");
const mk2Settings_1 = require("./mk2/mk2Settings");
const state_objects_1 = require("./lib/state-objects");
const publish_1 = require("./lib/publish");
const poll_loop_1 = require("./lib/poll-loop");
function splitIdFromAdapter(str) {
    const delimiter = ".";
    const start = 2;
    const tokens = str.split(delimiter).slice(start);
    return tokens.join(delimiter);
}
class VictronMk2 extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "victron-mk2",
        });
        this.toSendQueue = [];
        this.assistLimitObjectSignature = null;
        this.settingObjectBounds = new Map();
        this.started = false;
        this.unloading = false;
        this.staleControlsChecked = false;
        /** True once a full poll has read the control-relevant values from the device. */
        this.modelPopulated = false;
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    async onReady() {
        try {
            await this.startAdapter();
        }
        catch (error) {
            // Never leave an unhandled rejection or a crash/restart loop (N1).
            this.started = false;
            const message = error instanceof Error ? error.message : String(error);
            this.log.error("onReady failed: " + message);
            try {
                await this.setStateAsync("info.connection", { val: false, ack: true });
            }
            catch (_a) {
                // even the state write may fail in this situation
            }
        }
    }
    async startAdapter() {
        // A second ready event must not replace a live protocol instance and
        // open a second connection to the same port.
        if (this.started) {
            this.log.debug("adapter already started; ignoring duplicate ready event");
            return;
        }
        this.started = true;
        const interval = Number(this.config.interval);
        this.config.interval = Number.isFinite(interval) && interval >= 1 && interval <= 3600 ? interval : 2;
        this.log.info("config interval: " + this.config.interval);
        this.log.info("config portPath: " + this.config.portPath);
        this.mk2 = new mk2Protocol_1.Mk2Protocol(this.config.portPath, this.log);
        const responseTimeout = Number(this.config.responseTimeout);
        if (Number.isFinite(responseTimeout) && responseTimeout >= 250) {
            this.mk2.conn.responseTimeoutMs = responseTimeout;
            this.log.info("config responseTimeout: " + responseTimeout + " ms");
        }
        // Create the objects even without a configured port and report "not
        // connected", instead of leaving no state at all (review N6).
        await this.initObjects();
        // Nothing is connected yet at startup; never keep a persisted true (N2).
        await this.setStateAsync("info.connection", { val: false, ack: true });
        if (!this.config.portPath) {
            this.log.error("config portPath is empty; adapter will not poll until it is configured");
            await this.setStateAsync("info.connection", { val: false, ack: true });
            return;
        }
        this.mainLoop();
        this.subscribeStates("control.*");
    }
    async onUnload(callback) {
        var _a, _b, _c;
        this.unloading = true;
        // Cancel new I/O and wake receive loops before waiting for the active
        // iteration. No state from that iteration may leak past the callback (#122).
        (_a = this.mk2) === null || _a === void 0 ? void 0 : _a.conn.beginShutdown();
        if (this.pollLoop) {
            await this.pollLoop.stop(3000);
        }
        // Even after the poll-loop timeout, wait for an in-flight serial
        // exchange before closing the port.
        try {
            await ((_b = this.mk2) === null || _b === void 0 ? void 0 : _b.conn.waitForIdle());
        }
        catch (_d) {
            // best effort
        }
        this.started = false;
        try {
            await ((_c = this.mk2) === null || _c === void 0 ? void 0 : _c.conn.shutdown());
        }
        catch (_e) {
            // ignore close errors during shutdown
        }
        callback();
    }
    /**
     * Create the channel/folder structure below the instance so that states are
     * always the last level. Existing objects are left untouched.
     */
    async initChannels() {
        var _a;
        if (!this.mk2)
            return;
        const names = {
            info: "Information",
            diag: "Diagnostics",
            power: "Power",
            battery: "Battery",
            dc_info: "DC information",
            ac_info: "AC information",
            switch: "Switch states",
            state: "Device state",
            led: "LEDs",
            setting: "Settings",
            "setting.flag": "Flags",
            control: "Controls",
            assist: "Assist limits",
        };
        const prefixes = new Set();
        for (const key of Object.keys(this.mk2.mk2Model)) {
            const parts = key.split(".");
            for (let i = 1; i < parts.length; i++) {
                prefixes.add(parts.slice(0, i).join("."));
            }
        }
        for (const id of prefixes) {
            const type = id.includes(".") ? "folder" : "channel";
            await this.setObjectNotExistsAsync(id, {
                type,
                common: { name: (_a = names[id]) !== null && _a !== void 0 ? _a : id },
                native: {},
            });
        }
    }
    async initObjects() {
        if (!this.mk2)
            return;
        await this.initChannels();
        for (const [key, value] of Object.entries(this.mk2.mk2Model)) {
            const object = (0, state_objects_1.buildStateObject)(key, value);
            const existing = await this.getObjectAsync(key);
            // control.set_assist gets its device-specific min/max/def after the
            // first poll. Preserve those fields on restart; otherwise the static
            // model definition would look changed on every start and extend the
            // object unnecessarily (or drop its limits with a replacing merge).
            if ((existing === null || existing === void 0 ? void 0 : existing.common) && (key === "control.set_assist"
                || key === "control.IMainsLimitAC1"
                || key === "control.UBatAbsorption"
                || key === "control.UBatFloat"
                || key === "control.IBatBulk")) {
                // These bounds are discovered from the device after the first
                // poll. Preserve them on restart; otherwise every start would
                // look like a definition change and could drop the limits.
                object.common.min = existing.common.min;
                object.common.max = existing.common.max;
                object.common.def = existing.common.def;
            }
            if (!existing) {
                await this.setObjectNotExistsAsync(key, object);
            }
            else if ((0, state_objects_1.objectDefinitionChanged)(existing, object)) {
                // Upgrade roles/descriptions/units/state maps on existing objects;
                // extendObject keeps user customisation such as InfluxDB history.
                await this.extendObjectAsync(key, object);
            }
        }
    }
    /** Keep control.set_assist's limits in sync with the discovered device. */
    async updateAssistLimitObject() {
        if (!this.mk2 || this.unloading)
            return;
        const max = this.mk2.mk2Model["assist.maxlimit"].value;
        if (typeof max != "number" || max <= 0)
            return;
        const configured = this.mk2.mk2Model["setting.IMainsLimitAC1"].value;
        const def = typeof configured === "number" && Number.isFinite(configured) && configured >= 0 ? configured : null;
        const signature = `${max}:${String(def)}`;
        if (signature === this.assistLimitObjectSignature)
            return;
        await this.extendObjectAsync("control.set_assist", {
            // Unknown configuration must never turn "reset to default" into a
            // request for the device maximum (#118).
            common: { min: 0, max, def },
        });
        this.assistLimitObjectSignature = signature;
    }
    mainLoop() {
        // Idempotent: a second ready event must never orphan a running loop (N8).
        if (this.pollLoop) {
            return;
        }
        this.pollLoop = new poll_loop_1.PollLoop(() => this.updateStates(), this.config.interval * 1000);
        this.pollLoop.start(10 * 1000);
    }
    async updateStates() {
        var _a;
        const mk2 = this.mk2;
        if (!mk2)
            return;
        try {
            // Read-only state poll first. While the MultiPlus is booting, no
            // control command or full poll is sent. Off is handled separately below.
            await mk2.pollStateOnly();
            // Publish the state poll as well: an Off or a boot loop must be visible
            // in ioBroker and to the watchdog, not just the last stable state.
            // info.connection is published from the model, so there is exactly one
            // writer and a failed full poll cannot be masked by a direct setState.
            await this.publishStates(["state.state", "state.substate", "info.address", "info.connection"]);
            const state = mk2.mk2Model["state.state"].value;
            if (!(0, state_gate_1.isStableState)(state)) {
                this.log.debug("MultiPlus not stable yet (state " + state + "), deferring control writes");
                return;
            }
            if (typeof state === "number" && Math.floor(state / 10) === 2) {
                // Off must not become a one-way state (review H2): only explicit
                // power-on controls are forwarded. A full poll is neither needed nor
                // a safe prerequisite here; on affected firmware its commands can
                // time out while Off and would otherwise block recovery forever (#83).
                const offDropped = this.toSendQueue.filter((item) => !(0, state_gate_1.controlAllowedWhileOff)(item.name));
                this.toSendQueue = this.toSendQueue.filter((item) => (0, state_gate_1.controlAllowedWhileOff)(item.name));
                for (const item of offDropped) {
                    const reason = "device is Off: only switch_state/grid_mode writes are allowed";
                    this.log.warn(`${item.name}: ${reason}`);
                    (0, send_queue_1.reportControlError)(mk2, item, reason);
                    await this.reconcileDroppedControl(item);
                }
                const hadPowerOnRequest = this.toSendQueue.length > 0;
                const needsPowerAssist = this.toSendQueue.some((item) => (item.name === "control.grid_mode" && (item.value === 1 || item.value === 2))
                    || (item.name === "control.switch_state" && item.value === 2));
                if (needsPowerAssist) {
                    // Grid modes 1/2 and direct switch 2 need AssistEnabled for 0 A validation.
                    // Read just Flags0 instead of restoring the full-poll dependency.
                    await mk2.get_flags();
                }
                await this.processToSendQueue();
                if (this.modelPopulated) {
                    await this.publishStates();
                }
                else {
                    await this.publishBeforeFirstFullPoll(hadPowerOnRequest, needsPowerAssist);
                }
                await this.reconcileStaleControls();
                return;
            }
            // Outside Off, control writes depend on flags and extended settings
            // loaded by the full poll (e.g. the 0 A guard reads Flags0).
            await mk2.poll();
            if (mk2.mk2Model["info.connection"].value === false) {
                this.log.warn("full poll failed; deferring control writes to the next cycle");
                // A failed poll is a hard boundary for serial I/O. In particular,
                // updateSettingObjects() must not reopen the port for metadata reads.
                if (this.modelPopulated) {
                    await this.publishStates();
                }
                else {
                    await this.publishBeforeFirstFullPoll();
                }
                return;
            }
            this.modelPopulated = true;
            await this.processToSendQueue();
            await this.publishStates();
            await this.reconcileStaleControls();
            await this.updateAssistLimitObject();
            await this.updateSettingObjects();
        }
        catch (Exception) {
            if (this.unloading) {
                this.log.debug("poll/control iteration cancelled during unload");
                return;
            }
            // JSON.stringify(Error) yields "{}", so log the message and stack.
            const message = Exception instanceof Error ? ((_a = Exception.stack) !== null && _a !== void 0 ? _a : Exception.message) : JSON.stringify(Exception);
            this.log.error("ERROR updateStates : " + message);
            // Keep the model as the single source of truth so a later successful
            // poll republishes info.connection as true (#77).
            try {
                mk2.mk2Model["info.connection"].value = false;
                await this.publishStates([
                    "info.connection",
                    "diag.timeouts",
                    "diag.checksum_errors",
                    "diag.last_error",
                    "diag.protocol_errors",
                    "diag.sync_errors",
                ]);
            }
            catch (_b) {
                // ignore secondary state errors while handling a failure
            }
        }
    }
    async publishStates(only) {
        if (!this.mk2 || this.unloading)
            return;
        await (0, publish_1.publishModel)(this.mk2.mk2Model, async (key, value) => {
            await this.setStateAsync(key, { val: value, ack: true });
        }, only);
    }
    /** Publish only values actually known before the first successful full poll. */
    async publishBeforeFirstFullPoll(includeSwitchAndAssist = false, includeFlags = false) {
        if (!this.mk2)
            return;
        const keys = [
            "state.state",
            "state.substate",
            "info.address",
            "info.connection",
            "diag.timeouts",
            "diag.checksum_errors",
            "diag.last_error",
            "diag.protocol_errors",
            "diag.sync_errors",
            "diag.last_control_error",
        ];
        const modelKeys = Object.keys(this.mk2.mk2Model);
        if (includeSwitchAndAssist) {
            keys.push(...modelKeys.filter((key) => key.startsWith("switch.") || key.startsWith("assist.")));
        }
        if (includeFlags) {
            keys.push(...modelKeys.filter((key) => key.startsWith("setting.flag.")));
        }
        await this.publishStates(keys);
    }
    async processToSendQueue() {
        var _a;
        if (!this.mk2 || this.unloading)
            return;
        const result = await (0, send_queue_1.processControlWritesDetailed)(this.mk2, this.toSendQueue, this.log);
        if (this.unloading)
            return;
        for (const item of result.completed) {
            // Acknowledge successful writes; ack=true is never forwarded again, so
            // this cannot retrigger the control path (review T7).
            await this.setStateAsync(item.name, { val: item.value, ack: true });
            // grid_mode also writes an input-current setpoint. Mirror it into the
            // control.set_assist command state; otherwise that state keeps an old
            // value (e.g. 0 A) while the device is actually at 16 A.
            if (item.name === "control.grid_mode" && this.mk2) {
                const setpoint = (_a = this.mk2.mk2Model["control.set_assist"]) === null || _a === void 0 ? void 0 : _a.value;
                if (typeof setpoint === "number") {
                    await this.setStateAsync("control.set_assist", { val: setpoint, ack: true });
                }
            }
        }
        for (const item of result.dropped) {
            await this.reconcileDroppedControl(item);
        }
    }
    async reconcileDroppedControl(item) {
        if (this.unloading)
            return;
        // Restore only a proven actual value. In particular, an F5 minimum in
        // special 0 A mode must not acknowledge the failed positive request (#119).
        const actual = this.actualControlValue(item.name);
        if (actual === undefined)
            return;
        const current = await this.getStateAsync(item.name);
        if (current && current.ack === false && current.val === item.value) {
            await this.setStateAsync(item.name, { val: actual, ack: true });
        }
    }
    /**
     * Commands written with ack=false while the adapter was down are not
     * replayed (too dangerous after an arbitrary delay). Reset them once to the
     * device's actual value so they do not look like the current setting.
     */
    async reconcileStaleControls() {
        if (this.staleControlsChecked || !this.modelPopulated || this.unloading)
            return;
        this.staleControlsChecked = true;
        for (const id of control_rules_1.CONTROL_STATE_IDS) {
            const state = await this.getStateAsync(id);
            if (!state || state.ack !== false)
                continue;
            this.log.warn(`control ${id} was written while the adapter was down; not replaying it`);
            const actual = this.actualControlValue(id);
            if (actual !== undefined) {
                await this.setStateAsync(id, { val: actual, ack: true });
            }
        }
    }
    /** Publish device min/max on the scaled control objects, once per change. */
    async updateSettingObjects() {
        if (!this.mk2 || this.unloading)
            return;
        const targets = [
            [6, "control.IMainsLimitAC1"],
            [2, "control.UBatAbsorption"],
            [3, "control.UBatFloat"],
            [4, "control.IBatBulk"],
        ];
        for (const [id, key] of targets) {
            let info;
            try {
                info = await this.mk2.getSettingInfo(id);
            }
            catch (_a) {
                continue;
            }
            if (!info.supported || info.min === null || info.max === null)
                continue;
            const min = Math.round((0, mk2Settings_1.settingDisplayValue)(info, info.min) * 1000) / 1000;
            const max = Math.round((0, mk2Settings_1.settingDisplayValue)(info, info.max) * 1000) / 1000;
            const signature = `${min}:${max}`;
            if (this.settingObjectBounds.get(key) === signature)
                continue;
            await this.extendObjectAsync(key, { common: { min, max } });
            this.settingObjectBounds.set(key, signature);
        }
    }
    /** Device value that corresponds to a control command state, if known. */
    actualControlValue(name) {
        // Before the first full poll the model still holds static defaults, not
        // device values; publishing them as "actual" would fabricate a setting.
        if (!this.modelPopulated)
            return undefined;
        if (!this.mk2)
            return undefined;
        const model = this.mk2.mk2Model;
        const num = (key) => {
            var _a;
            const value = (_a = model[key]) === null || _a === void 0 ? void 0 : _a.value;
            return typeof value === "number" ? value : undefined;
        };
        const flag = (key) => {
            var _a;
            const value = (_a = model[key]) === null || _a === void 0 ? void 0 : _a.value;
            return typeof value === "boolean" ? (value ? 1 : 0) : undefined;
        };
        switch (name) {
            case "control.set_assist": return this.mk2.getReconciledAssistSetpoint();
            case "control.switch_state": return this.mk2.hasUnambiguousSwitchState() ? num("switch.state") : undefined;
            case "control.force_state": {
                const encodedState = num("state.state");
                const subState = num("state.substate");
                if (encodedState === undefined || subState === undefined)
                    return undefined;
                if (Math.floor(encodedState / 10) !== 9)
                    return 0;
                // Device charge sub-states differ from the public command values.
                return subState === 7 ? 1 : subState === 6 ? 2 : subState === 3 ? 3 : 0;
            }
            case "control.grid_mode": {
                if (!this.mk2.hasUnambiguousSwitchState())
                    return undefined;
                const switchState = num("switch.state");
                const limit = num("assist.limit");
                const encodedState = num("state.state");
                const mainState = encodedState === undefined ? undefined : Math.floor(encodedState / 10);
                if (switchState === 2)
                    return 2;
                if (switchState === undefined || limit === undefined)
                    return undefined;
                if (mainState !== undefined && mainState >= 4 && mainState <= 6
                    && (limit === 0 || this.mk2.getConfirmedInputCurrentSetpoint() === 0))
                    return 1;
                if (mainState !== undefined && mainState >= 7 && mainState <= 9)
                    return 0;
                return undefined;
            }
            case "control.IBatBulk": return num("setting.IBatBulk");
            case "control.UBatAbsorption": return num("setting.UBatAbsorption");
            case "control.UBatFloat": return num("setting.UBatFloat");
            case "control.IMainsLimitAC1": return num("setting.IMainsLimitAC1");
            case "control.DisableCharge": return flag("setting.flag.DisableCharge");
            case "control.WeakACInput": return flag("setting.flag.WeakACInput");
            case "control.DisableAES": return flag("setting.flag.DisableAES");
            case "control.AssistEnabled": return flag("setting.flag.AssistEnabled");
            case "control.DynamicCurrentLimiter": return flag("setting.flag.DynamicCurrentLimiter");
            default: return undefined;
        }
    }
    onStateChange(id, state) {
        if (!state) {
            this.log.info(`state ${id} deleted`);
            return;
        }
        const idShort = splitIdFromAdapter(id);
        if ((0, control_rules_1.shouldHandleControlState)(idShort, state) && this.mk2) {
            this.log.debug(`control ${id} -> MK2 value ${state.val}`);
            this.toSendQueue.push({
                name: idShort,
                value: state.val,
                attempts: 0,
                ts: Date.now(),
            });
            return;
        }
        if (!control_rules_1.CONTROL_STATE_IDS.has(idShort))
            return;
        if (state.ack !== false)
            return;
        // A control state written as a string used to be a completely silent
        // no-op. Say why it was ignored.
        if (typeof state.val !== "number") {
            this.log.warn(`control ${id}: value ${JSON.stringify(state.val)} is not a number; write ignored`);
        }
        else {
            this.log.debug(`control ${id}: ack=${String(state.ack)}; only ack=false commands are forwarded`);
        }
    }
}
if (require.main !== module) {
    module.exports = (options) => new VictronMk2(options);
}
else {
    (() => new VictronMk2())();
}
//# sourceMappingURL=main.js.map