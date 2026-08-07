# NIGHT OPS

Four-wheeler hide & seek after dark, played on real satellite imagery of the farm.

- One seeker with headlights + night vision, hiders running dark, a Kubota spotter that sees but can't tag
- Push-to-talk voice radio (hiders hear the seeker net, never the reverse)
- Server-authoritative rounds — join mid-round and you're in it
- Zero dependencies: raw WebSocket server on Node's http module

## Run locally
    node server.js      # http://localhost:8080

## Deploy
Docker. Listens on `$PORT` (default 8080). Health check at `/health`.
