---
name: ecommerce-operations
description: Maintain seller catalogs, inventory, orders and marketplace listings. Use for product publication, stock synchronization, fulfilment exceptions and store reports. Use shopping for a buyer's task.
---

# Ecommerce operations

Resolve the store, marketplace, region and system of record. Identify the product, variant and location keys before mapping data. A parent product ID is not a sellable variant. SKU, barcode and provider IDs can serve different purposes.

For listings, use verified descriptions, attributes, media rights and compatibility facts. Preserve variant relationships, units and required category fields. Check whether an edit changes one variant, a parent listing or several channels. Do not copy an image merely because it appears on a supplier page.

For prices, include tax basis, currency, fees and the business's margin rule. A percentage discount and a fixed reduction differ. Check whether a promotion combines with another promotion. Keep proposed prices separate from published prices.

For inventory, distinguish on-hand, reserved, available and incoming units. Prevent two systems from each treating the other as authoritative. Use timestamps and stable keys; a stale stock export can overwrite a recent sale. Do not replace a missing value with zero.

For orders, match payment, fulfilment, shipment and cancellation states. A paid order may already have been dispatched. Check parcel and line-item quantities before replacements or cancellations. An order can have partial fulfilment or refunds.

Before a broad update, prepare a preview of the full target set with proposed changes and rejected records. Check the account, scope and mappings across that set. Also validate a representative record, including a product with variants, before applying the changes. Stop when the mapping or target state differs. After authorized writes, read the product or order in the destination. Report records changed and exceptions. A browser crash is not evidence of a permission problem or a completed publication.

For catalog or stock synchronization across systems, read [references/catalog-sync.md](references/catalog-sync.md).
