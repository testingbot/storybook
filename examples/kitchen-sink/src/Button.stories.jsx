import { Button } from './Button.jsx'

export default {
  title: 'Basics/Button',
  component: Button,
  // Generates a Basics/Button > Docs page, which is what "captureAutodocs" runs.
  tags: ['autodocs'],
}

export const Primary = { args: { variant: 'primary', children: 'Save changes' } }
export const Secondary = { args: { variant: 'secondary', children: 'Cancel' } }
export const Danger = { args: { variant: 'danger', children: 'Delete account' } }
export const Disabled = { args: { variant: 'primary', disabled: true, children: 'Save changes' } }

/**
 * Long labels are where a button that looks fine on Chrome on a desktop wraps
 * badly on a phone. This story exists to be run on a real device.
 */
export const LongLabel = {
  args: { variant: 'primary', children: 'Save changes and continue to the next step' },
}
