Place TLS certificates here when using Docker Compose:

- `fullchain.pem` — certificate + intermediate chain
- `privkey.pem` — private key (chmod 600)

For local testing: `CN=localhost bash deploy/scripts/generate-self-signed-cert.sh`.
For production: obtain certificates from a real CA (e.g. Let's Encrypt) and copy
them here, then `docker compose exec nginx nginx -s reload`.

This directory is gitignored except for this README.
