import React, { useCallback } from 'react'
import {
  addons,
  experimental_getStatusStore,
  experimental_getTestProviderStore,
  experimental_useTestProviderStore,
  types,
} from 'storybook/manager-api'

import { STATUS_TYPE_ID, TB_EVENTS, TEST_PROVIDER_ID } from './constants.js'
import { withNonce } from './nonce.js'
import { connectTestProvider } from './test-provider-core.js'

/**
 * Registration with Storybook's own Testing widget. TB-258.
 *
 * Two separate stores are involved and they answer different questions. The
 * test provider store holds one state for the whole provider, and it means "did
 * the run itself get anywhere", not "did the tests pass": crashed is for a
 * tunnel that never came up, not for a story that looks different. The status
 * store holds one status per story, and that is what paints the sidebar icons.
 * Mixing them up would either colour the whole widget red because one baseline
 * moved, or leave the sidebar blank after a run that failed outright.
 *
 * This file subscribes to the channel itself rather than reusing the panel's
 * hook. The widget is visible when the panel is closed, and a hook only runs
 * while its component is mounted, so sharing would mean the sidebar silently
 * stopped updating whenever someone switched to the Controls tab.
 *
 * Everything here is behind experimental_ exports. If any of them disappear in
 * a Storybook upgrade, register() returns without touching the widget and the
 * panel carries on working alone, which is the fallback TB-258 requires.
 */


const TestProvider = () => {
  const state = experimental_useTestProviderStore((all) => all[TEST_PROVIDER_ID])
  const running = state === 'test-provider-state:running'

  const onRun = useCallback(() => {
    addons.getChannel().emit(TB_EVENTS.RUN, withNonce({ scope: 'all' }))
  }, [])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
      <span style={{ flex: 1, fontSize: 13 }}>
        TestingBot
        <span style={{ display: 'block', fontSize: 11, opacity: 0.7 }}>
          {running ? 'Running on the TestingBot cloud' : 'Cross browser and real device screenshots'}
        </span>
      </span>
      <button type="button" onClick={onRun} disabled={running}>
        {running ? 'Running' : 'Run'}
      </button>
    </div>
  )
}

/** True when this Storybook still has every experimental export we need. */
export function testProviderSupported (): boolean {
  return (
    typeof experimental_getStatusStore === 'function' &&
    typeof experimental_getTestProviderStore === 'function' &&
    typeof experimental_useTestProviderStore === 'function' &&
    'experimental_TEST_PROVIDER' in types
  )
}

export function registerTestProvider (): void {
  if (!testProviderSupported()) {
    console.warn(
      '[testingbot] This Storybook does not expose the experimental test provider API, ' +
        'so TestingBot will not appear in the Testing widget. The TestingBot panel is unaffected.',
    )
    return
  }

  const statusStore = experimental_getStatusStore(STATUS_TYPE_ID)
  const providerStore = experimental_getTestProviderStore(TEST_PROVIDER_ID)

  connectTestProvider(addons.getChannel(), statusStore, providerStore)

  addons.add(TEST_PROVIDER_ID, {
    type: types.experimental_TEST_PROVIDER,
    // render is called as a plain function by Storybook, not mounted as a
    // component, so every hook has to live inside TestProvider rather than here.
    render: () => <TestProvider />,
    clear: () => statusStore.unset(),
  })
}
