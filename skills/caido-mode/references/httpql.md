# HTTPQL reference

Caido's query language for searching HTTP history.

**CRITICAL**: String values MUST be quoted; integers are NOT.

**CRITICAL**: HTTPQL has NO `NOT` operator. Use the negated operator variant instead:

- `ncont` (not contains), `nlike`, `nregex`, `ne` (not equals)
- Wrong: `NOT req.path.cont:"/admin"` — Right: `req.path.ncont:"/admin"`

### Namespaces and Fields

| Namespace | Field | Type | Description |
|-----------|-------|------|-------------|
| `req` | `ext` | string | File extension (includes `.`) |
| `req` | `host` | string | Hostname |
| `req` | `method` | string | HTTP method (uppercase) |
| `req` | `path` | string | URL path |
| `req` | `query` | string | Query string |
| `req` | `raw` | string | Full raw request |
| `req` | `port` | int | Port number |
| `req` | `len` | int | Request body length |
| `req` | `created_at` | date | Creation timestamp |
| `req` | `tls` | bool | Is HTTPS |
| `resp` | `raw` | string | Full raw response |
| `resp` | `code` | int | Status code |
| `resp` | `len` | int | Response body length |
| `resp` | `roundtrip` | int | Roundtrip time (ms) |
| `row` | `id` | int | Request ID |
| `source` | - | special | `"intercept"`, `"replay"`, `"automate"`, `"workflow"` |
| `preset` | - | special | Filter preset reference |

### Operators

- **String:** `eq`, `ne`, `cont`, `ncont`, `like`, `nlike`, `regex`, `nregex`
- **Integer:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`
- **Boolean:** `eq`, `ne`
- **Logical:** `AND`, `OR`, parentheses for grouping

### Examples

```httpql
req.method.eq:"POST" AND resp.code.eq:200       # POSTs with 200s
req.host.cont:"api" OR req.path.cont:"/api/"    # API traffic
"password" OR "secret" OR "api_key"             # bare string searches req AND resp raw
resp.code.gte:400 AND resp.code.lt:500          # 4xx
resp.len.gt:100000                              # large responses (data exposure)
req.path.regex:"/(login|auth|signin|oauth)/"    # auth endpoints
source:"replay" OR source:"intercept"           # tool-generated vs proxied traffic
req.created_at.gt:"2024-01-01T00:00:00Z"        # date filter
req.path.ncont:"/static"                        # exclude (no NOT keyword)
preset:"My Filter"                              # saved filter preset
```
