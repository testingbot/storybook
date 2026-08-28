/**
 * Typed view of constants.json, shared with preset.cjs and the server handlers.
 * See src/constants.cjs for why the JSON file is the source of truth.
 */
import constants from './constants.json' with { type: 'json' }

export const ADDON_ID: string = constants.ADDON_ID
export const PANEL_ID: string = constants.PANEL_ID
export const PANEL_TITLE: string = constants.PANEL_TITLE
export const TOOL_ID: string = constants.TOOL_ID
export const TEST_PROVIDER_ID: string = constants.TEST_PROVIDER_ID
export const STATUS_TYPE_ID: string = constants.STATUS_TYPE_ID
export const TB_EVENTS = constants.TB_EVENTS
export const CHANNEL_AUTH = constants.CHANNEL_AUTH
