import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { botlandPlugin } from "./index.js";

console.warn("[botland] DEPRECATED OpenClaw plugin setup entry loaded. Use @botland.im/cli with botland daemon/bridge instead.");

export default defineSetupPluginEntry(botlandPlugin);
