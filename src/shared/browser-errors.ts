const browserErrors = {
  browser_click_intercepted:
    'The click was not performed because another element covers the target. Inspect the page again and dismiss the covering dialog or choose another visible control before retrying.',
  browser_navigation_failed:
    'The website did not load successfully. Open another public page or retry navigation later; taking screenshots cannot recover a failed page.',
  browser_action_failed:
    'The page did not accept that browser action. Take a fresh snapshot and use a current control.',
  browser_dialog_open:
    'A JavaScript dialog blocks the page, so the action did not run. Take a snapshot to read it, then use accept_dialog or dismiss_dialog.',
  browser_not_open: 'No page is open in the browser. Open the website first.',
  browser_observation_failed:
    'The browser could not read the updated page. Take a fresh screenshot before requesting another snapshot. Keep the current page open and check its state before repeating any click or submission.',
  browser_card_paused:
    'A private entry document is still open. Reload it before Pi reads or controls it. Check the result before another attempt.',
  browser_script_paused:
    'A field Otto filled privately still holds its value, so page scripts are paused. Use snapshot or screenshot, or continue once the page moves on.',
  browser_card_reload:
    'A script ran on this document, so Otto will not enter a saved value on it. Reload the page and take a fresh snapshot before a new private operation.',
  browser_card_field:
    'Otto could not verify a card field, so nothing more was entered. Check the result before another attempt.',
  browser_card_site:
    'The approved card field could not accept the value, so nothing more was entered. Check the result before another attempt.',
  browser_card_changed:
    'The checkout page changed. The operation may have reached the site. Check the result before another attempt.',
} as const;

export type BrowserErrorCode = keyof typeof browserErrors;
export const browserErrorCodes = Object.keys(browserErrors) as [
  BrowserErrorCode,
  ...BrowserErrorCode[],
];

export function browserErrorMessage(code: unknown): string | undefined {
  return typeof code === 'string' && Object.hasOwn(browserErrors, code)
    ? browserErrors[code as BrowserErrorCode]
    : undefined;
}
