/**
 * Public entry point.
 *
 * Storybook loads the addon through ./preset and ./manager; this entry exists
 * for programmatic consumers and for the CLI in TB-261, which shares the runner
 * and config with the addon rather than duplicating them.
 */
export { ADDON_ID, PANEL_ID, PANEL_TITLE, TOOL_ID, TB_EVENTS, CHANNEL_AUTH } from './constants.js'
export { TunnelManager } from './node/tunnel-manager.js'
export { TunnelError, toTunnelError } from './node/tunnel-errors.js'
export { getLocalPortCapability, mergeLocalPortCapabilities, DEFAULT_TUNNEL_PORTS } from './node/local-ports.js'
export { resolveDeviceUrl, deviceDriverFor } from './node/device-url.js'
export { ExternalTunnel } from './node/external-tunnel.js'
export { serveStatic, localIp } from './node/serve.js'
export type { StaticServer } from './node/serve.js'
export type { TunnelProvider } from './node/types.js'
export type { DeviceReachability } from './node/device-url.js'
export { WebDriverSession, WebDriverError, buildDeviceCapabilities } from './node/webdriver.js'
export { resolveCredentials, credentialStatus, verifyCredentials } from './node/credentials.js'
export { runOnGrid, applyScope, RunError } from './node/runner.js'
export type { RunScope } from './node/runner.js'
export {
  toTargets,
  buildCapabilities,
  buildAndroidCapabilities,
  buildWsEndpoint,
  browserTypeFor,
  resolveWidths,
  variantsFor,
  DEFAULT_VIEWPORT,
} from './node/targets.js'
export type { TargetVariant } from './node/targets.js'
export { fetchStoryIndex, selectStories, StoryIndexError } from './node/story-index.js'
export { compareImages } from './node/image-diff.js'
export {
  buildSnapshotArguments,
  buildSnapshotOptions,
  buildSnapshotScript,
  isValidVisualName,
  mapSnapshotResponse,
  visualMode,
  visualNameFor,
} from './node/hosted-visual.js'
export type { VisualMode } from './node/hosted-visual.js'
export {
  fetchCatalogue,
  toCatalogue,
  toBrowserSpec,
  toDeviceSpec,
  CatalogueError,
  VERSION_ALIASES,
} from './node/catalogue.js'
export {
  readLastRun,
  writeLastRun,
  lastRunPath,
  readImageDataUrl,
  approveStory,
  approvableStories,
  markApproved,
} from './node/run-store.js'
export { getAccountLimits, resolveConcurrency } from './node/account.js'
export {
  baselineDir,
  resultsDir,
  baselinePath,
  resultPath,
  BASELINE_ROOT,
} from './node/baselines.js'
export { buildArgsParam, isEncodableArg } from './node/story-args.js'
export {
  EXTRACT_ASYNC_SCRIPT,
  EXTRACT_EXPRESSION,
  PARAMETER_KEY,
  partitionSkipped,
  storyUrl,
  toParameterMap,
} from './node/story-parameters.js'
export type { ParameterMap, StoryParameters } from './node/story-parameters.js'
