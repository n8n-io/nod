---
name: documents-and-forms
description: Prepare and edit documents, fill administrative forms and extract obligations from contracts. Use for PDFs, Word files, applications and government paperwork. Use writing-and-content for prose alone.
---

# Documents and forms

Identify the source file, required format, recipient and final use. Inspect the document structure before editing. For an application, find the current official form for the user's jurisdiction and submission date. A search result can link to a retired form.

Map each requested field to a verified fact or document. Preserve names, identifiers, dates, units and exact legal wording. Mark unknown fields for the user. A blank, zero and not-applicable answer can have different meanings. Do not invent an eligibility fact or select a declaration from a guess.

For PDF forms, check whether fields are interactive or the page is an image. Check whether text extraction misses a scanned page. Preserve the original and work on a copy. A visual mark can fail to set the form's actual checkbox value: list interactive fields with pypdf, fill them by field name, then render the filled pages to confirm. Use qpdf to repair, merge or split, and Ghostscript to shrink a PDF to an upload limit. LibreOffice opens .doc, .odt and .rtf files.

For contracts, extract parties, dates, fees, renewal, termination and obligations with page references. Distinguish a contract term from its legal enforceability. Use current official sources for legal rules; do not state a legal conclusion from a clause alone.

Before submission, identify any signature, certification, consent or payment. Preparation does not authorize submission or signing for the user. Do not use another person's signature or create a sworn assertion. If the destination accepts uploads, check its size, format and completeness rules.

Use the core artifact guide to check the final file. For a layout-sensitive document, render and inspect the affected pages; successful file creation does not prove usable layout. Completion needs the checked final file and, if submission was authorized, the receipt or application reference. Keep submitted and approved states separate.

For government, visa or immigration applications, read [references/government-forms.md](references/government-forms.md).
