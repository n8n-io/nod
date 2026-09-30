---
name: artifacts
description: Create or edit a PDF, spreadsheet, Word document, slide deck, chart, or other file for the user.
---

# Create files

Use the task workspace to create files. `python3` has ReportLab, Matplotlib, pandas, Pillow, openpyxl, python-docx and python-pptx. Use `csv` from the Python standard library for a simple table. Use Node or plain text when that is simpler.

Save the final file under the task workspace. Give it a clear name. Keep intermediate files under `.otto` or remove them.

Check the file before you share it:

- For a PDF, run `pdfinfo` and `pdftotext`. Render pages that need a layout check with `pdftoppm -f PAGE -l PAGE -singlefile -scale-to 1600 -png FILE .otto/preview`, then use `read` on `.otto/preview.png` and remove it.
- For an XLSX file, open it with `openpyxl` and check the sheet names, row counts, formulas and key values.
- For a DOCX file, open it with `python-docx` and check the paragraphs and tables.
- For a PPTX file, open it with `python-pptx` and check the slide count and text.
- For a chart, read the source data and inspect the PNG with `read`.

Use `share_file` for each final file. A successful `share_file` call sends the file to the user. In the final answer, give a short summary and do not claim that a file was sent if the tool failed.
