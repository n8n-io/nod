---
name: data-and-spreadsheets
description: Clean tables, reconcile exports, analyze data and create reliable spreadsheets or import files. Use for CSV, XLSX, reports, charts and data transfers. Use business-finance for accounting decisions.
---

# Data and spreadsheets

Inspect the schema, delimiter, encoding, sheet names, row count and date formats. Read a small sample before choosing types. Keep identifiers and leading zeros as text. Determine locale before parsing decimal separators or ambiguous dates.

Keep the original data unchanged. State the row key, duplicate rule, join cardinality and treatment of missing values. A many-to-many join can multiply money or event counts. Check unmatched keys and before/after counts. Do not fill missing facts with plausible values.

Separate raw data, transformations and results when the workbook needs to be reviewed. Use formulas where the user expects recalculation. A formula string without a calculated value can appear blank in another application. Check how the target program calculates the final file.

Reconcile totals and units. Distinguish elapsed time from clock time, percentages from points, and current balance from period activity. Label chart axes and periods. A trend needs comparable coverage and a consistent denominator.

For imports or synchronization, inspect the target schema and a sample mapping. Preserve stable source IDs, validate required fields and produce a rejected-row file. Check existing target records before writes. A repeated append can duplicate the data. Never treat a failed or interrupted write as safe to repeat.

For exported CSV, prevent untrusted cell text from becoming a formula in the receiving spreadsheet. Apply the target's rules without changing the underlying value in the source. Check the final row count, key totals, formulas and readable output. Report excluded rows and unexplained differences.

For an import or synchronization that writes to another system, read [references/imports.md](references/imports.md).
