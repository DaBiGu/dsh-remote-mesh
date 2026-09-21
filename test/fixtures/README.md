# Test fixtures

Everything in this directory exists so the suites can run **without a real
server, a real nginx, or a real certificate authority**.

| File | What it is | Why it is safe to commit |
|---|---|---|
| `fake-nginx.mjs`, `nginx.cmd` | A stand-in for `nginx.exe` that parses braces the way the real thing does, so `deploy-relay.mjs` can be tested end to end (including the "config is rejected, restore the backup" path). Used through the same command-line surface as the real binary. | Plain code, no secrets. |
| `nginx/conf/nginx.conf` | A realistic nginx config: a port-80 redirect, one TLS vhost for the relay's domain, and one unrelated vhost that must never be touched. | Documentation-style domain names only (`example.com`). |
| `localhost-test-cert.pem` | Self-signed certificate for `localhost` / `127.0.0.1`, valid ~10 years, generated once with `openssl req -x509`. | It is a **throwaway** certificate: the private key below it protects one HTTPS listener that the deploy suite starts on a random loopback port for a few seconds. It signs nothing else, it is trusted by nothing, and it grants no access anywhere. |
| `localhost-test-key.pem` | The private key for the certificate above. | Same reasoning. If you would rather not see key material in a repository, you can regenerate the pair locally with the command in the header of `test/deploy-relay.test.mjs`; the suite only cares that the two files exist and match. |

The `tls` suite does **not** use these files: it mints its own certificate at run
time with whatever `openssl` it can find, and reports `SKIP` (exit code 77) when
there is none, so a machine without `openssl` is never silently counted as
passing.
