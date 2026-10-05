# Catalog synchronization

Define the key at product, variant and stock-location level. Check that each destination receives the intended language, currency, category and tax basis. Preserve the relationship between a parent product and its variants.

List each field's authority. Supplier text can supply dimensions while the store owns the title or local description. Missing supplier stock does not mean zero available stock. An obsolete import can restore a price or listing the owner deliberately removed.

Preview new, changed, unchanged and rejected records. Include a variant product and a partial record in the sample. Check whether a write affects all markets or only the selected channel. Do not mix a draft listing with a live listing when counting publication.

After the first batch, read the destination variants and stock values. Check SKU, price, units, visibility and language. Record successful and uncertain destination IDs separately. Stop on a duplicate, incorrect mapping or stale-data conflict. Do not resolve a two-way loop by making both systems write more often.
