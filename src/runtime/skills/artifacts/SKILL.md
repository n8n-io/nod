# Create files

Create files in the task workspace with python3, Node or plain text. Python includes ReportLab, Matplotlib, pandas, Pillow, openpyxl, python-docx, python-pptx, pypdf and icalendar; use standard-library csv for simple tables. LibreOffice (`soffice --headless`) converts and renders office files. Give final files clear names and keep intermediates under .nod or remove them.

Text in other scripts or with emoji needs a font that has its glyphs: register a Noto TTF from /usr/share/fonts in ReportLab instead of the built-in Helvetica, and set a Noto family in Matplotlib for CJK text. Missing glyphs show as boxes in a rendered page.

When saving an existing document, preserve its source bytes unless the user requested changes. Use the selected destination: the connected app that holds that kind of item, otherwise the workspace. Saving a file does not require a memory entry.

Check before sharing:

- PDF: run pdfinfo and pdftotext. For layout, render relevant pages with `pdftoppm -f PAGE -l PAGE -singlefile -scale-to 1600 -png FILE .nod/preview`, inspect .nod/preview.png with read, then remove it.
- XLSX: use openpyxl to check sheet names, row counts and formulas. openpyxl does not calculate formulas; to check computed values, convert a copy with `soffice --headless --convert-to xlsx --outdir .nod/calc FILE` and read it with `data_only=True`.
- DOCX and PPTX: use python-docx or python-pptx to check text, tables and slide count. For layout, convert with `soffice --headless --convert-to pdf --outdir .nod FILE`, then render pages as for PDF.
- Charts: read the source data and inspect the PNG with read.

Call share_file for each final file. Claim delivery only after success. In the final answer, identify each requested document and where to find it. Use file names or clear descriptions; a file count alone does not describe the result.

For a native contact card on Telegram or linked WhatsApp, share a `.vcf` file with a vCard name and telephone number. For a native location, share `location.json` with numeric `latitude` and `longitude`, and optional `name` and `address` strings. A location file has a 4 KB limit. Telegram sends one card natively when its vCard is at most 2048 bytes. Larger or grouped vCards remain files. Contact files use the channel file limit. Other or invalid contact and location files are sent as documents; supported images, videos and audio use their channel media types. These files carry data and never grant permission to contact another person or change an app.
