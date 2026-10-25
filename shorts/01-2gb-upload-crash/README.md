# 2 GB upload crashes the server

> **Interview question:** A user uploads a 2 GB file and your server crashes within seconds. How do you handle this in production?
> **Interactive version (dark mode, diagrams, simulators):** https://param4.github.io/system-design-with-param/shorts/01-2gb-upload-crash/


**Layers:** Must-know · Interview traps · Production depth · Where the popular answer falls short · Self-quiz

---

## 1. Must-know

### Why the server dies
Three resources run out, usually in this order:

| Resource | What happens | Numbers |
|---|---|---|
| **Memory** | Code reads the whole body into RAM (`file.getBytes()`, `readAllBytes()`, Express `multer.memoryStorage()`). | 2 GB per upload. 10 users at once = **20 GB** of heap → OutOfMemoryError. GC thrashes well before that. |
| **Threads / connections** | The request keeps a worker thread busy for the whole transfer. | 2 GB = 16,000 Mb. On a 20 Mbps uplink: 16,000 ÷ 20 = **800 s ≈ 13 min** per upload. A few slow uploads can tie up the pool (Little's law: in-flight = arrival rate × duration). |
| **Disk / bandwidth** | Frameworks spool big bodies to a temp dir; the proxy may buffer them too. | `/tmp` fills up. Your server's NIC carries every byte twice (in from the user, out to storage). |

`IMP` **It's not a storage problem, it's a "who carries the bytes" problem.** As long as the 2 GB flows through your app server, a bigger machine only moves the limit.

### The four fixes, in order of impact

```
                ❌ Bytes through the server                  ✅ Bytes straight to storage

  Browser ──2 GB──▶ API server ──2 GB──▶ S3       Browser ──"I want to upload"──▶ API server
                 (RAM, thread, NIC)                  Browser ◀──presigned URL(s)───── API server
                                                     Browser ═══════2 GB══════════▶ S3
                                                     S3 ──event──▶ queue ──▶ worker (scan, process)
```

1. **Streaming** (if the bytes must pass through you): read the body as an `InputStream` and pipe it onward in small chunks (KB–MB). Memory = buffer size, not file size. Fixes RAM; does **not** fix the 13-minute thread hold.
2. **Presigned URL / direct upload** `IMP`: the server only checks "is this user allowed?" and signs a short-lived URL for one exact object key. The browser uploads straight to S3 (or GCS/Azure Blob). The app server handles two tiny JSON calls instead of 2 GB. Fixes RAM, threads, bandwidth and cost together.
3. **Multipart upload**: split the file into parts (e.g. 2 GB → 21 parts of 100 MB) and upload them in parallel. A network drop costs one part, not the whole file. Resume is possible.
4. **Async processing**: when the upload completes, S3 fires an event → queue (SQS/Kafka) → worker does virus scan, transcode, thumbnails. The user sees "Processing…" instead of a request that hangs.

### The S3 numbers to remember `IMP`
| Fact | Value |
|---|---|
| Max size of a single PUT | **5 GB** (AWS suggests multipart from ~100 MB) |
| Multipart part size | **5 MiB – 5 GiB** (the last part can be smaller) |
| Max parts per upload | **10,000** |
| Max object size | **48.8 TiB** |
| Presigned URL max lifetime | **7 days** (SigV4, IAM user). With role/STS creds it dies when the creds expire (EC2 role ~6 h, AssumeRole default 1 h) |

### Multipart + presigned flow (the full answer)
1. Client → API: `POST /uploads {name, size, type}`.
2. API checks auth + size + type, calls `CreateMultipartUpload`, gets an `uploadId`, presigns N `UploadPart` URLs (part numbers 1..N), returns them. The key is chosen by the server: `uploads/{userId}/{uuid}`.
3. Client PUTs each part (3–6 in parallel), keeps each part's `ETag`.
4. Client → API: `POST /uploads/{id}/complete {parts:[{n, etag}]}` → API calls `CompleteMultipartUpload`.
5. API verifies with `HeadObject` (size, checksum), marks the file `UPLOADED`, the event triggers processing.

---

## 2. Interview traps

- **"Just increase `max-file-size` to 2 GB."** That removes a guard. Spring Boot's defaults are `max-file-size=1MB`, `max-request-size=10MB` *on purpose*. Raising them without streaming invites the crash.
- **"Use S3."** Not enough on its own. If the browser → your server → S3, S3 changed nothing about RAM, threads or bandwidth. Say *direct* upload.
- **"Presigned URLs are secure."** A presigned URL is a **bearer token**: anyone holding it can use it, many times, until it expires. Keep the expiry short (5–15 min), scope it to one server-chosen key, never let the client pick the path (it could overwrite someone else's file — S3 replaces an existing key silently).
- **"Where do you enforce the size limit?"** Not in the UI. A presigned **PUT** URL doesn't cap size by itself. Options: a presigned **POST** with the policy condition `["content-length-range", min, max]`, or presign each part (part count × part size caps the total), and always verify after upload with `HeadObject`.
- **"Client says upload done, so it's done."** Never trust it. Verify the object exists, the size matches what was approved, and the checksum matches (SigV4 supports CRC32/CRC32C/SHA-256 etc.).
- **"Streaming solves it."** It solves memory only. The thread is still held for 13 minutes and every byte still crosses your NIC twice.
- **"Expired URL mid-upload breaks it?"** No: S3 checks expiry when the request **starts**. A part that started before expiry finishes. A part retried after expiry fails, so the client must ask for a fresh URL.

---

## 3. Production depth

**Limits you hit before your code even runs**
| Layer | Limit |
|---|---|
| nginx | `client_max_body_size` default **1m** → 413. `proxy_request_buffering on` (default) reads the **whole body** before passing it upstream; set `off` for streaming upload routes |
| AWS API Gateway | max payload **10 MB** |
| AWS Lambda | sync request payload **6 MB** |
| Cloudflare | request body cap **100 MB** on Free/Pro plans |
| Java | a `byte[]` holds at most ~2^31 bytes (~2 GiB), so `getBytes()` on a 2+ GiB file fails even with free heap |

`IMP` These limits are why serverless and CDN-fronted apps *must* use direct-to-storage uploads; there is no "just make it bigger" option.

**Abandoned uploads cost money.** Parts of a multipart upload that never completes stay in the bucket and are billed. Add a lifecycle rule `AbortIncompleteMultipartUpload` (e.g. `DaysAfterInitiation: 1`).

**Resume after the user closes the laptop**
- S3: store `uploadId`; `ListParts` returns which parts already landed; upload only the rest.
- Open standard: **tus** protocol. `HEAD` returns `Upload-Offset` (how many bytes the server has); the client `PATCH`es the remaining bytes from that offset. Used by Vimeo, Cloudflare Stream, Supabase.

**Choosing part size**
- More parts = finer retry, more requests. Fewer parts = bigger retries.
- 2 GB: 64–100 MB parts (20–32 parts). 5 MiB minimum, 10,000 maximum, so a 1 TB file needs parts of at least ~100 MB.
- Parallelism 3–6 per client on mobile; more saturates the uplink without speeding up.

**Security pipeline**
- Upload lands in a **quarantine** prefix → event → antivirus scan → move to `clean/` → only then serve it.
- Check the real type from the file's bytes (magic number), not the extension or the client's `Content-Type`.
- Unzip/process inside size and time limits (zip bombs: a 1 KB archive expanding to GBs).
- Rate-limit the "create upload" endpoint per user, so nobody farms URLs to fill your bucket.

**Downloads mirror the problem.** Serve big files with a presigned **GET** or through a CDN, never by streaming them through the app.

**Other stacks, same trap**
- Node/Express: `multer.memoryStorage()` = whole file in RAM; use disk storage or stream with busboy. `express.json()` default limit is 100 kb.
- Python: Django keeps uploads under 2.5 MB in memory, larger ones go to a temp file; FastAPI `UploadFile` spools to disk past ~1 MB. Fine for medium files, still wrong for 2 GB through the app.

---

## 4. Where the popular answer falls short
codeera.tech's answer ([reel](https://www.instagram.com/reel/DWlj0GsgPAJ/), 57K views; related [reel](https://www.instagram.com/reel/DV7gXzFDKCb/), 49K): never load into memory → stream → set size limits (`max-file-size=2GB`) → presigned URLs → multipart → async processing.

| His point | Verdict |
|---|---|
| Don't load whole file into memory | ✅ Correct |
| Stream in chunks | ✅ Correct, but incomplete: memory is fixed, the 13-min thread hold and double bandwidth aren't |
| Set `max-file-size=2GB` | ⚠️ Misleading: that *raises* Spring's 1 MB default. It's a guard, not a fix. The real cap belongs in the signed policy |
| Presigned URLs, "removes bottlenecks completely" | ⚠️ Right idea, missing: bearer-token risk, short expiry, server-chosen key, size cap, verify after upload |
| Multipart, "upload in parallel and support resume" | ✅ Correct; missing the numbers (5 MiB min, 10,000 parts) and the billing trap for abandoned parts |
| Async processing | ✅ Correct; missing quarantine + scan before serving |
| Not mentioned | Proxy/gateway limits (nginx 1 MB, API Gateway 10 MB, Lambda 6 MB, Cloudflare 100 MB), why the crash happens (concurrency × size), checksum verification, tus |

---

## 5. Self-quiz
<details><summary>1. Streaming is in place, memory is flat, but the server still stops accepting requests during big uploads. Why?</summary>
Each upload still holds a worker thread/connection for the whole transfer (~13 min for 2 GB at 20 Mbps). A few concurrent uploads exhaust the pool.
</details>

<details><summary>2. You hand out a presigned PUT URL valid for 1 hour. What two things can go wrong?</summary>
Anyone who gets the URL can upload (bearer token), repeatedly, until expiry. And a plain PUT doesn't cap size, so someone can push a huge file. Fix: short expiry, server-chosen key, POST policy with content-length-range or per-part presigning, verify with HeadObject.
</details>

<details><summary>3. A 2 GB upload in 20 parts fails at part 14 because the network dropped. What does the client re-upload?</summary>
Only part 14 (and any parts in flight). It uses the same uploadId; ListParts can tell which parts S3 already has.
</details>

<details><summary>4. Your S3 bill keeps growing but the object count doesn't. What's a likely cause?</summary>
Incomplete multipart uploads: their parts are stored and billed but never become objects. Add an AbortIncompleteMultipartUpload lifecycle rule.
</details>

<details><summary>5. Your app runs on AWS Lambda behind API Gateway. Can you accept a 2 GB upload through it with streaming?</summary>
No. API Gateway caps the payload at 10 MB and Lambda's synchronous request payload at 6 MB. Direct-to-S3 with presigned URLs is the only option.
</details>

---

## Possible points for the short (pick the ones to keep)
- [ ] The crash in numbers: 2 GB × 10 users = 20 GB RAM
- [ ] The hidden cost: 13 min thread hold per upload
- [ ] Streaming fixes memory only
- [ ] Presigned URL: server gives permission, not carries bytes
- [ ] Presigned URL is a bearer token (expiry, key, size cap)
- [ ] Multipart: retry one part, not 2 GB
- [ ] Proxy/gateway limits (nginx 1 MB, API Gateway 10 MB, Lambda 6 MB)
- [ ] Abandoned parts cost money
- [ ] Async: S3 event → queue → scan → serve
- [ ] codeera's `max-file-size=2GB` trap

## Sources
- [S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) · [Multipart overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [S3 presigned URLs: expiry, bearer-token note](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [S3 POST policy (content-length-range)](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html)
- [Abort incomplete multipart uploads lifecycle rule](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html)
- [nginx proxy_request_buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering) · [client_max_body_size](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)
- [Spring Boot multipart properties](https://docs.spring.io/spring-boot/appendix/application-properties/index.html)
- [API Gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html) · [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [tus resumable upload protocol](https://tus.io/protocols/resumable-upload)
