# Optional npm packages

Recommended:

```bash
npm install sharp helmet cors
```

- `sharp`: enables `VIDEO_CODEC=webp`.
- `helmet`: adds basic HTTP security headers.
- `cors`: enables controlled cross-origin integration if needed.

Not included by default:

```bash
npm install bull rate-limiter-flexible express-rate-limit systeminformation
```

Why not default?

- `bull` requires Redis. Good for multi-server production, overkill for single VPS demo.
- `rate-limiter-flexible` is excellent with Redis, but V23 already has in-memory default rate limiting.
- `express-rate-limit` is useful but V23 uses custom memory buckets to avoid hard dependency.
- `systeminformation` is useful for dashboards/adaptive scaling, not required for runtime.
