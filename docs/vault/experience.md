# Experience

The owner never sets the Vault up and is never asked about routine work. Questions appear only when Otto wants something the owner did not ask for, or wants to spend money. Everything else is visible but needs no attention.

Interface text is short, with no labels that explain themselves.

## Moments

| Moment                                       | What happens                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install                                      | Nothing. The key is created automatically.                                                                                                                                                                          |
| Existing logins                              | Optional: drop a password-manager export on the Vault page.                                                                                                                                                         |
| First sign-in to a site                      | Otto opens a secure form with the exact address and a preview of the page. The owner types once. "Remember in Vault" is on.                                                                                         |
| Later sign-ins the owner asked for           | Otto signs in. Vault activity records it.                                                                                                                                                                           |
| A site the owner did not mention             | One yes/no question in chat, Telegram or WhatsApp.                                                                                                                                                                  |
| The same login on `www` or another subdomain | One question the first time.                                                                                                                                                                                        |
| Two-factor codes                             | Filled automatically when the owner added the authenticator to the login, or the code arrives in a connected mailbox. Otherwise a secure form.                                                                      |
| A purchase                                   | One approval: in Stripe Link where the owner uses it, otherwise one dialog in Otto. The owner types the security code, or taps Pay when they chose to remember it; on desktop the tap is Touch ID or Windows Hello. |
| Schedules                                    | Use the sites granted when the schedule was made. Never pay without the owner.                                                                                                                                      |
| Event work                                   | Never signs in and never opens a saved session. Tells the owner when a site needs them.                                                                                                                             |
| Telegram and WhatsApp                        | Questions work as in Otto, and payments at shops already paid at. Secure forms say "Open Otto to continue securely."                                                                                                |
| Lost key                                     | A banner on every page until the key is restored. Nothing is overwritten.                                                                                                                                           |

## Text

| Place                                          | Text                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Question                                       | Sign in to example.com as al…? or Use your saved session on example.com? |
| New origin for a saved login                   | Use your example.com login on www.example.com? · Allow · Deny            |
| Secure form title                              | example.com                                                              |
| Secure form option                             | Remember in Vault                                                        |
| Payment dialog                                 | Pay €43.20 at shop.example · Visa ••4242 · Security code · Pay           |
| Payment dialog, remembered code                | Pay €43.20 at shop.example · Visa ••4242 · Pay                           |
| Card form option                               | Do it for me                                                             |
| Card form note, under the option               | Otto can then pay with one tap.                                          |
| Payment dialog, card fields in a payment frame | Card details go to js.stripe.com                                         |
| Lost key banner                                | Otto can't open your Vault. Restore the key.                             |

Usernames are shown as their first two characters followed by an ellipsis. Cards are shown as brand and last four digits.

## Vault page

- **Items.** Logins and cards, newest first, with search. Each shows its site icon, name, username hint or card hint, and "Last used" with a relative time.
- **Item detail.** Name, origins, username, and the password, number or authenticator behind Show and Copy. Revealed values hide when the window loses focus. Copied values clear from the clipboard after 90 seconds, in the web app while the page has focus. The desktop app also marks them as concealed for clipboard managers. On desktop, Show and Copy ask for Touch ID or Windows Hello.
- **Activity.** Under each item: every use and held attempt with task, site, time and reason. The reasons:
  - You asked
  - Allowed without asking
  - Schedule "Monthly invoices"
  - You approved €43.20
  - Held: a page contained instructions
  - Held: you didn't mention this site
  - Denied by you
- **Permissions.** Each login and saved session has a Sign in without asking switch. Schedules use the sites their instruction names.
- **Add.** Login or card. On the owner's own installs, a card offers Do it for me, which shows the security code field; with it on, a yes is enough to pay. The card's detail has the same switch and its payment history. Hosted mode has no security code field.
- **Pay.** Plain text everywhere: "Pay €43.20 at shop.example with Visa ••4242? Reply with its security code." The first time, Otto adds: "Add “keep” and next time your yes is enough." With Do it for me the question is just "Pay €43.20 at shop.example with Visa ••4242?" and a yes pays. "Turn off Do it for me" or "keep my card's code" changes it.
- **Import.** New › Import passwords takes a CSV export from Chrome, 1Password, Apple Passwords, Firefox or Bitwarden, parsed in the page. It shows the count, imports, keeps what is already saved and reminds the owner to delete the file.

## Apps page

One row per website, combining its login and its browser session. Disconnect drops the session. Forget removes the login, the session and the permissions together, after a confirmation that names all three.

## What the owner never sees

- a master password, recovery kit or setup step;
- a question for a sign-in they asked for;
- a password or code in chat.
