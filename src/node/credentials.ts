import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import type { Credentials } from './types.js'

/**
 * Credential resolution for Node consumers, including the CLI in TB-261.
 *
 * The implementation lives in src/server/credentials.cjs because the preset and
 * its channel handlers are CommonJS and need it too. This is a thin re-export
 * rather than a second copy: two resolvers would drift, and the one that
 * disagreed would produce a 401 that is very hard to trace back.
 */
const require = createRequire(import.meta.url)

/**
 * Resolved from the emitted bundle rather than from this source file: after
 * tsup this module is dist/index.js, and src/ sits one level up from there in
 * the published package (src is listed in package.json "files" precisely
 * because preset.cjs and these handlers are required at runtime).
 *
 * Built as a URL so esbuild treats it as dynamic and leaves the resolution to
 * runtime instead of trying to inline the CommonJS module into the bundle.
 */
const credentialsModulePath = fileURLToPath(
  new URL('../src/server/credentials.cjs', import.meta.url),
)

type CredentialsModule = {
  resolveCredentials: (env?: NodeJS.ProcessEnv) => Credentials | null
  credentialStatus: () => {
    configured: boolean
    source: string | null
    overriddenByEnvironment: boolean
  }
  verifyCredentials: (
    key: string,
    secret: string,
  ) => Promise<{ ok: boolean; reason?: 'invalid' | 'network' }>
}

const credentials = require(credentialsModulePath) as CredentialsModule

export const resolveCredentials = credentials.resolveCredentials
export const credentialStatus = credentials.credentialStatus
export const verifyCredentials = credentials.verifyCredentials
