import botlandPluginEntry from './index.js';

// Narrow setup seam: expose the channel plugin object from the already-defined entry.
// This avoids a fake empty setup entry while keeping the package lightweight.
export const botlandSetupPlugin = botlandPluginEntry?.plugin ?? botlandPluginEntry;
