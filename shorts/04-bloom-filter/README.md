# Bloom filter: check 1 billion usernames in about 1 GB

> **Interview question:** You have 1 billion usernames and the signup page checks availability on every keystroke. How do you answer without hammering the database, and without keeping every name in RAM?

**Read the full study notes here (dark mode, two simulators, self-quiz):**
https://param4.github.io/system-design-with-param/shorts/04-bloom-filter/

What it covers:
- Why a database lookup, a Redis set and answer caching all hurt at this scale, with a measured memory number.
- How a Bloom filter works, and why it can say "maybe" but never misses.
- Sizing: 9.6 bits per item and 7 hashes for 1%, plus measured overfill results.
- Real uses: Cassandra and RocksDB, cache penetration, Akamai's cache-on-second-hit.
- What breaks in production: write order, restarts, rebuilds, deletes and growth.

The page source is [`index.html`](index.html) in this folder.
