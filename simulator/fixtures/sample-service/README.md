# sample-service

A small fixture service used by the twing-cli simulator. It has an HTTP
client (`src/net/http-client.ts`) and a job queue worker (`src/queue/worker.ts`),
neither of which retries failures yet.
