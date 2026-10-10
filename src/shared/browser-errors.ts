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
    'Card details are on a page in this browser, so typing, scripts, dragging and screenshots are paused. Use snapshot and click until that page is gone.',
  browser_card_reload:
    'A script ran on this checkout page, so Otto will not enter a card on it. Reload the checkout, take a fresh snapshot and call pay again.',
  browser_card_field:
    'Otto could not verify a card field, so nothing more was entered. Take a fresh snapshot and call pay with the current fields.',
  browser_card_site:
    'A card field is not on a site approved for this payment, so nothing more was entered. Inspect the page and ask again.',
  browser_card_changed:
    'The checkout page changed, so nothing more was entered. Take a fresh snapshot and call pay again.',
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
