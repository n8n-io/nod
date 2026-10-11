# Payments

Local mode can store an encrypted card. Hosted mode refuses new card numbers and card updates, and does not run `pay`. Legacy hosted cards remain readable and removable; startup does not delete owner data.

`pay` prepares one request bound to the owned card and its revision, shop origin, checkout document, card-field origins, selected submit control, amount and currency. It expires after ten minutes. Pi selects the controls. The browser provider reads actual field origins through Chrome DevTools before the owner sees the question.

An expiry field can be a selector or `{selector, format, locale?}`. `M` and `MM` give a numeric month, `MMM` and `MMMM` give a short or full month name, and `YY` and `YYYY` give the year. For example, `YYYY-MM` fits a month input. Month names use `Intl.DateTimeFormat` with the selected locale. The approved request retains these field instructions.

Expiry dates are card metadata. They do not enter the global secret set, where a short month or year would hide unrelated amounts and page references. The card number, security code and cardholder remain masked.

In Otto web chat, the owner sees a checkout image with fields hidden. They approve with the security code, or with yes when they explicitly enabled Do it for me for that card. A code reply is consumed before model context and chat history.

A Telegram or WhatsApp task asks the owner to open Otto on desktop. The same conversation contains a private payment action. Its form shows the shop, amount, card and card-field destinations. The owner enters a code or approves with a saved code. The form clears the input before the request, and the server resumes the original chat channel. Chat apps never accept payment approval or a card security code. Private URLs do not leave Otto. There is no phone link or relay.

If no card is saved, Otto directs the owner to the empty Vault card form. After saving, the owner tells Otto to continue. Saving a card does not approve a payment. Code storage remains an explicit Vault setting or an owned `payment_setting` confirmation. A first payment does not add a question about this setting.

`payment_setting` always uses an owned confirmation bound to the exact card ID and requested setting. An unrelated checkout task cannot enable storage of a code. Null legacy settings do not imply consent. Turning the setting off deletes the saved code. After entry, the code is saved only if the same card revision still has permission. Saving a code cannot turn permission back on.

A later owner request in the conversation makes an older payment unavailable. Its form cannot claim a use or resume the old task. Approval resumes keep the request valid. A separate background task keeps its own scope.

The claim transaction checks that the owned thread is active and the source turn is running or waiting. It locks and reads the approved card revision, consumes the unexpired request and claims the durable operation before card entry. A changed card or permission requires a new request. Stop cancels waiting tasks, so a code accepted before Stop cannot claim a payment after cancellation. Stop cannot undo entry that has already started. Concurrent replies can claim only one use. The provider checks the approved document and each field origin, enters into the actual field, submits the chosen control, and keeps the live page for Pi to inspect. Private entry uses an isolated JavaScript world in the same page. It shares the website DOM. Otto pauses observation and control during entry and submission. After successful submission, known secret values are removed from tool output and masked in screenshots. No long-lived restriction removes normal Pi browser tools after this operation.

A completed operation is recorded as **card submitted**. It is not recorded as paid. Pi must inspect the shop's result. A failure after possible entry is **uncertain**; the owner must check the order or payment state. The server does not retry or say that nothing was entered.

A submit control can belong to the merchant or an approved origin that receives an entered card field. Extra unused destinations do not grant submit authority. The same document check applies to the control and the fields.

## Payment limits

A stored PAN cannot enforce the amount, merchant or settlement at the issuer. Otto's request binds its own operation to the approved values. A website can still change the cart or submit a different amount. Issuer-bound, single-use payment credentials need a real provider integration before Otto can claim that enforcement.

Local Do it for me retains a code only after explicit consent. This feature is not a PCI DSS compliance claim. PCI SSC prohibits storage of card verification codes after authorization for entities in scope. Hosted refusal of PAN and codes avoids adding that hosted storage path; it does not establish certification. See [PCI SSC FAQ 1280](https://www.pcisecuritystandards.org/faqs/1280/).
