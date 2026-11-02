# API returns 1 million records, server dies

> **Interview question:** Your API returns 1 million records in one response and the servers start failing. How do you fix it?

**Read the full study notes here (dark mode, pagination simulator, self-quiz):**
https://param4.github.io/system-design-with-param/shorts/03-million-records-api/

What it covers:
- Why one huge response runs the server out of memory, with numbers.
- Why LIMIT/OFFSET gets slower with every page and shows duplicate rows.
- Keyset (cursor) pagination: the SQL, the tie-breaker detail, the API shape.
- Exports of all rows: streaming (and the driver fetch-size trap) or an async job with a download link.

The page source is [`index.html`](index.html) in this folder.
