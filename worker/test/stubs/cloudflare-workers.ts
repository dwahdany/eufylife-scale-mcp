// Stand-in for the `cloudflare:workers` runtime module so library code can load under Node in
// unit tests. Only the names the OAuth provider imports at module scope are needed.
export class WorkerEntrypoint {}
