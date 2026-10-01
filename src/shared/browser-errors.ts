const browserErrors = {
  browser_click_intercepted:
    'The click was not performed because another element covers the target. Inspect the page again and dismiss the covering dialog or choose another visible control before retrying.',
  browser_navigation_failed:
    'The website did not load successfully. Open another public page or retry navigation later; taking screenshots cannot recover a failed page.',
  browser_action_failed:
    'The page did not accept that browser action. Take a fresh snapshot and use a current control.',
  browser_observation_failed:
    'The browser could not read the updated page. Take a fresh screenshot before requesting another snapshot. Keep the current page open and check its state before repeating any click or submission.',
} as const;

export type BrowserErrorCode = keyof typeof browserErrors;

export function browserErrorMessage(code: unknown): string | undefined {
  return typeof code === 'string' && Object.hasOwn(browserErrors, code)
    ? browserErrors[code as BrowserErrorCode]
    : undefined;
}
