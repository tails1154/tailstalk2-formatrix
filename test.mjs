import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 18080;
const server = spawn(process.execPath, ["src/server.mjs"], {
  env: { ...process.env, PORT: String(port), DATA_DIR: "/tmp/tailstalk2-formatrix-test" },
  stdio: "ignore",
});
try {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  const versions = await fetch(`http://127.0.0.1:${port}/_matrix/client/versions`).then((r) => r.json());
  assert.ok(versions.versions.includes("r0.6.1"));
  const unauthorized = await fetch(`http://127.0.0.1:${port}/_matrix/client/v3/sync`);
  assert.equal(unauthorized.status, 401);
  console.log("tailstalk2-formatrix smoke tests passed");
} finally {
  server.kill("SIGTERM");
}
