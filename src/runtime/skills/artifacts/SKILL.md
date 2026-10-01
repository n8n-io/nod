# Create files

Create files in the task workspace with python3, Node or plain text. Python includes ReportLab, Matplotlib, pandas, Pillow, openpyxl, python-docx and python-pptx; use standard-library csv for simple tables. Give final files clear names and keep intermediates under .otto or remove them.

Check before sharing:

- PDF: run pdfinfo and pdftotext. For layout, render relevant pages with `pdftoppm -f PAGE -l PAGE -singlefile -scale-to 1600 -png FILE .otto/preview`, inspect .otto/preview.png with read, then remove it.
- XLSX: use openpyxl to check sheet names, row counts, formulas and key values.
- DOCX: use python-docx to check paragraphs and tables.
- PPTX: use python-pptx to check slide count and text.
- Charts: read the source data and inspect the PNG with read.

Call share_file for each final file. Claim delivery only after success. Briefly describe the content and use in the final answer; include filenames only if requested.
