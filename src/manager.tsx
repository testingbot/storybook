import React from 'react'
import { addons, types } from 'storybook/manager-api'
import { AddonPanel } from 'storybook/internal/components'

import { ADDON_ID, PANEL_ID, PANEL_TITLE, TOOL_ID } from './constants.js'
import { Panel } from './components/Panel.js'
import { Toolbar } from './components/Toolbar.js'
import { registerTestProvider } from './test-provider.js'

/**
 * Manager entry, registered by preset.cjs through managerEntries.
 *
 * The panel and the toolbar button are registered first and unconditionally.
 * The Testing widget integration (TB-258) is added last and checks the
 * experimental exports it needs before touching anything, so a Storybook that
 * drops that API loses the widget and keeps a fully working addon.
 */
addons.register(ADDON_ID, () => {
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: PANEL_TITLE,
    match: ({ viewMode }) => viewMode === 'story',
    render: ({ active }) => (
      <AddonPanel active={Boolean(active)}>
        <Panel />
      </AddonPanel>
    ),
  })

  addons.add(TOOL_ID, {
    type: types.TOOL,
    title: PANEL_TITLE,
    match: ({ viewMode }) => viewMode === 'story',
    render: () => <Toolbar />,
  })

  registerTestProvider()
})
