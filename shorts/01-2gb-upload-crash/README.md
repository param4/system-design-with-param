# 2 GB upload crashes the server

> **Interview question:** A user uploads a 2 GB file and your server crashes within seconds. How do you handle this in production?

**Read the full study notes here (dark mode, diagrams, two simulators, self-quiz):**
https://param4.github.io/system-design-with-param/shorts/01-2gb-upload-crash/

What it covers:
- Why the server dies: memory, stuck threads, and network, with worked numbers.
- The four fixes (streaming, presigned URL direct upload, multipart, async processing), each with what it fixes and what it doesn't.
- The full presigned multipart upload flow, step by step.
- Interview traps, production limits (nginx, Cloudflare, API Gateway, Lambda), security pipeline.

The page source is [`index.html`](index.html) in this folder.
