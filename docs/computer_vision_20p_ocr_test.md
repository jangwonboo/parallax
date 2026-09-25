# Computer vision PDF OCR test (2026-09-25)

Source: `D:\ebook\computer_vision\computer_vision_scribe.pdf` (1,300 scanned pages).

Selected source PDF pages (1-based): 76, 176, 201, 226, 251, 276, 301, 326, 351, 376, 426, 451, 526, 576, 601, 651, 751, 801, 876, 1176. These pages sample diagrams, graphs, equations, code, and photographs across the book. In the test `.parallax`, pages 1–20 correspond to this list in order.

The 20-page subset was processed with `pdf2parallax/scripts/extract.py`, then `pagecheck.py --engine datalab --datalab-mode accurate --tables image`, and finally `export.py`. The source has no native text layer, so extraction first made a temporary Tesseract OCR layer. Datalab then reread all 20 pages from images.

Result: 20 pages with blocks on every page; 123 blocks, including 17 equations and 17 figures backed by 17 assets. SQLite integrity check passed and all figure references resolve. No translation was added. No table blocks were detected in this page selection. The first one-page API check cost about $0.01; the remaining 19 calls cost about $0.14 according to the pipeline's estimate.

The page-check report flagged 11 of 20 pages for less than 90% agreement with the temporary OCR layer. This is a diagnostic comparison, not proof that the Datalab text is wrong. Review the flagged pages against the source PDF before using the result as a faithful transcription.

Local artifacts are under `out/computer_vision_scribe_20p.parallax`, `out/computer_vision_scribe_20p_pages.json`, and `out/computer_vision_scribe_20p_report.md`. The repository ignores `out/` and `*.parallax` because they contain copyrighted source text and images; these files remain local and are not part of this commit.
