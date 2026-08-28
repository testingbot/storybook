import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    manager: 'src/manager.tsx',
    cli: 'src/cli.ts',
    // The Testing widget's logic, bundled on its own because it has no browser
    // dependencies and the tests exercise it in Node.
    'test-provider-core': 'src/test-provider-core.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // The manager bundle runs inside Storybook's own React tree, so React must
  // come from Storybook's instance rather than a second bundled copy.
  //
  // Storybook exposes react, react-dom and react-dom/client as manager globals
  // but NOT react/jsx-runtime (see storybook/internal/manager/globals). The
  // automatic JSX transform emits an import from that subpath, which would
  // either be bundled (a second React, breaking hooks with
  // "Cannot read properties of undefined (reading 'recentlyCreatedOwnerStacks')")
  // or externalised to something that cannot resolve. So the classic transform
  // is used instead: it emits React.createElement, which resolves to the global.
  external: ['react', 'react-dom', 'react-dom/client', 'storybook', /^storybook\//, /^@storybook\//],
})
